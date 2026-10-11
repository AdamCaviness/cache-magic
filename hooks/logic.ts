import type { SessionMessage } from 'claude-code'

export type Ttl = '5m' | '1h'

export const TTL_SECONDS: Record<Ttl, number> = { '5m': 300, '1h': 3600 }
export const TRIGGER_WINDOW_SECONDS = 30
export const MIN_CONTEXT_TOKENS = 50_000
export const FRESH_HANDOFF_MS = 60 * 60 * 1000
export const OFFER_WINDOW_MS = 24 * 60 * 60 * 1000
// Bookkeeping rows (turn_duration, away_summary) land a moment after Stop.
export const STOP_SLACK_MS = 2_000

export const SECTIONS = [
  'Active task and current state',
  'Files modified and working tree status',
  'Commands run and their outcomes',
  'Decisions made and their rationale',
  'Failed attempts',
  'Next step',
  'Open questions',
] as const

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function parseTtl(value: unknown): Ttl | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === '5m' || text === '1h' ? text : undefined
}

export type TtlSources = {
  override?: unknown
  force5m?: string
  env?: string
  setting?: unknown
  enable1h?: string
}

// Claude Code's own precedence, with the mod's override first. Unset falls to
// 5m: a subscription's 1h default drops to 5m on usage credits, and firing
// early is cheap where firing late misses the cache.
export function resolveTtl(sources: TtlSources): Ttl {
  const override = parseTtl(sources.override)
  if (override) return override
  if (sources.force5m === '1') return '5m'
  return parseTtl(sources.env) ?? parseTtl(sources.setting) ?? (sources.enable1h === '1' ? '1h' : '5m')
}

// The statusLine payload's `prompt_cache` fields this mod reads.
export type CacheSnapshot = {
  warm: boolean
  ttl: Ttl
  expires_at: number | null
  recache_tokens_if_cold: number | null
}

export function snapshotFrom(lastResponseAtMs: number, ttl: Ttl, contextTokens: number, nowMs: number): CacheSnapshot {
  const expiresAt = Math.floor(lastResponseAtMs / 1000) + TTL_SECONDS[ttl]
  return {
    warm: nowMs / 1000 < expiresAt,
    ttl,
    expires_at: expiresAt,
    recache_tokens_if_cold: contextTokens,
  }
}

export function secondsRemaining(cache: CacheSnapshot, nowMs: number): number {
  return cache.expires_at === null ? 0 : cache.expires_at - nowMs / 1000
}

export type ExistingHandoff = { ageMs: number; sameSession: boolean; turnsSince: number }

export type TriggerInput = {
  cache: CacheSnapshot
  nowMs: number
  turnEnded: boolean
  draftPending: boolean
  claimed: boolean
  existing?: ExistingHandoff
}

export type SkipReason =
  | 'already-handled'
  | 'turn-active'
  | 'user-typing'
  | 'cache-cold'
  | 'not-yet'
  | 'context-small'
  | 'handoff-fresh'

export type Decision = { act: true } | { act: false; reason: SkipReason }

export function decide(input: TriggerInput): Decision {
  const skip = (reason: SkipReason): Decision => ({ act: false, reason })
  if (input.claimed) return skip('already-handled')
  if (!input.turnEnded) return skip('turn-active')
  if (input.draftPending) return skip('user-typing')
  const remaining = secondsRemaining(input.cache, input.nowMs)
  if (!input.cache.warm || remaining <= 0) return skip('cache-cold')
  if (remaining > TRIGGER_WINDOW_SECONDS) return skip('not-yet')
  if ((input.cache.recache_tokens_if_cold ?? 0) < MIN_CONTEXT_TOKENS) return skip('context-small')
  const existing = input.existing
  if (existing && existing.ageMs < FRESH_HANDOFF_MS && (!existing.sameSession || existing.turnsSince === 0)) {
    return skip('handoff-fresh')
  }
  return { act: true }
}

// Timestamp of the newest user or assistant row in JSONL transcript text,
// skipping meta rows and bookkeeping rows written after a turn ends.
export function lastRealRowAt(jsonl: string): number | undefined {
  const lines = jsonl.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim()
    if (!line) continue
    let row: { type?: unknown; isMeta?: unknown; timestamp?: unknown }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta === true) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (Number.isFinite(at)) return at
  }
  return undefined
}

export type TurnEvidence = {
  stoppedAt: number
  activeTurn: boolean
  transcriptMtimeMs?: number
  lastRealRowAt?: number
}

export function turnHasEnded(evidence: TurnEvidence): boolean {
  if (evidence.activeTurn) return false
  const limit = evidence.stoppedAt + STOP_SLACK_MS
  if (evidence.transcriptMtimeMs === undefined || evidence.transcriptMtimeMs <= limit) return true
  return evidence.lastRealRowAt === undefined || evidence.lastRealRowAt <= limit
}

export function filesModified(messages: readonly SessionMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (!EDIT_TOOLS.has(use.tool) || use.isError) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path === 'string' && path) paths.add(path)
    }
  }
  return [...paths]
}

