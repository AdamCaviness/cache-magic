import type { EngineInterface, ModelForkResult, PromptSubmitInput, Register } from 'claude-code'

import {
  appendLog,
  cacheGoneAt,
  clearsOnColdPrompt,
  coldPromptQuestion,
  decide,
  decideIntercept,
  filesModified,
  handoffPrompt,
  KEEP,
  KEEP_QUESTION,
  keepFromAnswer,
  lastRealRowAt,
  loadMessage,
  MIN_CONTEXT_TOKENS,
  missingSections,
  observeCache,
  offerQuestion,
  parseAutoLoad,
  parseKeep,
  parseMeta,
  quotedInstructions,
  renderHandoff,
  resolveTtl,
  secondsRemaining,
  sectionsFor,
  shouldOffer,
  shouldWriteBeforeCompact,
  snapshotFrom,
  thousands,
  transcriptDigest,
  TRIGGER_WINDOW_SECONDS,
  TTL_SECONDS,
  turnHasEnded,
  withQuotes,
  WRITER_HAIKU,
  WRITER_QUESTION,
  WRITER_SESSION,
  writerFromAnswer,
  type AutoLoad,
  type HandoffMeta,
  type InterceptInput,
  type KeepId,
  type ResolvedTtl,
  type Ttl,
  type TtlSource,
} from './logic'

const DIR = '.claude/cache-magic'
const HANDOFF = `${DIR}/handoff.md`
const META = `${DIR}/handoff.meta.json`
const ERROR_LOG = `${DIR}/handoff-error.log`
const GITIGNORE = `${DIR}/.gitignore`
const PRIOR_SLOTS = [`${DIR}/handoff.1.md`, `${DIR}/handoff.2.md`, `${DIR}/handoff.3.md`]
const DEFAULT_TIMEOUT_SECONDS = 90
const RECHECK_MS = 5_000
const MAX_FS_BYTES = 4 * 1024 * 1024
// Enough for the newest response and the request before it, even past a large tool result.
const TAIL_BYTES = 2 * 1024 * 1024
const ERROR_LOG_LINES = 200
const HAIKU_DIGEST_CHARS = 400_000
const HAIKU_MAX_TOKENS = 8_000
const QUOTE_CHARS = 6_000
const PREFS_ASKED = 'prefsAsked'
const PENDING_KEEP = 'pendingKeep'
const PENDING_WRITER = 'pendingWriter'
const KEEP_KEY = 'cache-magic.keep'
const GENERATOR_KEY = 'cache-magic.generator'
const COMPACT_NOTE = 'Cache Magic kept a handoff at .claude/cache-magic/handoff.md while the cache was still warm.'
const SHORT_KEEP: Record<KeepId, string> = {
  instructions: 'quoted instructions',
  decisions: 'decisions and failed attempts',
  files: 'files and git status',
  next: 'the next step',
}
const YES = 'Yes, clear and load it'
const NO = 'No'
const LOAD_ALWAYS = 'Yes, and load automatically from now on'
const LOAD_ASK = 'Yes, and ask me each time'
const LOAD = 'Yes, clear and send it after the handoff'
const SEND_FULL = 'No, send it with the full context'
const NEVER = 'No, and never intercept again'
const SAVED: Record<string, AutoLoad> = { [LOAD_ALWAYS]: 'auto', [LOAD_ASK]: 'ask', [SEND_FULL]: 'ask', [NEVER]: 'off' }
const AUTO_LOAD_KEY = 'cache-magic.autoLoad'
const AUTO_LOAD_WHERE = '/config, row "Cache Magic: Auto-load"'
const WELCOMED_KEY = 'welcomed'
const WELCOME =
  'When a session over 50k tokens sits idle, Cache Magic writes a handoff to .claude/cache-magic/handoff.md while the prompt cache is still warm. On a five-minute cache it can clear the session and send your next prompt after the handoff. On a one-hour cache it leaves the session, and writes the handoff again before Claude Code compacts. The first large turn asks what to keep. Settings: /config, rows starting "Cache Magic".'

