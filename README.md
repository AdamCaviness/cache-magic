# Cache Magic

A Claude Code mod offering a different approach to Anthropic's built-in automatic idle compaction for a large session that sits idle past its prompt cache TTL. If you don't use built-in idle compaction and otherwise do nothing about prompt cache expiration, your next prompt, however small, re-sends the whole context at full input price. Imagine a session you let get out of hand at 900k-tokens; that could cost 15 to 20% of a 5-hour usage window ([anthropics/claude-code#51218](https://github.com/anthropics/claude-code/issues/51218)).

The right time to address this is while the cache is still warm but we usually don't know when we'll have to step away and things will just automatically go cold (why Anthropic release idleCompaction). 

About 30 seconds before it expires, this mod spends one cache _read_ building a handoff at `.claude/cache-magic/handoff.md`. You pick what goes in it: your instructions quoted, decisions and failed attempts, files and git status, the next step (that's the part idle compaction doesn't keep for you). When you come back to keep working, it asks if you want to continue from that smaller handoff, and if you want it to do that from then on.

What you get when you come back depends on the cache:

- **Five minutes.** Idle compaction doesn't run on a five-minute cache. Send a prompt after it expires and this mod can clear the session and send that prompt after the handoff, so you aren't paying full price for the whole context again. The first time, it asks whether to do that from then on or to ask you each time.
- **One hour.** Claude Code compacts these itself (`Compacted while idle, before the prompt cache expired`). This mod still writes the handoff and leaves the session where it is. If this idle stretch doesn't already have one, the compaction writes that file first and the summary is told where it is. Clearing the session and sending the late prompt only happens when idle compaction won't run, which is `idleCompaction` or `autoCompactEnabled` set to `false`.

Sessions under 50k tokens are left alone. The first new session after you install it shows one line about what it does and where the settings live.

## Install

It's listed in [agentic-marketplace](https://github.com/adamcaviness/agentic-marketplace), and [agentic-toolkit](https://github.com/adamcaviness/agentic-toolkit) installs it for you. On its own:

```bash
claude plugin install cache-magic --marketplace adamcaviness/agentic-marketplace
```

`--marketplace` adds agentic-marketplace the first time. Then turn on auto-update: `/plugin` → **Marketplaces** → **agentic-marketplace** → **Enable auto-update**. Claude Code leaves that off for marketplaces outside Anthropic's, so if you skip it you stay on the version you first installed.

To try it for one session from a clone of this repo, without installing:

```bash
claude --plugin-dir .
```

`claude plugin install .` won't work. As of Claude Code 2.1.296, `install` only takes a plugin name from a marketplace.

## Configuration

Every setting is a row in `/config` starting with "Cache Magic". The same settings are in `/plugin configure cache-magic@agentic-marketplace`.

| Row | Key | Default | What it does |
| --- | --- | --- | --- |
| Cache Magic: On | `enabled` | on | Turn it off and the mod registers no hooks. |
| Cache Magic: Auto-load | `autoLoad` | `ask-once` | What happens when you send a prompt after a five-minute cache has expired, and after a one-hour cache when idle compaction is off. `ask-once` asks the first time and saves your answer as `auto` or `ask`. `auto` loads the handoff without asking. `ask` asks each time. `off` sends the prompt with the full context. A one-hour cache with idle compaction left on stays as it is. |
| Cache Magic: Handoff keeps | `keep` | `instructions,decisions,files,next` | Comma-separated. `instructions` quotes your messages into the file. `decisions` is the choices and the failed attempts. `files` is paths, commands, and git status. `next` is the next step and the open questions. The current task is always kept. If a value isn't recognized, it keeps all four. The first large turn asks this, and the answer is written here on the next session. |
| Cache Magic: Handoff writer | `generator` | `session` | Who writes the handoff (see Cost). `haiku` is the other choice. |
| Cache Magic: Handoff timeout | `timeoutSeconds` | `90` | How long to wait on the handoff before giving up and logging the failure. |
| Cache Magic: Cache TTL fallback | `cacheTtlOverride` | `auto` | You rarely need this. `5m` or `1h`, and only when the transcript doesn't show the TTL yet (below). `auto` follows Claude Code's own order: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then `5m`. |

**You don't have to set the TTL.** Each API response records how many tokens it wrote into the cache at each TTL (`cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`), and Claude Code keeps that in the session transcript. The mod reads the newest response, so it knows whether this session's cache lasts five minutes or an hour, whatever your plan is doing. The override and those settings only matter before the first response that actually wrote to the cache.

## What happens

**When a turn ends** (`Stop` or `TeammateIdle`), the mod looks at the newest transcript rows for the cache TTL and for when that turn's last request went out. The cache clock starts over on each request, not when the response finishes, so a long answer doesn't make the timer late. It sets a timer for 30 seconds before the TTL, counted from that request, and the hook returns right away. Nothing runs on `PreToolUse`. `prompt.submit` only reads files once the cache is gone (see Auto-load), and no model call sits on your turn. `turn.start` just cancels the timer.

**When the timer fires**, it writes a handoff only if all of these are true:

- The turn really ended. Nothing is running, and the transcript has no user or assistant row newer than the `Stop`. Bookkeeping rows Claude Code writes after a turn don't count.
- The prompt box is empty. A draft means you're about to send something, and that refreshes the cache. It looks again every 5 seconds until the cache expires.
- The context is at least 50k tokens.
- There isn't already a handoff under an hour old from this session with no turns since.
- This idle stretch doesn't already have a handoff.

**The handoff** always has the current task. The other sections follow `keep`: files and commands (with `git status --porcelain=v1 --branch` when that part is on), decisions and failed attempts, the next step and open questions. Your own instructions are copied out of the transcript as you typed them, and appended under "Instructions, as typed": the first one, then the newest that fit.

**Before a compaction** (`session.compact`, which is idle compaction and `/compact`), the same file is written first, for the main conversation only, when the context is still at least 50k tokens and this idle stretch doesn't already have a handoff. The summary is told the file is at `.claude/cache-magic/handoff.md`. A precompute, and a subagent compacting on its own, are left alone. The session stays.

**Files it writes**, under the project root:

| File | Contents |
| --- | --- |
| `.claude/cache-magic/handoff.md` | The latest handoff |
| `.claude/cache-magic/handoff.1.md` to `.claude/cache-magic/handoff.3.md` | The three before it, newest first. Each opens with a comment giving its generation time. |
| `.claude/cache-magic/handoff.meta.json` | `{ timestamp, sessionId, cacheTtl, contextSize, filesModified, turns }` |
| `.claude/cache-magic/handoff-error.log` | Failures and timeouts, keeping the last 200 lines |

The folder's `.gitignore` is `*`, so none of this gets committed and your own `.gitignore` can stay as it is.

## Auto-load

**On the first turn over 50k tokens**, it asks what the handoff should hold (any of the four) and who should write it: this session's model, which reads the warm cache, or Haiku, which costs less and only sees the newest part. Dismiss it and you keep the defaults; it won't ask again. The answer is used for the rest of this session right away, and written into `/config` at the next session start, so saving it doesn't cancel the idle timer. If you have a draft sitting in the prompt box, it waits and asks on a later turn.

**When you send a prompt** (`prompt.submit`), the mod catches it before it goes out only if all of these are true:

- You typed it and pressed Enter, and no turn was running. Prompts from other plugins, peers, and the SDK go through.
- It's plain text: not a `/` command or a `!` shell line, no image, no `@` mention. A prompt this mod sends for you can't carry those, so it leaves them alone.
- The cache is surely gone: one TTL after the later of the turn's `Stop` and the handoff fork, which reads the cache and restarts its clock. If the TTL is only a guess (the transcript showed none and nothing is configured), it leaves the prompt alone. A guess must not throw away a warm cache.
- It's a cache this mod is willing to clear: five minutes, or one hour with `idleCompaction` or `autoCompactEnabled` set to `false`. A one-hour cache otherwise stays. The handoff file is already written.
- The context is at least 50k tokens.
- `.claude/cache-magic/handoff.md` is this session's, written after its last turn.

If you resume a session, Claude Code says at startup whether the cache likely expired. When it did, the first prompt you type is a late one and gets the same treatment.

**Then** the prompt is dropped, with a note saying so, and `autoLoad` decides the rest:

| `autoLoad` | What happens |
| --- | --- |
| `ask-once` (default) | It asks: *The prompt cache has expired, so this prompt would re-send 900k tokens at full price. Clear the session and send it after the handoff from 2026-10-10 20:15 UTC?* The four answers are **Yes, and load automatically from now on**; **Yes, and ask me each time**; **No, send it with the full context**; **No, and never intercept again**. It acts on the answer, then saves `auto`, `ask`, `ask` or `off` and tells you where the setting lives. |
| `auto` | It loads the handoff without asking. |
| `ask` | It asks the same question each time, with two answers: **Yes, clear and send it after the handoff** or **No, send it with the full context**. |
| `off` | It never catches a prompt. |

Loading runs `/clear`, then sends one message: the handoff, then your prompt under "My message". A line in the new transcript says what happened. The full session is still there in `/resume`. If you send with the full context, your prompt goes out unchanged, in your own words. Dismiss the question and the prompt goes back in the box.

**To change it later**, open `/config` and set **Cache Magic: Auto-load**, or run `/plugin configure cache-magic@agentic-marketplace`.

## New sessions

**On a new session** (`startup`), if `.claude/cache-magic/handoff.meta.json` is under 24 hours old and came from another session, it asks:

> A handoff from 2026-10-10 19:50 UTC is available. 2 files were modified. Clear this session and load it?

Yes sends the handoff as the first message. Each handoff is offered once. The question runs after the hook returns, so it doesn't hold up startup.

## Cost

The default writer, `session`, uses `$.model.fork`. A fork replays the session's last request on the session's own model and appends the handoff instructions, so the API serves the context you already have from the warm cache. Input bills at the cache-read rate, about 0.1× of normal input, and you pay full price only for the handoff text it writes. That request also counts as a cache hit, which keeps the cache warm for another TTL.

The `haiku` writer calls `$.model.complete` with Haiku at high effort. Haiku can't read this session's cache, because each model has its own. That call sends a trimmed transcript: the first request plus the newest messages, up to about 400k characters (roughly 100k tokens), and it goes out uncached. It costs less per token and it sees less. A failed attempt early in a long session can fall outside what it reads. Use it when a cache read of a very large context costs more than you want to spend.

## API limits

These are limits of the mods API as of Claude Code 2.1.296:

- **No model choice on a cached fork.** `$.model.fork` takes only a prompt. It always runs on the session's model, with no effort, token cap, or timeout you can set. The mod's timeout stops waiting, but it can't cancel the request. Cache reads are tied to the model, so a cheaper model can't read this session's cache.
- **Mods don't get the statusLine payload.** The statusLine's `prompt_cache.expires_at` only goes to the statusLine command. The mod works out the expiry itself, one TTL after the turn's last request. Its internal `CacheSnapshot` uses the statusLine field names (`warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`).
- **No hook reports the cache TTL.** Only the model-switch hooks carry `cache_ttl`. The mod reads it from the transcript's usage rows.
- **`$.fs` can't delete or rename.** A timestamped file for every version would pile up with no way to prune it, so older handoffs rotate through three fixed slots.
- **`$.fs.read` stops at 4 MiB and reads whole files.** A long session's transcript is bigger than that, so the mod reads the last 2 MiB with `tail` through `$.process.run`. Where `tail` can't run, it reads a transcript within 4 MiB whole, and past that it falls back to the configured TTL and its own turn tracking from `turn.start` and `Stop`.
- **A fork can't call tools.** The working tree status in the handoff comes from one `git status` the mod runs itself through `$.process.run`, with a 3-second timeout.
- **`/clear` can't run inside `prompt.submit`.** The host refuses it while the hook is still holding the prompt, so the mod drops the prompt and finishes once the hook has returned.
- **A plugin prompt expands neither images nor `@` mentions.** Auto-load sends your prompt for you, so a prompt with either of those is left alone.

You don't need the fallback of having the main agent write the handoff itself, through a reminder injected at `Stop`. `$.model.fork` covers it without starting a turn.

## Develop

```bash
claude plugin validate --strict .
claude plugin test .
```

`tsc -p .` typechecks against `.claude-plugin/types`, which Claude Code writes beside the mod when it loads this folder.
