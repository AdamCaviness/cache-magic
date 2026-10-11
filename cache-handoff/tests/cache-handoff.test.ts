import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  decide,
  filesModified,
  lastRealRowAt,
  missingSections,
  offerQuestion,
  parseMeta,
  resolveTtl,
  SECTIONS,
  shouldOffer,
  snapshotFrom,
  turnHasEnded,
  type CacheSnapshot,
  type HandoffMeta,
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
  commands: string[]
  asked: string[]
}

// Answers every call the mod makes beneath it, from memory.
type Setup = {
  files?: Record<string, string>
  tokens?: number
  draft?: string
  answer?: string
  fork?: 'answer' | 'hang'
  transcriptMtimeMs?: number
}

function world(on: On, setup: Setup = {}): World {
  const state: World = { files: new Map(Object.entries(setup.files ?? {})), forks: [], completions: 0, submitted: [], commands: [], asked: [] }
  mock.store(on)
  mock.env(on, {})
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('settings.read', () => ({ value: {} }))
  on('session.root', () => ({ value: ROOT }))
  on('session.turns', () => ({ value: 7 }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({
    value: { startedAt: T0 - 3_600_000, context: { tokens: setup.tokens ?? 900_000, window: 1_000_000, percent: 90 }, rateLimits: [] },
  }))
  on('prompt.read', () => ({ value: { text: setup.draft ?? '', cursor: 0 } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '## main\n M src/login.test.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.log', () => ({ value: undefined }))
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
  on('model.complete', () => {
    state.completions++
    return { value: { isAnswered: true, text: HANDOFF_BODY, usage: { input_tokens: 100_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    state.asked.push(JSON.stringify(e))
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    return { result: { answers: { [question]: setup.answer ?? 'No' } }, text: setup.answer ?? 'No' }
  })
  on('command.run', ($, e) => {
    state.commands.push(e.command)
    return {}
  })
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const stop = { stop_hook_active: false, last_assistant_message: 'Done.', transcript_path: '', session_id: 'session-a' } as const

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

  test('resolves the TTL: override, then FORCE_PROMPT_CACHING_5M, env, setting, ENABLE_PROMPT_CACHING_1H, then 5m', () => {
    expect(resolveTtl({ override: '1h', force5m: '1' })).toBe('1h')
    expect(resolveTtl({ override: '', force5m: '1', env: '1h' })).toBe('5m')
    expect(resolveTtl({ env: '1h', setting: '5m' })).toBe('1h')
    expect(resolveTtl({ env: 'bogus', setting: '1h' })).toBe('1h')
    expect(resolveTtl({ enable1h: '1' })).toBe('1h')
    expect(resolveTtl({})).toBe('5m')
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
    const handoff = state.files.get(`${ROOT}/.claude/handoff.md`)
    expect(handoff).toContain('# Handoff')
    expect(handoff).toContain('session session-a')
    const written = parseMeta(state.files.get(`${ROOT}/.claude/handoff.meta.json`)!)
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

  test('keeps the prior three handoffs in rotation slots', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, {
      files: {
        [`${ROOT}/.claude/handoff.md`]: 'current',
        [`${ROOT}/.claude/handoff.1.md`]: 'one',
        [`${ROOT}/.claude/handoff.2.md`]: 'two',
        [`${ROOT}/.claude/handoff.3.md`]: 'three',
      },
    })
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    expect(state.files.get(`${ROOT}/.claude/handoff.1.md`)).toBe('current')
    expect(state.files.get(`${ROOT}/.claude/handoff.2.md`)).toBe('one')
    expect(state.files.get(`${ROOT}/.claude/handoff.3.md`)).toBe('two')
  })

  test('the haiku generator sends a transcript digest to Haiku instead of forking', { options: { enabled: true, generator: 'haiku' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on)
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    expect(state.forks).toHaveLength(0)
    expect(state.completions).toBe(1)
    expect(state.files.get(`${ROOT}/.claude/handoff.md`)).toContain('# Handoff')
  })

  test('a fork that outlasts the timeout logs to handoff-error.log and writes nothing', { options: { enabled: true, timeoutSeconds: 10 } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { fork: 'hang' })
    await $.classic.Stop(stop)
    await clock.advance(270_000)
    await clock.advance(10_000)
    expect(state.files.has(`${ROOT}/.claude/handoff.md`)).toBe(false)
    expect(state.files.get(`${ROOT}/.claude/handoff-error.log`)).toContain('fork timed out after 10s')
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
    const transcript = '/home/me/.claude/projects/p/session-a.jsonl'
    const rows = [
      { type: 'assistant', timestamp: new Date(T0 - 1_000).toISOString() },
      { type: 'user', timestamp: new Date(T0 + 60_000).toISOString() },
    ]
    const state = world(on, { files: { [transcript]: rows.map(row => JSON.stringify(row)).join('\n') }, transcriptMtimeMs: T0 + 60_000 })
    await $.classic.Stop({ ...stop, transcript_path: transcript })
    await clock.advance(300_000)
    expect(state.forks).toHaveLength(0)
  })

  test('disabled by default: a Stop schedules nothing', async ($, on) => {
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
    [`${ROOT}/.claude/handoff.meta.json`]: JSON.stringify(meta(overrides)),
    [`${ROOT}/.claude/handoff.md`]: HANDOFF_BODY,
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

  test('clears a resumed session whose cache went cold before loading its handoff', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: files(), answer: 'Yes, clear and load it' })
    await $.classic.SessionStart({ source: 'resume', session_id: 'session-a', prompt_cache_likely_expired: true })
    await clock.settle()
    expect(state.commands).toEqual(['clear'])
    expect(state.submitted).toHaveLength(1)
  })

  test('declining leaves the session alone', ENABLED, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const state = world(on, { files: files(), answer: 'No' })
    await $.classic.SessionStart({ source: 'startup', session_id: 'session-b' })
    await clock.settle()
    expect(state.asked).toHaveLength(1)
    expect(state.submitted).toEqual([])
  })

  test('offer rules: within 24h, once per handoff, and a resume only when its own cache is cold', () => {
    const base = { meta: meta(), nowMs: T0, source: 'startup', sessionId: 'session-b' }
    expect(shouldOffer(base)).toBe(true)
    expect(shouldOffer({ ...base, nowMs: T0 + 25 * 3_600_000 })).toBe(false)
    expect(shouldOffer({ ...base, offeredTimestamp: meta().timestamp })).toBe(false)
    expect(shouldOffer({ ...base, meta: undefined })).toBe(false)
    expect(shouldOffer({ ...base, source: 'resume', sessionId: 'session-a', cacheLikelyExpired: false })).toBe(false)
    expect(shouldOffer({ ...base, source: 'resume', sessionId: 'session-a', cacheLikelyExpired: true })).toBe(true)
    expect(shouldOffer({ ...base, source: 'resume', sessionId: 'session-c', cacheLikelyExpired: true })).toBe(false)
    expect(offerQuestion(meta({ filesModified: 1 }))).toContain('1 file was modified')
  })
})