type Timer = { cancel: () => void }
type Idle = {
  stoppedAt: number
  // When the cache's clock last restarted: the newest request, or the Stop when the transcript can't say.
  cacheFrom: number
  sessionId: string
  transcriptPath: string
  ttl: Ttl
  ttlSource: TtlSource
  claimed: boolean
  // When the handoff fork read the cache, which restarts its clock.
  forkReadAt?: number
  timer?: Timer
}

// A resumed session whose cache Claude Code reports cold: its first typed prompt is a late one.
type Resumed = { sessionId: string; lastResponseAt: number; contextTokens: number }

type ColdPrompt = { handoff: string; meta: HandoffMeta; contextTokens: number }

type Generator = 'fork' | 'haiku'
type Choice = { generator: Generator; keep: readonly KeepId[] }
type PrefOptions = { generator?: unknown; keep?: unknown }
type Plan = { override: unknown; timeoutMs: number; options: PrefOptions }

let idle: Idle | undefined
let resumed: Resumed | undefined
let activeTurn = false
let generating = false
let askingPrefs = false

const at = (root: string, path: string) => `${root}/${path}`

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// Everything the mod writes stays in its own folder, which ignores itself in git.
async function writeOwn($: EngineInterface, root: string, path: string, text: string) {
  if ((await readText($, at(root, GITIGNORE))) === undefined) await $.fs.write(at(root, GITIGNORE), '*\n')
  await $.fs.write(at(root, path), text)
}

async function logError($: EngineInterface, message: string) {
  try {
    const root = await $.session.root()
    const line = `${new Date(await $.clock.now()).toISOString()} ${message}`
    const existing = (await readText($, at(root, ERROR_LOG))) ?? ''
    await writeOwn($, root, ERROR_LOG, appendLog(existing, line, ERROR_LOG_LINES))
    $.ui.log(message, { to: 'debug' })
  } catch {
    // The error log is the last resort; nothing is left to report to.
  }
}

// The transcript's newest rows, however large it has grown.
async function transcriptTail($: EngineInterface, path: string): Promise<string | undefined> {
  if (!path) return undefined
  try {
    const result = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3_000 })
    if (result.exitCode === 0) return result.stdout
  } catch {
    // Where tail can't run, a transcript within the read limit is read whole.
  }
  const stat = await $.fs.stat(path).catch(() => undefined)
  return stat && stat.size <= MAX_FS_BYTES ? readText($, path) : undefined
}

async function sessionTtl($: EngineInterface, override: unknown, observed: Ttl | undefined): Promise<ResolvedTtl> {
  const settings = (await $.settings.read().catch(() => ({}))) as { promptCacheTtl?: unknown }
  return resolveTtl({
    observed,
    override,
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    env: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    setting: settings.promptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  })
}

async function turnEnded($: EngineInterface, current: Idle): Promise<boolean> {
  let mtimeMs: number | undefined
  let lastRow: number | undefined
  if (current.transcriptPath) {
    const stat = await $.fs.stat(current.transcriptPath).catch(() => undefined)
    mtimeMs = stat?.mtimeMs
    // Only a transcript past the stop needs its rows read; one that can't be read leaves the turn flag to decide.
    if (stat && mtimeMs !== undefined && mtimeMs > current.stoppedAt) {
      const text = await transcriptTail($, current.transcriptPath)
      if (text !== undefined) lastRow = lastRealRowAt(text)
    }
  }
  return turnHasEnded({ stoppedAt: current.stoppedAt, activeTurn, transcriptMtimeMs: mtimeMs, lastRealRowAt: lastRow })
}

async function workingTree($: EngineInterface): Promise<string | undefined> {
  try {
    const result = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 3_000 })
    return result.exitCode === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

const TIMED_OUT = Symbol('timed out')

