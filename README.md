# Cache Magic

A Claude Code mod for one quota problem: a large session that sits idle past its prompt cache TTL. The next prompt, however small, re-sends the whole context at full input price. On a 900k-token session that can cost 15 to 20% of a 5-hour usage window ([anthropics/claude-code#51218](https://github.com/anthropics/claude-code/issues/51218)).

Cache Magic handles both sides of that moment. About 30 seconds before the cache expires, while it is still warm, it writes a structured handoff of the session to `.claude/handoff.md`. When you come back and send a prompt after the cache has expired, it catches the prompt before it goes out, clears the session, and sends your prompt after the handoff instead of the full context. The first time, it asks whether to do that automatically from then on or to ask each time.

It is off by default.

## Install

Cache Magic is listed in [agentic-marketplace](https://github.com/adamcaviness/agentic-marketplace):

```bash
claude plugin install cache-magic --marketplace adamcaviness/agentic-marketplace --config enabled=true
```

`--marketplace` adds agentic-marketplace the first time. To install now and turn it on later, leave out `--config enabled=true` and set **Cache Magic: Enabled** in `/plugin configure cache-magic@agentic-marketplace`.

Then turn on auto-update: `/plugin` → **Marketplaces** → **agentic-marketplace** → **Enable auto-update**. Claude Code leaves it off for marketplaces outside Anthropic's, so without it you keep the version you first installed.

[agentic-toolkit](https://github.com/adamcaviness/agentic-toolkit) installs it for you, still off until you enable it.

To try it for one session from a clone of this repository, without installing:

```bash
claude --plugin-dir . --settings '{"pluginConfigs":{"cache-magic@inline":{"options":{"enabled":true}}}}'
```

`claude plugin install .` does not work: as of Claude Code 2.1.296, `install` only takes a plugin name from a marketplace.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns the mod on. When off, it registers no hooks. |
| `autoLoad` | `ask-once` | What happens to a prompt sent after the cache expired; see Auto-load below. `ask-once` asks the first time and saves your answer as `auto` or `ask`. `auto` loads the handoff without asking. `ask` asks each time. `off` sends the prompt with the full context. |
| `cacheTtlOverride` | empty | `5m` or `1h`, used only when the transcript doesn't yet show the TTL (see below). Empty follows Claude Code's own order: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then `5m`. |
| `generator` | `fork` | How the handoff is written; see Cost below. `haiku` is the alternative. |
| `timeoutSeconds` | `90` | How long to wait for the handoff before giving up and logging the failure. |

**You don't need to set the TTL.** Every response the API returns records how many tokens it wrote to the cache at each TTL (`cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`), and Claude Code keeps that in the session transcript. The mod reads the newest response's split, so it knows whether this session's cache lasts five minutes or an hour, whatever your plan or billing state. The override and settings matter only before the first response that wrote to the cache.

## What happens

**At the end of a turn** (the `Stop` or `TeammateIdle` hook), the mod reads the transcript's newest rows for the cache's TTL and for when the turn's last request was sent. The cache's clock restarts at each request, not when the response ends, so a long response doesn't make the mod late. It starts a timer for 30 seconds before the TTL runs out, counted from that request. The hook returns right away. Nothing runs on `PreToolUse`, the `prompt.submit` hook reads files only once the cache is gone (see Auto-load), and no model call waits on a turn. The `turn.start` hook only cancels the timer.

**When the timer fires**, the mod writes a handoff only if all of these hold:

- The turn really ended. No turn is running, and the transcript has no user or assistant row newer than the `Stop`. Bookkeeping rows Claude Code writes after a turn don't count.
- The prompt box is empty. A draft means you are about to send a prompt, which refreshes the cache. The mod checks again every 5 seconds until the cache expires.
- The context is at least 50k tokens.
- There is no handoff under an hour old from this session with no turns since.
- No handoff has been written yet in this idle period.

**The handoff** is a markdown file with these sections: active task and current state; files modified and working tree status; commands run and their outcomes; decisions made and their rationale; failed attempts; next step; open questions. The prompt includes `git status --porcelain=v1 --branch`, so the working tree section is current. It also tells the model to list every abandoned approach under "Failed attempts", so the fresh session doesn't retry dead ends.

**Files written**, under the project root:

| File | Contents |
| --- | --- |
| `.claude/handoff.md` | The latest handoff |
| `.claude/handoff.1.md` to `.claude/handoff.3.md` | The three before it, newest first. Each opens with a comment giving its generation time. |
| `.claude/handoff.meta.json` | `{ timestamp, sessionId, cacheTtl, contextSize, filesModified, turns }` |
| `.claude/handoff-error.log` | Failures and timeouts, keeping the last 200 lines |

You may want `.claude/handoff*` in your `.gitignore`.

## Auto-load

**When you send a prompt** (the `prompt.submit` hook), the mod catches it before it goes out only if all of these hold:

- You typed it and pressed Enter, while no turn was running. Prompts from other plugins, peers, and the SDK go through.
- It is plain text: not a `/` command or `!` shell line, with no image and no `@` mention. A prompt the mod sends on your behalf can't carry those, so the mod leaves them alone.
- The cache is surely gone: one TTL after the later of the turn's `Stop` and the handoff fork, which reads the cache and restarts its clock. If the TTL is only assumed (the transcript showed none and nothing is configured), the mod never intercepts, so it can't throw away a warm cache on a guess.
- The context is at least 50k tokens.
- `.claude/handoff.md` is this session's, written after its last turn.

For a resumed session, Claude Code reports at startup whether the cache likely expired. If it did, the session's first typed prompt is a late one and gets the same treatment.

**Then** the prompt is dropped, with a note saying so, and depending on `autoLoad`:

| `autoLoad` | What happens |
| --- | --- |
| `ask-once` (default) | It asks: *The prompt cache has expired, so this prompt would re-send 900k tokens at full price. Clear the session and send it after the handoff from 2026-10-10 20:15 UTC?* The four answers are **Yes, and load automatically from now on**; **Yes, and ask me each time**; **No, send it with the full context**; **No, and never intercept again**. It acts on the answer, then saves `auto`, `ask`, `ask` or `off` and tells you where the setting lives. |
| `auto` | It loads the handoff without asking. |
| `ask` | It asks the same question each time, with two answers: **Yes, clear and send it after the handoff** or **No, send it with the full context**. |
| `off` | It never catches a prompt. |

Loading runs `/clear`, then sends one message: the handoff, then your prompt under "My message". A line in the new transcript says what happened. The full session stays in `/resume`. Sending with the full context resends your prompt unchanged, as your own words. Dismissing the question puts the prompt back in the prompt box.

**To change it**, open `/config` and set the **Cache Magic: Auto-load** row, or run `/plugin configure cache-magic@agentic-marketplace`.

## New sessions

**On a new session** (`startup`), if `.claude/handoff.meta.json` is under 24 hours old and from another session, the mod asks:

> A handoff from 2026-10-10 19:50 UTC is available. 2 files were modified. Clear this session and load it?

Yes sends the handoff as the first message. Each handoff is offered once. The question runs after the hook returns, so it never delays startup.

## Cost

The default generator, `fork`, uses `$.model.fork`. A fork replays the session's last request on the session's own model and appends the handoff instructions, so the API serves the existing context from the warm cache. Input bills at the cache-read rate, about 0.1× of normal input, and you pay full price only for the handoff text written. The fork's request also counts as a cache hit, which keeps the cache warm for another TTL.

The `haiku` generator calls `$.model.complete` with Haiku at high effort. **Haiku can't read this session's cache**, because each model has its own. That call sends a trimmed transcript: the first request plus the newest messages, up to about 400k characters (roughly 100k tokens), uncached. It costs less per token but sees less. A failed attempt early in a long session can fall outside what it reads. Use it when the fork's cache read on a very large context costs more than you want.

## API limits

These are limits of the mods API as of Claude Code 2.1.296:

- **No model choice on a cached fork.** `$.model.fork` takes only a prompt. It always runs on the session's model, with no effort, token cap, or timeout setting. The mod's timeout stops waiting but can't cancel the request. Since cache reads are tied to the model, a cheap model reading the session's cache isn't possible.
- **Mods don't receive the statusLine payload.** The statusLine's `prompt_cache.expires_at` goes only to the statusLine command. The mod computes the expiry itself, one TTL after the turn's last request. Its internal `CacheSnapshot` uses the statusLine field names (`warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`).
- **No hook reports the cache TTL.** Only the model-switch hooks carry `cache_ttl`. The mod reads it from the transcript's usage rows instead.
- **`$.fs` can't delete or rename.** A timestamp-named file per version would pile up with no way to prune it, so prior versions rotate through three fixed slots instead.
- **`$.fs.read` stops at 4 MiB and reads whole files.** A long session's transcript is larger, so the mod reads its last 2 MiB with `tail` through `$.process.run`. Where `tail` can't run, it reads a transcript within 4 MiB whole, and past that falls back to the configured TTL and its own turn tracking from `turn.start` and `Stop`.
- **A fork can't call tools.** The working tree status in the handoff comes from one `git status` the mod runs itself through `$.process.run`, with a 3-second timeout.
- **`/clear` can't run inside `prompt.submit`.** The host refuses it while the hook holds the prompt, so the mod drops the prompt and does the rest once the hook has returned.
- **A plugin's prompt expands neither images nor `@` mentions.** Auto-load sends your prompt on your behalf, so it leaves prompts with either alone.

The fallback of having the main agent write the handoff itself, through a reminder injected at `Stop`, isn't needed: `$.model.fork` covers the case without starting a turn.

## Develop

```bash
claude plugin validate --strict .
claude plugin test .
```

`tsc -p .` checks types against `.claude-plugin/types`, which Claude Code writes beside the mod when it loads it from your own folder.