export function handoffPrompt(workingTree: string | undefined): string {
  const tree = workingTree === undefined
    ? 'The working tree status could not be read; describe it from the conversation.'
    : `Current \`git status --porcelain=v1 --branch\`:\n\`\`\`\n${workingTree.trim() || '(clean)'}\n\`\`\``
  return [
    'Stop working on the task. Do not call any tools. The prompt cache for this session is about to expire,',
    'and a fresh session will continue from a handoff document instead of this context.',
    'Write that handoff now, for an engineer who has not seen this conversation.',
    '',
    'Reply with markdown only, starting with `# Handoff`, then exactly these sections in this order:',
    ...SECTIONS.map(section => `## ${section}`),
    '',
    'Rules:',
    '- Be concrete: exact file paths, commands, error messages, branch names, and identifiers.',
    '- Under "Failed attempts", list every approach that was tried and abandoned, with why it failed,',
    '  so the next session does not retry it. Write "None" only if nothing failed.',
    '- Under "Next step", give the single next action precisely enough to execute without asking.',
    '- Write "None" under any other section that has nothing to report.',
    '- Stay under 1,500 words.',
    '',
    tree,
  ].join('\n')
}

export function missingSections(markdown: string): string[] {
  return SECTIONS.filter(section => !new RegExp(`^##\\s+${section}\\s*$`, 'mi').test(markdown))
}

export type HandoffMeta = {
  timestamp: string
  sessionId: string
  cacheTtl: Ttl
  contextSize: number
  filesModified: number
  turns: number
}

export function parseMeta(text: string): HandoffMeta | undefined {
  try {
    const meta = JSON.parse(text) as Partial<HandoffMeta>
    if (typeof meta.timestamp !== 'string' || !Number.isFinite(Date.parse(meta.timestamp))) return undefined
    if (typeof meta.sessionId !== 'string') return undefined
    return {
      timestamp: meta.timestamp,
      sessionId: meta.sessionId,
      cacheTtl: parseTtl(meta.cacheTtl) ?? '5m',
      contextSize: typeof meta.contextSize === 'number' ? meta.contextSize : 0,
      filesModified: typeof meta.filesModified === 'number' ? meta.filesModified : 0,
      turns: typeof meta.turns === 'number' ? meta.turns : 0,
    }
  } catch {
    return undefined
  }
}

export function renderHandoff(body: string, meta: HandoffMeta): string {
  const header = `<!-- cache-handoff: generated ${meta.timestamp} from session ${meta.sessionId} at ${meta.contextSize} context tokens -->`
  return `${header}\n${body.trim()}\n`
}

export type OfferInput = {
  meta: HandoffMeta | undefined
  nowMs: number
  source: string
  sessionId: string
  cacheLikelyExpired?: boolean
  offeredTimestamp?: unknown
}

export function shouldOffer(input: OfferInput): input is OfferInput & { meta: HandoffMeta } {
  const meta = input.meta
  if (!meta || input.offeredTimestamp === meta.timestamp) return false
  const ageMs = input.nowMs - Date.parse(meta.timestamp)
  if (!(ageMs >= 0 && ageMs < OFFER_WINDOW_MS)) return false
  if (input.source === 'startup') return meta.sessionId !== input.sessionId
  // A resumed session only benefits when it is the one the handoff describes and its cache went cold.
  if (input.source === 'resume') return meta.sessionId === input.sessionId && input.cacheLikelyExpired !== false
  return false
}

export function formatTimestamp(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function offerQuestion(meta: HandoffMeta): string {
  const files = meta.filesModified === 1 ? '1 file was' : `${meta.filesModified} files were`
  return `A handoff from ${formatTimestamp(meta.timestamp)} is available. ${files} modified. Clear this session and load it?`
}

export function loadMessage(handoff: string): string {
  return [
    'Continue from this handoff, written by the previous session before its prompt cache expired.',
    'Read it, do not retry anything under "Failed attempts", and wait for my go-ahead before starting the next step.',
    '',
    handoff.trim(),
  ].join('\n')
}

// Text of the newest messages that fit in maxChars, with the opening request
// kept, for a model that cannot read this session's cache.
export function transcriptDigest(messages: readonly SessionMessage[], maxChars: number): string {
  const render = (message: SessionMessage) => {
    const lines = [`### ${message.role}`]
    if (message.text) lines.push(message.text)
    for (const use of message.toolUses) {
      const input = JSON.stringify(use.input).slice(0, 400)
      const outcome = (use.text ?? '').slice(0, 600)
      lines.push(`- ${use.tool} ${input}${use.isError ? ' -> ERROR ' : ' -> '}${outcome}`)
    }
    return lines.join('\n')
  }
  const rendered = messages.map(render)
  const first = rendered[0] ?? ''
  const kept: string[] = []
  let size = first.length
  for (let index = rendered.length - 1; index > 0; index--) {
    const block = rendered[index]!
    if (size + block.length > maxChars) break
    kept.unshift(block)
    size += block.length
  }
  const omitted = rendered.length - 1 - kept.length
  return [first, ...(omitted > 0 ? [`[... ${omitted} earlier messages omitted ...]`] : []), ...kept].join('\n\n')
}

export function appendLog(existing: string, line: string, maxLines: number): string {
  const lines = existing.split('\n').filter(Boolean)
  lines.push(line)
  return `${lines.slice(-maxLines).join('\n')}\n`
}
