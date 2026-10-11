import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import {
  clearsOnColdPrompt,
  decide,
  decideIntercept,
  filesModified,
  handoffPrompt,
  keepFromAnswer,
  KEEP_QUESTION,
  lastRealRowAt,
  missingSections,
  observeCache,
  offerQuestion,
  parseAutoLoad,
  parseKeep,
  parseMeta,
  quotedInstructions,
  resolveTtl,
  SECTIONS,
  shouldOffer,
  shouldWriteBeforeCompact,
  snapshotFrom,
  turnHasEnded,
  withQuotes,
  WRITER_HAIKU,
  WRITER_QUESTION,
  writerFromAnswer,
  type CacheSnapshot,
  type HandoffMeta,
  type PromptFacts,
} from '../hooks/logic'

const ROOT = '/work/project'
const T0 = Date.parse('2026-10-10T20:00:00.000Z')
const ENABLED = { options: { enabled: true } }

const HANDOFF_BODY = ['# Handoff', ...SECTIONS.map(section => `## ${section}\nNone`)].join('\n\n')

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Fix the flaky login test', toolUses: [] },
  {
    role: 'assistant',
    text: 'Editing the test.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Edit', input: { file_path: `${ROOT}/src/login.test.ts` }, text: 'ok' },
      { tool_use_id: 't2', tool: 'Write', input: { file_path: `${ROOT}/src/clock.ts` }, text: 'ok' },
      { tool_use_id: 't3', tool: 'Edit', input: { file_path: `${ROOT}/src/login.test.ts` }, text: 'ok' },
      { tool_use_id: 't4', tool: 'Bash', input: { command: 'npm test' }, text: '1 failed' },
    ],
  },
]

// The statusLine's prompt_cache object for a warm cache with `remaining` seconds left.
const cacheWith = (remaining: number, tokens: number): CacheSnapshot => ({
  warm: remaining > 0,
  ttl: '5m',
  expires_at: Math.floor(T0 / 1000) + remaining,
  recache_tokens_if_cold: tokens,
})

const IDLE = { nowMs: T0, turnEnded: true, draftPending: false, claimed: false }

type World = {
  files: Map<string, string>
  forks: string[]
  completions: number
  submitted: string[]
  submittedAsUser: string[]
  commands: string[]
  asked: string[]
  filled: string[]
  saved: { key: string; value: unknown }[]
  logs: string[]
  compactNotes: string[]
  completionPrompts: string[]
}

// Answers every call the mod makes beneath it, from memory.
type Setup = {
  files?: Record<string, string>
  tokens?: number
  draft?: string
  answer?: string
  answerFor?: (question: string) => string
  askPrefs?: boolean
  settings?: Record<string, unknown>
  fork?: 'answer' | 'hang'
  transcriptMtimeMs?: number
}