function withTimeout<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: Timer | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = $.clock.after(ms, () => resolve(TIMED_OUT))
  })
  return Promise.race([work, timeout]).finally(() => timer?.cancel())
}

async function requestHandoff(
  $: EngineInterface,
  generator: Generator,
  timeoutMs: number,
  keep: readonly KeepId[],
): Promise<ModelForkResult | typeof TIMED_OUT> {
  const prompt = handoffPrompt(keep.includes('files') ? await workingTree($) : undefined, keep)
  if (generator === 'fork') return withTimeout($, $.model.fork({ prompt }), timeoutMs)
  const messages = await $.session.messages()
  return $.model.complete({
    model: 'haiku',
    effort: 'high',
    maxTokens: HAIKU_MAX_TOKENS,
    timeoutMs,
    system: 'You write handoff documents from a coding session transcript.',
    prompt: [
      { text: `<transcript>\n${transcriptDigest(messages, HAIKU_DIGEST_CHARS)}\n</transcript>` },
      { text: prompt },
    ],
  })
}

// Shifts handoff.md into the prior slots, newest first, dropping the oldest.
async function rotate($: EngineInterface, root: string) {
  const current = await readText($, at(root, HANDOFF))
  if (current === undefined) return
  const prior = await Promise.all(PRIOR_SLOTS.map(slot => readText($, at(root, slot))))
  const shifted = [current, ...prior].slice(0, PRIOR_SLOTS.length)
  for (let index = shifted.length - 1; index >= 0; index--) {
    const text = shifted[index]
    if (text !== undefined) await writeOwn($, root, PRIOR_SLOTS[index]!, text)
  }
}

async function generate($: EngineInterface, current: Idle, contextSize: number, timeoutMs: number, choice: { generator: Generator; keep: readonly KeepId[] }): Promise<boolean> {
  const { generator, keep } = choice
  if (generator === 'fork') current.forkReadAt = await $.clock.now()
  const messages = await $.session.messages()
  const quotes = keep.includes('instructions') ? quotedInstructions(messages, QUOTE_CHARS) : ''
  const result = await requestHandoff($, generator, timeoutMs, keep)
  if (result === TIMED_OUT) {
    await logError($, `${generator} timed out after ${timeoutMs / 1000}s; no handoff written`)
    return false
  }
  if (!result.isAnswered) {
    const detail = result.reason === 'api-error' ? ` (${result.error}, status ${result.status})` : ''
    await logError($, `${generator} returned no handoff: ${result.reason}${detail}`)
    return false
  }
  const root = await $.session.root()
  const meta: HandoffMeta = {
    timestamp: new Date(await $.clock.now()).toISOString(),
    sessionId: current.sessionId,
    cacheTtl: current.ttl,
    contextSize,
    filesModified: filesModified(messages).length,
    turns: await $.session.turns(),
  }
  await rotate($, root)
  await writeOwn($, root, HANDOFF, renderHandoff(withQuotes(result.text, quotes), meta))
  await writeOwn($, root, META, `${JSON.stringify(meta, null, 2)}\n`)
  const missing = missingSections(result.text, sectionsFor(keep))
  if (missing.length) await logError($, `handoff written without sections: ${missing.join(', ')}`)
  const cached = generator === 'fork' ? `, ${result.usage.cache_read_input_tokens} tokens read from cache` : ''
  $.ui.log(`Kept ${HANDOFF} while the cache was still warm${cached}`)
  return true
}

