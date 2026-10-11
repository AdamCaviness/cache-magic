# Cache Magic

Claude Code mods that keep large sessions from paying for a cold prompt cache.

## Plugins

- **[cache-handoff](cache-handoff/README.md)**: a Claude Code mod. When a large session sits idle, it writes a structured handoff while the prompt cache is still warm, then offers to load it once the cache has gone cold. Off by default.

## Install

```bash
claude plugin install cache-handoff --marketplace adamcaviness/cache-magic --config enabled=true
```

From a local clone, use `--marketplace ./` instead. See the [cache-handoff README](cache-handoff/README.md) for configuration, cost, and API limits.

## License

MIT