function world(on: On, setup: Setup = {}): World {
  const state: World = {
    files: new Map(Object.entries(setup.files ?? {})),
    forks: [],
    completions: 0,
    submitted: [],
    submittedAsUser: [],
    commands: [],
    asked: [],
    filled: [],
    saved: [],
    logs: [],
    compactNotes: [],
    completionPrompts: [],
  }
  mock.store(on, setup.askPrefs ? {} : { prefsAsked: true })
  mock.env(on, {})
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('session.start', () => ({ cwd: ROOT }))
  on('session.compact', ($, e) => {
    state.compactNotes.push(e.instructions ?? '')
    return { messages: e.messages }
  })
  on('settings.read', () => ({ value: setup.settings ?? {} }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.turns', () => ({ value: 7 }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({
    value: { startedAt: T0 - 3_600_000, context: { tokens: setup.tokens ?? 900_000, window: 1_000_000, percent: 90 }, rateLimits: [] },
  }))
  on('prompt.read', () => ({ value: { text: setup.draft ?? '', cursor: 0 } }))
  on('process.run', ($, e) => {
    const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'tail') {
      const text = state.files.get(e.argv[e.argv.length - 1]!)
      return text === undefined ? ran(1, '') : ran(0, text)
    }
    return ran(0, '## main\n M src/login.test.ts\n')
  })
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') state.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', ($, e) => {
    const text = state.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: text.length, mtimeMs: setup.transcriptMtimeMs ?? 0, isLink: false } }
  })
  on('fs.write', ($, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.fork', async ($, e) => {
    state.forks.push(e.prompt)
    if (setup.fork === 'hang') await new Promise(() => {})
    return { value: { isAnswered: true, text: HANDOFF_BODY, usage: { input_tokens: 40, output_tokens: 900, cache_read_input_tokens: 899_000, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', ($, e) => {
    state.completions++
    state.completionPrompts.push(typeof e.prompt === 'string' ? e.prompt : JSON.stringify(e.prompt))
    return { value: { isAnswered: true, text: HANDOFF_BODY, usage: { input_tokens: 100_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    state.asked.push(JSON.stringify(e))
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    const answer = setup.answerFor?.(question) ?? setup.answer ?? 'No'
    return { result: { answers: { [question]: answer } }, text: answer }
  })
  on('command.run', ($, e) => {
    state.commands.push(e.command)
    return {}
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind !== 'composer') state.submitted.push(e.text)
    if ((e as { asUser?: true }).asUser || (e.origin as { asUser?: boolean }).asUser) state.submittedAsUser.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    state.filled.push(e.text)
    return { isFilled: true }
  })
  on('config.set', ($, e) => {
    state.saved.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('ui.toast', () => ({ value: undefined }))
  return state
}

// A prompt the user typed and sent with Enter.
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const stop = { stop_hook_active: false, last_assistant_message: 'Done.', transcript_path: '', session_id: 'session-a' } as const

const TRANSCRIPT = '/home/me/.claude/projects/p/session-a.jsonl'
const iso = (ms: number) => new Date(ms).toISOString()
const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n')
const written = (fiveMinute: number, oneHour: number) => ({
  usage: { cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour } },
})

// A turn whose last request went out at `requestAt` and wrote to the cache at the given TTLs.
const turn = (requestAt: number, fiveMinute: number, oneHour: number) =>
  jsonl([
    { type: 'user', timestamp: iso(requestAt) },
    { type: 'assistant', timestamp: iso(T0 - 500), message: written(fiveMinute, oneHour) },
  ])

const meta = (overrides: Partial<HandoffMeta> = {}): HandoffMeta => ({
  timestamp: new Date(T0 - 10 * 60_000).toISOString(),
  sessionId: 'session-a',
  cacheTtl: '5m',
  contextSize: 900_000,
  filesModified: 2,
  turns: 7,
  ...overrides,
})

describe('trigger logic', () => {
  test('acts with 10 seconds left on a 900k context once the turn has ended', () => {
    expect(decide({ ...IDLE, cache: cacheWith(10, 900_000) })).toEqual({ act: true })
  })

  test('waits while more than 30 seconds remain, and gives up once the cache is cold', () => {
    expect(decide({ ...IDLE, cache: cacheWith(31, 900_000) })).toEqual({ act: false, reason: 'not-yet' })
    expect(decide({ ...IDLE, cache: cacheWith(0, 900_000) })).toEqual({ act: false, reason: 'cache-cold' })
  })

  test('uses the same 30-second window before a 1h expiry', () => {
    const lastResponse = T0 - (3600 - 20) * 1000
    expect(decide({ ...IDLE, cache: snapshotFrom(lastResponse, '1h', 900_000, T0) })).toEqual({ act: true })
    expect(decide({ ...IDLE, cache: snapshotFrom(lastResponse, '5m', 900_000, T0) })).toEqual({ act: false, reason: 'cache-cold' })
  })

  test('resolves the TTL: observed, override, FORCE_PROMPT_CACHING_5M, env, setting, ENABLE_PROMPT_CACHING_1H, then 5m', () => {
    expect(resolveTtl({ observed: '1h', override: '5m', force5m: '1' })).toEqual({ ttl: '1h', source: 'observed' })
    expect(resolveTtl({ override: '1h', force5m: '1' })).toEqual({ ttl: '1h', source: 'configured' })
    expect(resolveTtl({ override: '', force5m: '1', env: '1h' })).toEqual({ ttl: '5m', source: 'configured' })
    expect(resolveTtl({ env: '1h', setting: '5m' })).toEqual({ ttl: '1h', source: 'configured' })
    expect(resolveTtl({ env: 'bogus', setting: '1h' })).toEqual({ ttl: '1h', source: 'configured' })
    expect(resolveTtl({ enable1h: '1' })).toEqual({ ttl: '1h', source: 'configured' })
    expect(resolveTtl({})).toEqual({ ttl: '5m', source: 'assumed' })
  })

  test('reads the TTL and the last request time off the main conversation in the transcript', () => {
    const rows = [
      { type: 'user', timestamp: iso(T0 - 120_000) },
      { type: 'assistant', timestamp: iso(T0 - 100_000), message: written(0, 500) },
      { type: 'user', timestamp: iso(T0 - 60_000) },
      { type: 'assistant', timestamp: iso(T0 - 5_000), message: written(0, 800) },
      { type: 'assistant', isSidechain: true, timestamp: iso(T0 - 2_000), message: written(900, 0) },
      { type: 'user', isMeta: true, timestamp: iso(T0 - 1_000) },
      { type: 'system', subtype: 'turn_duration', timestamp: iso(T0 + 1_000) },
    ]
    expect(observeCache(jsonl(rows))).toEqual({ ttl: '1h', requestAt: T0 - 60_000 })
    expect(observeCache(turn(T0 - 1_000, 300, 0))).toEqual({ ttl: '5m', requestAt: T0 - 1_000 })
    expect(observeCache(turn(T0 - 1_000, 300, 40_000)).ttl).toBe('5m')
    // A response served wholly from cache wrote nothing; an earlier write still names the TTL.
    const cached = [...rows.slice(0, 3), { type: 'assistant', timestamp: iso(T0 - 5_000), message: written(0, 0) }]
    expect(observeCache(jsonl(cached))).toEqual({ ttl: '1h', requestAt: T0 - 60_000 })
    expect(observeCache(jsonl([{ type: 'user', timestamp: iso(T0) }]))).toEqual({ ttl: undefined, requestAt: undefined })
    expect(observeCache('{"type":"assistant","times')).toEqual({ ttl: undefined, requestAt: undefined })
  })
})

describe('skip logic', () => {
  test('skips a context under 50k tokens', () => {
    expect(decide({ ...IDLE, cache: cacheWith(10, 49_999) })).toEqual({ act: false, reason: 'context-small' })
  })

  test('skips while a turn is running or a draft is in the prompt box', () => {
    expect(decide({ ...IDLE, turnEnded: false, cache: cacheWith(10, 900_000) })).toEqual({ act: false, reason: 'turn-active' })
    expect(decide({ ...IDLE, draftPending: true, cache: cacheWith(10, 900_000) })).toEqual({ act: false, reason: 'user-typing' })
  })

  test('skips a fresh handoff with nothing new since, and rewrites one that has fallen behind', () => {
    const cache = cacheWith(10, 900_000)
    expect(decide({ ...IDLE, cache, existing: { ageMs: 20 * 60_000, sameSession: true, turnsSince: 0 } })).toEqual({ act: false, reason: 'handoff-fresh' })
    expect(decide({ ...IDLE, cache, existing: { ageMs: 20 * 60_000, sameSession: true, turnsSince: 3 } })).toEqual({ act: true })
    expect(decide({ ...IDLE, cache, existing: { ageMs: 2 * 3_600_000, sameSession: true, turnsSince: 0 } })).toEqual({ act: true })
  })

  test('acts only once per idle period', () => {
    expect(decide({ ...IDLE, claimed: true, cache: cacheWith(10, 900_000) })).toEqual({ act: false, reason: 'already-handled' })
  })

  test('reads the last real row, not bookkeeping written after Stop', () => {
    const stoppedAt = T0
    const rows = [
      { type: 'user', timestamp: new Date(T0 - 60_000).toISOString() },
      { type: 'assistant', timestamp: new Date(T0 - 1_000).toISOString() },
      { type: 'system', subtype: 'turn_duration', timestamp: new Date(T0 + 30_000).toISOString() },
      { type: 'user', isMeta: true, timestamp: new Date(T0 + 40_000).toISOString() },
    ]
    const tail = rows.map(row => JSON.stringify(row)).join('\n')
    expect(lastRealRowAt(tail)).toBe(T0 - 1_000)
    expect(turnHasEnded({ stoppedAt, activeTurn: false, transcriptMtimeMs: T0 + 40_000, lastRealRowAt: lastRealRowAt(tail) })).toBe(true)
    const resumed = `${tail}\n${JSON.stringify({ type: 'user', timestamp: new Date(T0 + 50_000).toISOString() })}`
    expect(turnHasEnded({ stoppedAt, activeTurn: false, transcriptMtimeMs: T0 + 50_000, lastRealRowAt: lastRealRowAt(resumed) })).toBe(false)
    expect(turnHasEnded({ stoppedAt, activeTurn: true })).toBe(false)
  })
})

describe('handoff generation', () => {
  test('forks the warm session 30 seconds before a 5m expiry and writes the handoff and meta', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(269_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(1_000)
    expect(state.forks).toHaveLength(1)
    expect(state.forks[0]).toContain('## Failed attempts')
    expect(state.forks[0]).toContain('M src/login.test.ts')
    const handoff = state.files.get(`${ROOT}/.claude/cache-magic/handoff.md`)
    expect(handoff).toContain('# Handoff')
    expect(handoff).toContain('session session-a')
    expect(state.files.get(`${ROOT}/.claude/cache-magic/.gitignore`)).toBe('*\n')
    const written = parseMeta(state.files.get(`${ROOT}/.claude/cache-magic/handoff.meta.json`)!)
    expect(written).toEqual({ timestamp: new Date(T0 + 270_000).toISOString(), sessionId: 'session-a', cacheTtl: '5m', contextSize: 900_000, filesModified: 2, turns: 7 })
  })

  test('honors the 1h override', { options: { enabled: true, cacheTtlOverride: '1h' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(3_569_000 - 300_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(1_000)
    expect(state.forks).toHaveLength(1)
  })

  test('a 1h TTL read off the transcript holds the handoff for the hour, with no override set', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: { [TRANSCRIPT]: turn(T0 - 1_000, 0, 800) } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(3_568_000 - 300_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(1_000)
    expect(state.forks).toHaveLength(1)
    expect(parseMeta(state.files.get(`${ROOT}/.claude/cache-magic/handoff.meta.json`)!)?.cacheTtl).toBe('1h')
  })

  test('the observed TTL wins over the override', { options: { enabled: true, cacheTtlOverride: '1h' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: { [TRANSCRIPT]: turn(T0 - 1_000, 300, 0) } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(269_000)
    expect(state.forks).toHaveLength(1)
  })

  test('counts the cache from the last request, not the Stop, so a long response does not make it late', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: { [TRANSCRIPT]: turn(T0 - 60_000, 300, 0) } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(209_000)
    expect(state.forks).toHaveLength(0)
    await clock.advance(1_000)
    expect(state.forks).toHaveLength(1)
  })

  test('keeps the prior three handoffs in rotation slots', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, {
      files: {
        [`${ROOT}/.claude/cache-magic/handoff.md`]: 'current',
        [`${ROOT}/.claude/cache-magic/handoff.1.md`]: 'one',
        [`${ROOT}/.claude/cache-magic/handoff.2.md`]: 'two',
        [`${ROOT}/.claude/cache-magic/handoff.3.md`]: 'three',
      },
    })
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff.1.md`)).toBe('current')
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff.2.md`)).toBe('one')
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff.3.md`)).toBe('two')
  })

  test('the haiku generator sends a transcript digest to Haiku instead of forking', { options: { enabled: true, generator: 'haiku' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    expect(state.forks).toHaveLength(0)
    expect(state.completions).toBe(1)
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff.md`)).toContain('# Handoff')
  })

  test('a fork that outlasts the timeout logs to handoff-error.log and writes nothing', { options: { enabled: true, timeoutSeconds: 10 } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { fork: 'hang' })
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    await clock.advance(10_000)
    expect(state.files.has(`${ROOT}/.claude/cache-magic/handoff.md`)).toBe(false)
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff-error.log`)).toContain('fork timed out after 10s')
  })

  test('skips a context under 50k tokens', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { tokens: 20_000 })
    await $.classic.Stop(stop)
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
  })

  test('a draft left in the prompt box holds the handoff until the cache lapses', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { draft: 'half a thought' })
    await $.classic.Stop(stop)
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
  })

  test('a user row written after Stop means the turn did not end, so nothing forks', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const rows = [
      { type: 'assistant', timestamp: iso(T0 - 1_000) },
      { type: 'user', timestamp: iso(T0 + 60_000) },
    ]
    const state = world(on, { files: { [TRANSCRIPT]: jsonl(rows) }, transcriptMtimeMs: T0 + 60_000 })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
  })

  test('turned off: a Stop schedules nothing', { options: { enabled: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
  })

  test('helpers count edited files once and spot missing sections', () => {
    expect(filesModified(MESSAGES)).toEqual([`${ROOT}/src/login.test.ts`, `${ROOT}/src/clock.ts`])
    expect(missingSections(HANDOFF_BODY)).toEqual([])
    expect(missingSections('# Handoff\n## Next step\nShip it')).toContain('Failed attempts')
  })
})

describe('session start', () => {
  const files = (overrides: Partial<HandoffMeta> = {}) => ({
    [`${ROOT}/.claude/cache-magic/handoff.meta.json`]: JSON.stringify(meta(overrides)),
    [`${ROOT}/.claude/cache-magic/handoff.md`]: HANDOFF_BODY,
  })

  test('offers a fresh handoff from another session and loads it into a new one', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: files(), answer: 'Yes, clear and load it' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-b' })
    await clock.settle()
    expect(state.asked[0]).toContain('A handoff from 2026-10-10 19:50 UTC is available. 2 files were modified. Clear this session and load it?')
    expect(state.commands).toEqual([])
    expect(state.submitted[0]).toContain('## Failed attempts')
  })

  test('a resumed session is not asked at start: its first prompt is what auto-load intercepts', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: files(), answer: 'Yes, clear and load it' })
    await $.classic.SessionStart({ source: 'resume', session_id: 'session-a', prompt_cache_likely_expired: true })
    await clock.settle()
    expect(state.asked).toEqual([])
    expect(state.submitted).toEqual([])
  })

  test('says once, on the first new session, what it does and where the settings are', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-a' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-b' })
    await clock.settle()
    expect(state.logs.filter(text => text.startsWith('When a session over 50k tokens sits idle, Cache Magic'))).toHaveLength(1)
    expect(state.logs[0]).toContain('/config, rows starting "Cache Magic"')
  })

  test('is on with no options set', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-a' })
    await clock.settle()
    expect(state.logs[0]).toStartWith('When a session over 50k tokens sits idle, Cache Magic')
  })

  test('declining leaves the session alone', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: files(), answer: 'No' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-b' })
    await clock.settle()
    expect(state.asked).toHaveLength(1)
    expect(state.submitted).toEqual([])
  })

  test('offer rules: another session, within 24h, once per handoff', () => {
    const base = { meta: meta(), nowMs: T0, sessionId: 'session-b' }
    expect(shouldOffer(base)).toBe(true)
    expect(shouldOffer({ ...base, nowMs: T0 + 25 * 3_600_000 })).toBe(false)
    expect(shouldOffer({ ...base, offeredTimestamp: meta().timestamp })).toBe(false)
    expect(shouldOffer({ ...base, meta: undefined })).toBe(false)
    expect(shouldOffer({ ...base, sessionId: 'session-a' })).toBe(false)
    expect(offerQuestion(meta({ filesModified: 1 }))).toContain('1 file was modified')
  })
})

describe('auto-load', () => {
  const AUTO = { options: { enabled: true, autoLoad: 'auto' } }
  const ASK = { options: { enabled: true, autoLoad: 'ask' } }
  const PLAIN = { mode: 'auto', cache: 'cold', contextTokens: 900_000, handoffCurrent: true, replace: true } as const
  const prompt = (overrides: Partial<PromptFacts> = {}): PromptFacts => ({ origin: 'composer', text: 'Now run the tests', hasAttachments: false, duringTurn: false, ...overrides })

  // A 5m session that went idle at T0 and had its handoff forked 30 seconds before expiry. The fork's
  // read restarts the cache's clock, so the cache is gone at T0 + 269s + 300s.
  async function idleUntil($: Engine, on: On, setup: Setup, nowFromT0: number) {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { ...setup, files: { [TRANSCRIPT]: turn(T0 - 1_000, 300, 0), ...setup.files } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(269_000)
    expect(state.forks).toHaveLength(1)
    await clock.advance(nowFromT0 - 269_000)
    return { clock, state }
  }

  test('auto: a prompt after the cache expired clears the session and is sent after the handoff', AUTO, async ($, on) => {
    const { clock, state } = await idleUntil($, on, {}, 600_000)
    const result = await $.prompt.submit(typed('Now run the tests'))
    expect(result.drop).toContain('the prompt cache has expired')
    await clock.settle()
    expect(state.commands).toEqual(['clear'])
    expect(state.submitted).toHaveLength(1)
    expect(state.submitted[0]).toContain('## Failed attempts')
    expect(state.submitted[0]!.endsWith('My message:\n\nNow run the tests')).toBe(true)
    expect(state.asked).toEqual([])
    expect(state.saved).toEqual([])
  })

  test('a prompt while the fork has kept the cache warm goes as typed', AUTO, async ($, on) => {
    const { clock, state } = await idleUntil($, on, {}, 568_000)
    const result = await $.prompt.submit(typed('Now run the tests'))
    expect(result.drop).toBeUndefined()
    await clock.settle()
    expect(state.commands).toEqual([])
  })

  test('ask-once: the first answer loads the handoff and saves auto in /config', ENABLED, async ($, on) => {
    const { clock, state } = await idleUntil($, on, { answer: 'Yes, and load automatically from now on' }, 600_000)
    await $.prompt.submit(typed('Now run the tests'))
    await clock.settle()
    expect(state.asked[0]).toContain('The prompt cache has expired, so this prompt would re-send 900k tokens at full price.')
    expect(state.asked[0]).toContain('No, and never intercept again')
    expect(state.commands).toEqual(['clear'])
    expect(state.submitted[0]).toContain('Now run the tests')
    expect(state.saved).toEqual([{ key: 'cache-magic.autoLoad', value: 'auto' }])
  })

  test('ask-once: sending the full context resends the prompt as typed and saves ask', ENABLED, async ($, on) => {
    const { clock, state } = await idleUntil($, on, { answer: 'No, send it with the full context' }, 600_000)
    await $.prompt.submit(typed('Now run the tests'))
    await clock.settle()
    expect(state.commands).toEqual([])
    expect(state.submittedAsUser).toEqual(['Now run the tests'])
    expect(state.saved).toEqual([{ key: 'cache-magic.autoLoad', value: 'ask' }])
  })

  test('ask: asks each time without saving, and a dismissed question puts the prompt back in the box', ASK, async ($, on) => {
    const { clock, state } = await idleUntil($, on, { answer: 'something typed under Other' }, 600_000)
    await $.prompt.submit(typed('Now run the tests'))
    await clock.settle()
    expect(state.asked[0]).toContain('Yes, clear and send it after the handoff')
    expect(state.asked[0]).not.toContain('never intercept')
    expect(state.filled).toEqual(['Now run the tests'])
    expect(state.commands).toEqual([])
    expect(state.submitted).toEqual([])
    expect(state.saved).toEqual([])
  })

  test('a TTL that is only assumed never intercepts', AUTO, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(2 * 3_600_000)
    const result = await $.prompt.submit(typed('Now run the tests'))
    expect(result.drop).toBeUndefined()
    expect(state.commands).toEqual([])
  })

  test('a resumed session Claude Code reports cold loads its own handoff on the first prompt', AUTO, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, {
      files: { [`${ROOT}/.claude/cache-magic/handoff.meta.json`]: JSON.stringify(meta()), [`${ROOT}/.claude/cache-magic/handoff.md`]: HANDOFF_BODY },
    })
    const resume = { source: 'resume', session_id: 'session-a', seconds_since_last_response: 7_200, context_tokens: 900_000 } as const
    await $.classic.SessionStart({ ...resume, prompt_cache_likely_expired: true })
    expect((await $.prompt.submit(typed('Where were we?'))).drop).toBeDefined()
    await clock.settle()
    expect(state.commands).toEqual(['clear'])
    expect(state.submitted[0]).toContain('Where were we?')
  })

  test('a resumed session with a warm cache, or another session\'s handoff, goes as typed', AUTO, async ($, on) => {
    mock.clock(on, { now: T0 })
    world(on, { files: { [`${ROOT}/.claude/cache-magic/handoff.meta.json`]: JSON.stringify(meta({ sessionId: 'session-z' })), [`${ROOT}/.claude/cache-magic/handoff.md`]: HANDOFF_BODY } })
    const resume = { source: 'resume', session_id: 'session-a', seconds_since_last_response: 7_200, context_tokens: 900_000 } as const
    await $.classic.SessionStart({ ...resume, prompt_cache_likely_expired: false })
    expect((await $.prompt.submit(typed('Where were we?'))).drop).toBeUndefined()
    await $.classic.SessionStart({ ...resume, prompt_cache_likely_expired: true })
    expect((await $.prompt.submit(typed('Where were we?'))).drop).toBeUndefined()
  })

  test('intercepts only a plain typed prompt on a cold, large session with a current handoff', () => {
    expect(decideIntercept({ ...PLAIN, prompt: prompt() })).toEqual({ intercept: true })
    expect(decideIntercept({ ...PLAIN, mode: 'off', prompt: prompt() })).toEqual({ intercept: false, reason: 'off' })
    expect(decideIntercept({ ...PLAIN, prompt: prompt({ origin: 'plugin' }) })).toEqual({ intercept: false, reason: 'not-typed' })
    expect(decideIntercept({ ...PLAIN, prompt: prompt({ duringTurn: true }) })).toEqual({ intercept: false, reason: 'not-typed' })
    for (const text of ['/compact', '!ls', 'look at @src/login.ts', '   ']) {
      expect(decideIntercept({ ...PLAIN, prompt: prompt({ text }) })).toEqual({ intercept: false, reason: 'not-plain' })
    }
    expect(decideIntercept({ ...PLAIN, prompt: prompt({ hasAttachments: true }) })).toEqual({ intercept: false, reason: 'not-plain' })
    expect(decideIntercept({ ...PLAIN, prompt: prompt({ text: 'mail me at a@b.c' }) })).toEqual({ intercept: true })
    expect(decideIntercept({ ...PLAIN, cache: 'warm', prompt: prompt() })).toEqual({ intercept: false, reason: 'warm' })
    expect(decideIntercept({ ...PLAIN, cache: 'unknown', prompt: prompt() })).toEqual({ intercept: false, reason: 'ttl-unknown' })
    expect(decideIntercept({ ...PLAIN, contextTokens: 49_999, prompt: prompt() })).toEqual({ intercept: false, reason: 'context-small' })
    expect(decideIntercept({ ...PLAIN, handoffCurrent: false, prompt: prompt() })).toEqual({ intercept: false, reason: 'no-handoff' })
    expect(decideIntercept({ ...PLAIN, replace: false, prompt: prompt() })).toEqual({ intercept: false, reason: 'session-stays' })
  })

  test('reads Auto-load from config, falling back to ask-once', () => {
    expect(parseAutoLoad('auto')).toBe('auto')
    expect(parseAutoLoad('bogus')).toBe('ask-once')
    expect(parseAutoLoad(undefined)).toBe('ask-once')
  })

  test('a one-hour cache leaves the session: the handoff is written, the prompt is not cleared', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: { [TRANSCRIPT]: turn(T0 - 1_000, 0, 800) } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(3_570_000)
    expect(state.forks).toHaveLength(1)
    // Past the fork's own hour, the cache is cold, and the session still stays.
    await clock.advance(3_600_000)
    expect((await $.prompt.submit(typed('Now run the tests'))).drop).toBeUndefined()
    await clock.settle()
    expect(state.commands).toEqual([])
  })

  test('a one-hour cache still clears when idle compaction is off', { options: { enabled: true, autoLoad: 'auto' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: { [TRANSCRIPT]: turn(T0 - 1_000, 0, 800) }, settings: { idleCompaction: false } })
    await $.classic.Stop({ ...stop, transcript_path: TRANSCRIPT })
    await clock.advance(3_570_000)
    expect(state.forks).toHaveLength(1)
    // The fork read the cache and restarted its hour.
    await clock.advance(3_600_000)
    expect((await $.prompt.submit(typed('Now run the tests'))).drop).toBeDefined()
    await clock.settle()
    expect(state.commands).toEqual(['clear'])
  })

  test('a resumed one-hour session is left in place', { options: { enabled: true, autoLoad: 'auto' } }, async ($, on) => {
    mock.clock(on, { now: T0 })
    world(on, {
      files: { [`${ROOT}/.claude/cache-magic/handoff.meta.json`]: JSON.stringify(meta({ cacheTtl: '1h' })), [`${ROOT}/.claude/cache-magic/handoff.md`]: HANDOFF_BODY },
    })
    const resume = { source: 'resume', session_id: 'session-a', seconds_since_last_response: 7_200, context_tokens: 900_000 } as const
    await $.classic.SessionStart({ ...resume, prompt_cache_likely_expired: true })
    expect((await $.prompt.submit(typed('Where were we?'))).drop).toBeUndefined()
  })

  test('a resumed one-hour session whose idle compaction is off still loads the handoff', { options: { enabled: true, autoLoad: 'auto' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, {
      settings: { idleCompaction: false },
      files: { [`${ROOT}/.claude/cache-magic/handoff.meta.json`]: JSON.stringify(meta({ cacheTtl: '1h' })), [`${ROOT}/.claude/cache-magic/handoff.md`]: HANDOFF_BODY },
    })
    const resume = { source: 'resume', session_id: 'session-a', seconds_since_last_response: 7_200, context_tokens: 900_000 } as const
    await $.classic.SessionStart({ ...resume, prompt_cache_likely_expired: true })
    expect((await $.prompt.submit(typed('Where were we?'))).drop).toBeDefined()
    await clock.settle()
    expect(state.commands).toEqual(['clear'])
  })
})

describe('what the handoff keeps', () => {
  test('an empty or unknown keep list means all four parts', () => {
    expect(parseKeep(undefined)).toEqual(['instructions', 'decisions', 'files', 'next'])
    expect(parseKeep('')).toEqual(['instructions', 'decisions', 'files', 'next'])
    expect(parseKeep('all')).toEqual(['instructions', 'decisions', 'files', 'next'])
    expect(parseKeep('nope')).toEqual(['instructions', 'decisions', 'files', 'next'])
    expect(parseKeep('files, bogus, next')).toEqual(['files', 'next'])
  })

  test('a multi-select answer is matched by its labels, commas and all', () => {
    const answer = 'Next step and open questions, My instructions, quoted'
    expect(keepFromAnswer(answer)).toEqual(['instructions', 'next'])
    expect(keepFromAnswer('something else')).toBeUndefined()
    expect(writerFromAnswer(WRITER_HAIKU)).toBe('haiku')
    expect(writerFromAnswer("This session's model")).toBe('session')
    expect(writerFromAnswer('Opus')).toBeUndefined()
  })

  test('the prompt carries only the sections they kept, and quotes their words beside it', () => {
    const prompt = handoffPrompt('## main\n M src/login.test.ts\n', ['next'])
    expect(prompt).toContain('## Next step')
    expect(prompt).toContain('## Active task and current state')
    expect(prompt).not.toContain('## Failed attempts')
    expect(prompt).not.toContain('M src/login.test.ts')
    expect(prompt).toContain('still warm')
    const quotes = quotedInstructions(
      [
        { role: 'user', text: 'ok', toolUses: [] },
        { role: 'user', text: 'Fix the flaky login test', toolUses: [] },
        { role: 'assistant', text: 'Done.', toolUses: [] },
        { role: 'user', text: 'Leave the clock alone', toolUses: [] },
      ],
      10_000,
    )
    expect(quotes).toContain('> Fix the flaky login test')
    expect(quotes).toContain('> Leave the clock alone')
    expect(quotes).not.toContain('> ok')
    expect(withQuotes('# Handoff\n\n## Next step\nShip it', quotes)).toContain('## Instructions, as typed')
    expect(withQuotes('# Handoff', '')).toBe('# Handoff')
  })

  test('a five-minute cache clears; a one-hour cache clears only when idle compaction will not run', () => {
    expect(clearsOnColdPrompt('5m', {})).toBe(true)
    expect(clearsOnColdPrompt('1h', {})).toBe(false)
    expect(clearsOnColdPrompt('1h', { idleCompaction: false })).toBe(true)
    expect(clearsOnColdPrompt('1h', { autoCompactEnabled: false })).toBe(true)
    expect(clearsOnColdPrompt('1h', { idleCompaction: true })).toBe(false)
    expect(clearsOnColdPrompt('unknown', { idleCompaction: false })).toBe(false)
  })

  test('compaction of the main session writes a handoff first, and a precompute or a subagent does not', () => {
    expect(shouldWriteBeforeCompact({ trigger: 'auto', contextTokens: 900_000 })).toBe(true)
    expect(shouldWriteBeforeCompact({ trigger: 'manual', contextTokens: 900_000 })).toBe(true)
    expect(shouldWriteBeforeCompact({ trigger: 'precompute', contextTokens: 900_000 })).toBe(false)
    expect(shouldWriteBeforeCompact({ trigger: 'auto', agentId: 'worker', contextTokens: 900_000 })).toBe(false)
    expect(shouldWriteBeforeCompact({ trigger: 'auto', contextTokens: 49_999 })).toBe(false)
    expect(shouldWriteBeforeCompact({
      trigger: 'auto',
      contextTokens: 900_000,
      existing: { ageMs: 60_000, sameSession: true, turnsSince: 0 },
    })).toBe(false)
  })
})

describe('the warm-cache ask', () => {
  const chosen = (question: string) =>
    question === WRITER_QUESTION ? WRITER_HAIKU : 'My instructions, quoted, Next step and open questions'

  test('the first large turn asks what to keep and who writes it, and that handoff follows', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { askPrefs: true, answerFor: chosen })
    await $.classic.Stop(stop)
    await clock.settle()
    expect(state.asked[0]).toContain(KEEP_QUESTION)
    expect(state.asked[0]).toContain('My instructions, quoted')
    expect(state.asked[0]).toContain('"multiSelect":true')
    expect(state.asked[1]).toContain(WRITER_QUESTION)
    await clock.advance(270_000)
    expect(state.forks).toHaveLength(0)
    expect(state.completions).toBe(1)
    expect(state.completionPrompts[0]).toContain('## Next step')
    expect(state.completionPrompts[0]).not.toContain('## Failed attempts')
    const handoff = state.files.get(`${ROOT}/.claude/cache-magic/handoff.md`)
    expect(handoff).toContain('> Fix the flaky login test')
    expect(handoff).toContain('while the cache was warm')
  })

  test('dismissing the question keeps the defaults and does not ask again', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { askPrefs: true, answer: 'No' })
    await $.classic.Stop(stop)
    await clock.settle()
    expect(state.asked).toHaveLength(1)
    expect(state.saved).toEqual([])
    await $.classic.Stop(stop)
    await clock.settle()
    expect(state.asked).toHaveLength(1)
  })

  test('the next session start records the choice in /config', { options: { enabled: true, keep: 'instructions,next' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { askPrefs: true, answerFor: chosen })
    await $.classic.Stop(stop)
    await clock.settle()
    expect(state.saved).toEqual([])
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(state.saved).toEqual([{ key: 'cache-magic.generator', value: 'haiku' }])
  })
})

describe('before a compaction', () => {
  test('writes the handoff, tells the summary where it is, and does not clear', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    await clock.settle()
    expect(state.forks).toHaveLength(1)
    expect(state.forks[0]).toContain('still warm')
    expect(state.files.get(`${ROOT}/.claude/cache-magic/handoff.md`)).toContain('> Fix the flaky login test')
    expect(state.compactNotes[0]).toContain('while the cache was still warm')
    expect(state.commands).toEqual([])
  })

  test('a precompute or a subagent writes nothing', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    await $.session.compact({ trigger: 'auto', agentId: 'worker', messages: MESSAGES })
    await clock.settle()
    expect(state.forks).toHaveLength(0)
  })

  test('a second compaction in the same stretch does not write another handoff', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await clock.settle()
    expect(state.forks).toHaveLength(1)
  })
})