async function evaluate($: EngineInterface, current: Idle, timeoutMs: number, choiceFor: () => Promise<{ generator: Generator; keep: readonly KeepId[] }>) {
  if (idle !== current || generating) return
  const nowMs = await $.clock.now()
  const contextSize = (await $.session.usage()).context.tokens ?? 0
  const cache = snapshotFrom(current.cacheFrom, current.ttl, contextSize, nowMs)
  const root = await $.session.root()
  const meta = parseMeta((await readText($, at(root, META))) ?? '')
  const turns = await $.session.turns()
  const decision = decide({
    cache,
    nowMs,
    turnEnded: await turnEnded($, current),
    draftPending: (await $.prompt.read()).text.trim() !== '',
    claimed: current.claimed,
    existing: meta && {
      ageMs: nowMs - Date.parse(meta.timestamp),
      sameSession: meta.sessionId === current.sessionId,
      turnsSince: turns - meta.turns,
    },
  })
  if (!decision.act) {
    $.ui.log(`Skipped, ${decision.reason}`, { to: 'debug' })
    // A draft may be cleared or sent before the cache lapses; look again until it does.
    if (decision.reason === 'user-typing' && secondsRemaining(cache, nowMs) * 1000 > RECHECK_MS) {
      current.timer = $.clock.after(RECHECK_MS, () => void evaluate($, current, timeoutMs, choiceFor))
    }
    return
  }
  current.claimed = true
  generating = true
  try {
    await generate($, current, contextSize, timeoutMs, await choiceFor())
  } catch (error) {
    await logError($, `handoff failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    generating = false
  }
}

async function turnEndedAt($: EngineInterface, e: { session_id: string; transcript_path: string }, plan: Plan) {
  activeTurn = false
  try {
    idle?.timer?.cancel()
    const stoppedAt = await $.clock.now()
    const tail = await transcriptTail($, e.transcript_path)
    const observed = tail === undefined ? {} : observeCache(tail)
    const { ttl, source } = await sessionTtl($, plan.override, observed.ttl)
    const cacheFrom = observed.requestAt !== undefined && observed.requestAt <= stoppedAt ? observed.requestAt : stoppedAt
    const current: Idle = {
      stoppedAt,
      cacheFrom,
      sessionId: e.session_id,
      transcriptPath: e.transcript_path,
      ttl,
      ttlSource: source,
      claimed: false,
    }
    idle = current
    $.ui.log(`Cache TTL ${ttl} (${source}), from ${new Date(cacheFrom).toISOString()}`, { to: 'debug' })
    const elapsed = (await $.clock.now()) - cacheFrom
    const delay = Math.max(0, (TTL_SECONDS[ttl] - TRIGGER_WINDOW_SECONDS) * 1000 - elapsed)
    current.timer = $.clock.after(delay, () => void evaluate($, current, plan.timeoutMs, () => readChoice($, plan.options)))
    void maybeAskPrefs($, plan.options)
  } catch (error) {
    await logError($, `scheduling failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function offer($: EngineInterface, e: { session_id: string }) {
  const root = await $.session.root()
  const meta = parseMeta((await readText($, at(root, META))) ?? '')
  const offeredKey = `offered:${root}`
  const input = {
    meta,
    nowMs: await $.clock.now(),
    sessionId: e.session_id,
    offeredTimestamp: await $.store.get(offeredKey),
  }
  if (!shouldOffer(input)) return
  const handoff = await readText($, at(root, HANDOFF))
  if (handoff === undefined) return
  await $.store.set(offeredKey, input.meta.timestamp)
  const answer = await $.ui.ask(offerQuestion(input.meta), { header: 'Handoff', options: [YES, NO] })
  if (answer !== YES) return
  // A fresh session has nothing to clear.
  await $.prompt.submit({ text: loadMessage(handoff) })
}

async function welcome($: EngineInterface) {
  if (await $.store.get(WELCOMED_KEY)) return
  await $.store.set(WELCOMED_KEY, true)
  $.ui.log(WELCOME)
}

async function cacheSettings($: EngineInterface) {
  return (await $.settings.read().catch(() => ({}))) as { idleCompaction?: unknown; autoCompactEnabled?: unknown }
}

// The handoff to load in place of a prompt that would re-send a cold cache, or undefined to let it go.
async function coldPrompt($: EngineInterface, e: PromptSubmitInput, mode: AutoLoad): Promise<ColdPrompt | undefined> {
  const nowMs = await $.clock.now()
  let cache: InterceptInput['cache'] = 'unknown'
  let sessionId: string | undefined
  // The handoff must be newer than the session's last activity.
  let quietSince = Infinity
  let contextTokens = 0
  let replace = true
  if (idle) {
    sessionId = idle.sessionId
    quietSince = idle.stoppedAt
    if (idle.ttlSource !== 'assumed') {
      cache = nowMs >= cacheGoneAt(idle.stoppedAt, idle.forkReadAt, idle.ttl) ? 'cold' : 'warm'
      replace = clearsOnColdPrompt(idle.ttl, await cacheSettings($))
    }
  } else if (resumed) {
    sessionId = resumed.sessionId
    quietSince = resumed.lastResponseAt
    cache = 'cold'
    contextTokens = resumed.contextTokens
  }
  const prompt = { origin: e.origin.kind, text: e.text, hasAttachments: (e.attachments ?? []).length > 0, duringTurn: activeTurn || e.turnId !== undefined }
  // Files are read only for a prompt that would otherwise go cold. `replace` is applied once the handoff's own TTL is known.
  let decision = decideIntercept({ mode, prompt, cache, contextTokens: Infinity, handoffCurrent: true, replace: true })
  let meta: HandoffMeta | undefined
  let root = ''
  if (decision.intercept) {
    if (idle) contextTokens = (await $.session.usage()).context.tokens ?? 0
    root = await $.session.root()
    meta = parseMeta((await readText($, at(root, META))) ?? '')
    if (resumed) replace = clearsOnColdPrompt(meta?.cacheTtl ?? 'unknown', await cacheSettings($))
    const handoffCurrent = !!meta && meta.sessionId === sessionId && Date.parse(meta.timestamp) >= quietSince
    decision = decideIntercept({ mode, prompt, cache, contextTokens, handoffCurrent, replace })
  }
  if (!decision.intercept) {
    if (decision.reason !== 'not-typed') $.ui.log(`Prompt sent as typed, ${decision.reason}`, { to: 'debug' })
    return undefined
  }
  const handoff = await readText($, at(root, HANDOFF))
  return handoff === undefined || !meta ? undefined : { handoff, meta, contextTokens }
}

// Runs after the prompt was dropped and its hook returned.
async function loadInstead($: EngineInterface, e: PromptSubmitInput, cold: ColdPrompt, mode: AutoLoad) {
  idle?.timer?.cancel()
  idle = undefined
  resumed = undefined
  let load = mode === 'auto'
  let save: AutoLoad | undefined
  if (!load) {
    const options = mode === 'ask-once' ? [LOAD_ALWAYS, LOAD_ASK, SEND_FULL, NEVER] : [LOAD, SEND_FULL]
    const answer = await $.ui.ask(coldPromptQuestion(cold.contextTokens, cold.meta.timestamp), { header: 'Cache Magic', options }).catch(() => undefined)
    if (answer === undefined || !options.includes(answer)) {
      // Dismissed, or answered under "Other": the prompt goes back in the box as typed.
      await $.prompt.fill({ text: e.text })
      return
    }
    load = answer === LOAD_ALWAYS || answer === LOAD_ASK || answer === LOAD
    if (mode === 'ask-once') save = SAVED[answer]
  }
  if (load) {
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text: loadMessage(cold.handoff, e.text) })
    $.ui.log(
      `The prompt cache had expired, so the session was cleared and your prompt sent after the handoff instead of re-sending ${thousands(cold.contextTokens)} tokens. /resume restores the full session. Auto-load is in ${AUTO_LOAD_WHERE}.`,
    )
  } else {
    await $.prompt.submit({ text: e.text, asUser: true })
  }
  if (save) {
    $.ui.toast(`Auto-load saved as "${save}". Change it in ${AUTO_LOAD_WHERE}.`, { timeoutMs: 10_000 })
    // Saving reloads the module, so it comes last.
    const saved = await $.config.set({ key: AUTO_LOAD_KEY, value: save })
    if ('deny' in saved && saved.deny) await logError($, `could not save Auto-load as ${save}: ${saved.deny}`)
  }
}

function keptList(keep: readonly KeepId[]): string {
  const names = KEEP.filter(part => keep.includes(part.id)).map(part => SHORT_KEEP[part.id])
  if (names.length <= 1) return names[0] ?? 'the handoff'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// Asks once, on the first large turn, while the person is still at the keyboard.
// The answer is kept in the store so the idle timer is not cancelled by a /config reload.
async function maybeAskPrefs($: EngineInterface, options: PrefOptions) {
  if (askingPrefs) return
  askingPrefs = true
  try {
    if (await $.store.get(PREFS_ASKED)) return
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (tokens < MIN_CONTEXT_TOKENS) return
    if ((await $.prompt.read()).text.trim() !== '') return
    await $.store.set(PREFS_ASKED, true)
    const keepAnswer = await $.ui.ask(KEEP_QUESTION, { header: 'Cache Magic', multiSelect: true, options: KEEP.map(part => part.label) }).catch(() => undefined)
    const keep = keepAnswer === undefined ? undefined : keepFromAnswer(keepAnswer)
    if (!keep) return
    const writerAnswer = await $.ui.ask(WRITER_QUESTION, { header: 'Cache Magic', options: [WRITER_SESSION, WRITER_HAIKU] }).catch(() => undefined)
    const picked = writerAnswer === undefined ? undefined : writerFromAnswer(writerAnswer)
    await $.store.set(PENDING_KEEP, keep.join(','))
    if (picked) await $.store.set(PENDING_WRITER, picked)
    const writer = picked ?? (options.generator === 'haiku' ? 'haiku' : 'session')
    const who = writer === 'haiku' ? 'Haiku' : "this session's model"
    $.ui.toast(`The handoff will keep ${keptList(keep)}, written by ${who}.`, { timeoutMs: 10_000 })
  } catch (error) {
    await logError($, `could not ask what to keep: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    askingPrefs = false
  }
}

async function readChoice($: EngineInterface, options: PrefOptions): Promise<Choice> {
  const pendingWriter = await $.store.get(PENDING_WRITER)
  const pendingKeep = await $.store.get(PENDING_KEEP)
  const generator: Generator = pendingWriter === 'haiku' ? 'haiku' : pendingWriter === 'session' ? 'fork' : options.generator === 'haiku' ? 'haiku' : 'fork'
  return { generator, keep: parseKeep(typeof pendingKeep === 'string' ? pendingKeep : options.keep) }
}

// One row per session start. A reload follows the first write, so the other row waits for the next start.
async function flushPrefs($: EngineInterface, options: PrefOptions) {
  const keep = await $.store.get(PENDING_KEEP)
  const writer = await $.store.get(PENDING_WRITER)
  const keepText = typeof keep === 'string' ? keep : undefined
  const writerText = writer === 'haiku' || writer === 'session' ? writer : undefined
  const haveKeep = typeof options.keep === 'string' && options.keep ? options.keep : 'instructions,decisions,files,next'
  const haveWriter = options.generator === 'haiku' ? 'haiku' : 'session'
  if (keepText && keepText !== haveKeep) {
    await $.config.set({ key: KEEP_KEY, value: keepText })
    return
  }
  if (keepText) await $.store.delete(PENDING_KEEP)
  if (writerText && writerText !== haveWriter) {
    await $.config.set({ key: GENERATOR_KEY, value: writerText })
    return
  }
  if (writerText) await $.store.delete(PENDING_WRITER)
}

export const register: Register = (on, options) => {
  // A change in /config reloads the module, so options are read once here.
  if (options.enabled !== true) return
  const seconds = typeof options.timeoutSeconds === 'number' && options.timeoutSeconds > 0 ? options.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS
  const timeoutMs = Math.round(seconds * 1000)
  const autoLoad = parseAutoLoad(options.autoLoad)
  // Bookkeeping only: the turn flag and timer are set here, and every model call waits for the turn to end.
  on('turn.start', async ($, e, next) => {
    activeTurn = true
    idle?.timer?.cancel()
    idle = undefined
    resumed = undefined
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const cold = await coldPrompt($, e, autoLoad)
    if (!cold) return next(e)
    // `/clear` refuses to run while this hook holds the prompt, so the work starts once it has returned.
    $.clock.after(0, () => {
      void loadInstead($, e, cold, autoLoad).catch(error => logError($, `auto-load failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    const then = autoLoad === 'auto' ? 'Loading the handoff instead.' : 'Choose how to send this prompt.'
    return { drop: `Cache Magic: the prompt cache has expired. ${then}` }
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  const plan: Plan = { override: options.cacheTtlOverride, timeoutMs, options }

  on('session.start', async ($, e, next) => {
    await flushPrefs($, options).catch(error => logError($, `could not save the handoff choice: ${error instanceof Error ? error.message : String(error)}`))
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('config.set', async ($, e, next) => {
    // A change in the menu wins over a choice that has not been recorded yet.
    if (e.origin?.kind !== 'plugin') {
      if (e.key === KEEP_KEY) await $.store.delete(PENDING_KEEP)
      if (e.key === GENERATOR_KEY) await $.store.delete(PENDING_WRITER)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId) return next(e)
    if (generating) return next(e)
    generating = true
    try {
      const tokens = (await $.session.usage()).context.tokens ?? 0
      const root = await $.session.root()
      const nowMs = await $.clock.now()
      const meta = parseMeta((await readText($, at(root, META))) ?? '')
      const sessionId = idle?.sessionId ?? await $.session.id()
      const turns = await $.session.turns()
      const existing = meta && {
        ageMs: nowMs - Date.parse(meta.timestamp),
        sameSession: meta.sessionId === sessionId,
        turnsSince: turns - meta.turns,
      }
      if (!shouldWriteBeforeCompact({ trigger: e.trigger, contextTokens: tokens, existing: existing || undefined })) return next(e)
      const ttl = idle?.ttl ?? (await sessionTtl($, plan.override, undefined)).ttl
      const current: Idle = idle ?? {
        stoppedAt: nowMs,
        cacheFrom: nowMs,
        sessionId,
        transcriptPath: '',
        ttl,
        ttlSource: 'assumed',
        claimed: false,
      }
      const wrote = await generate($, current, tokens, plan.timeoutMs, await readChoice($, plan.options))
      if (!wrote) return next(e)
      const instructions = e.instructions ? `${e.instructions}\n\n${COMPACT_NOTE}` : COMPACT_NOTE
      return next({ ...e, instructions })
    } catch (error) {
      await logError($, `handoff before compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      return next(e)
    } finally {
      generating = false
    }
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('classic.Stop', async ($, e, next) => {
    // Background work will wake the session, and its requests keep the cache warm.
    if ((e.background_tasks ?? []).length > 0) activeTurn = false
    else void turnEndedAt($, e, plan)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('classic.TeammateIdle', async ($, e, next) => {
    void turnEndedAt($, e, plan)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('classic.SessionStart', { source: ['startup', 'resume'] }, async ($, e, next) => {
    if (e.source === 'startup') {
      void welcome($).catch(error => logError($, `welcome failed: ${error instanceof Error ? error.message : String(error)}`))
      void offer($, e).catch(error => logError($, `offer failed: ${error instanceof Error ? error.message : String(error)}`))
    } else {
      idle?.timer?.cancel()
      idle = undefined
      resumed = undefined
      if (e.prompt_cache_likely_expired === true) {
        const lastResponseAt = (await $.clock.now()) - (e.seconds_since_last_response ?? 0) * 1000
        resumed = { sessionId: e.session_id, lastResponseAt, contextTokens: e.context_tokens ?? 0 }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('session.end', async ($, e, next) => {
    idle?.timer?.cancel()
    idle = undefined
    return next(e)
  })
}
