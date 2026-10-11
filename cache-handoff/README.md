# Cache Handoff

A Claude Code mod for one quota problem: a large session that sits idle past its prompt cache TTL. The next prompt, however small, re-sends the whole context at full input price. On a 900k-token session that can cost 15 to 20% of a 5-hour usage window ([anthropics/claude-code#51218](https://github.com/anthropics/claude-code/issues/51218)).

Cache Handoff watches for that moment. About 30 seconds before the cache expires, while it is still warm, it writes a structured handoff of the session to `.claude/handoff.md`. When you come back, a new or resumed session offers to load the handoff instead of the full context.

It is off by default.

## Install

From a clone of this repository:

```bash
claude plugin install cache-handoff --marketplace ./ --config enabled=true
```

Or from GitHub once the repository is published:

```bash
claude plugin install cache-handoff --marketplace adamcaviness/cache-magic --config enabled=true
```

`--marketplace` adds the repository's own marketplace (`cache-magic`) the first time. To install now and turn it on later, leave out `--config enabled=true` and set **Cache Handoff: Enabled** in `/plugin configure cache-handoff@cache-magic`.

To try it for one session without installing:

```bash
claude --plugin-dir ./cache-handoff --settings '{"pluginConfigs":{"cache-handoff@inline":{"options":{"enabled":true}}}}'
```

`claude plugin install ./cache-handoff` does not work: as of Claude Code 2.1.296, `install` only takes a plugin name from a marketplace.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns the mod on. When off, it registers no hooks. |
| `cacheTtlOverride` | empty | `5m` or `1h`. Empty follows Claude Code's own order: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then `5m`. |
| `generator` | `fork` | How the handoff is written; see Cost below. `haiku` is the alternative. |
| `timeoutSeconds` | `90` | How long to wait for the handoff before giving up and logging the failure. |

**Set `cacheTtlOverride` to `1h` if you are on a Claude subscription within plan usage and haven't set a TTL yourself.** Claude Code gives the main conversation a one-hour cache there, but a mod can't see your billing state. With nothing set, the mod assumes 5 minutes, so it writes the handoff early rather than late.

## What happens

**At the end of a turn** (the `Stop` or `TeammateIdle` hook), the mod notes the time and starts a timer for 30 seconds before the TTL runs out. The hook returns right away. Nothing runs on `UserPromptSubmit` or `PreToolUse`, and no model call waits on a turn. The `turn.start` hook only cancels the timer.

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

**On session start** (`startup` or `resume`), if `.claude/handoff.meta.json` is under 24 hours old, the mod asks:

> A handoff from 2026-10-10 19:50 UTC is available. 2 files were modified. Clear this session and load it?

- On a new session (`startup`), the offer covers a handoff from any earlier session. Yes sends the handoff as the first message.
- On a resumed session (`resume`), the offer appears only for that session's own handoff, and only when Claude Code reports its prompt cache likely expired. Yes runs `/clear`, then sends the handoff.

Each handoff is offered once. The question runs after the hook returns, so it never delays startup.

## Cost

The default generator, `fork`, uses `$.model.fork`. A fork replays the session's last request on the session's own model and appends the handoff instructions, so the API serves the existing context from the warm cache. Input bills at the cache-read rate, about 0.1× of normal input, and you pay full price only for the handoff text written. The fork's request also counts as a cache hit, which keeps the cache warm for another TTL.

The `haiku` generator calls `$.model.complete` with Haiku at high effort. **Haiku can't read this session's cache**, because each model has its own. That call sends a trimmed transcript: the first request plus the newest messages, up to about 400k characters (roughly 100k tokens), uncached. It costs less per token but sees less. A failed attempt early in a long session can fall outside what it reads. Use it when the fork's cache read on a very large context costs more than you want.

## API limits

These are limits of the mods API as of Claude Code 2.1.296:

- **No model choice on a cached fork.** `$.model.fork` takes only a prompt. It always runs on the session's model, with no effort, token cap, or timeout setting. The mod's timeout stops waiting but can't cancel the request. Since cache reads are tied to the model, a cheap model reading the session's cache isn't possible.
- **Mods don't receive the statusLine payload.** The statusLine's `prompt_cache.expires_at` goes only to the statusLine command. The mod computes the same expiry, one TTL after the turn's last response. Its internal `CacheSnapshot` uses the statusLine field names (`warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`).
- **The TTL can't be read.** The mod can read the TTL settings and environment variables, but not whether a subscription is drawing on usage credits, which switches the default from 1h to 5m. Hence the `cacheTtlOverride` option.
- **`$.fs` can't delete or rename.** A timestamp-named file per version would pile up with no way to prune it, so prior versions rotate through three fixed slots instead.
- **`$.fs.read` stops at 4 MiB.** For a transcript larger than that, the turn-ended check can't read the newest rows. It relies on the mod's own turn tracking from `turn.start` and `Stop`.
- **A fork can't call tools.** The working tree status in the handoff comes from one `git status` the mod runs itself through `$.process.run`, with a 3-second timeout.

The fallback of having the main agent write the handoff itself, through a reminder injected at `Stop`, isn't needed: `$.model.fork` covers the case without starting a turn.

## Develop

```bash
claude plugin validate --strict .
claude plugin test .
```

`tsc -p .` checks types against `.claude-plugin/types`, which Claude Code writes beside the mod when it loads it from your own folder.
