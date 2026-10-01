# knoware

A keyboard-first desktop app for running and steering coding agents, drawn as a 16-bit sci-fi world.

- **Planets** are repos (or plain directories).
- **Moons** are git worktrees.
- **Blobs** are agent sessions: they shimmer, grow with context, bounce when blocked, turn red and sad on failing CI, and slowly rot when their PR goes stale.

Agent-agnostic via the [Agent Client Protocol](https://agentclientprotocol.com) (Claude Code, Codex, and any other ACP agent). Planned as a Tauri app with a Rust backend.

## Status

Design stage. Nothing to install yet.

- [`docs/spec.md`](docs/spec.md) — the design spec.
- [`docs/backlog.md`](docs/backlog.md) — features to consider later (gaps vs. Conductor).
- [`prototypes/galaxy.html`](prototypes/galaxy.html) — interactive visual prototype. Open it in a browser and use the keyboard.
