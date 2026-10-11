# AGENTS.md

Cache Magic is a Claude Code mod. It ships as this repository; a session that loads it has none of these files. Do not mention this file, or any path in this repo, from the handoff, the questions, or the welcome line.

## Product contract

The cheap moment is a warm prompt cache. The mod writes `.claude/cache-magic/handoff.md` about 30 seconds before that cache expires, for sessions of at least 50k tokens. It writes again on `session.compact` (idle compaction, threshold compaction, and `/compact`) before the summary replaces the thread, and tells the summary where the file is. A precompute and a subagent compaction are ignored.

Idle compaction being on, which is Anthropic's default, does not stop the mod. It only stops the clear.

- A five-minute cache can clear the session and send the late prompt after the handoff. Idle compaction never runs on a five-minute cache.
- A one-hour cache leaves the session in place unless `idleCompaction` or `autoCompactEnabled` is `false`. `idleCompaction: true` does not mean the feature is on; the server switch decides that. The only settings signal is the opt-out, `false`.
- An assumed TTL never clears. A guess must not throw away a warm cache.

The first turn over 50k tokens asks, in `$.ui.ask`, what to keep and who writes it. The answer is stored immediately and written to `/config` on a later `session.start`, one row per start, because `$.config.set` reloads the module and cancels the idle timer. Dismissing the first question keeps the defaults and does not ask again. Dismissing the writer question leaves the configured writer alone.

Quoted instructions are copied from the transcript. The model is told not to paraphrase them.

## Layout

`hooks/logic.ts` is pure: TTL resolution, the trigger decision, what a handoff keeps, and whether a cold prompt may clear the session. `hooks/register.ts` is the only module that touches `$`. A function that receives `$` is declared at the top of that file. The hooks loader refuses `$` passed to a closure.

`tests/cache-magic.test.ts` is the behavior. `claude plugin test .` runs it. `claude plugin validate --strict .` checks the manifest and the hook calls.

## Checks

```bash
claude plugin validate --strict .
claude plugin test .
```

`tsc -p .` typechecks against `.claude-plugin/types`, which Claude Code writes beside the mod when it loads this folder. Those types are not committed.
