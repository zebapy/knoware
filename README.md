# knoware

A keyboard-first desktop app for running and steering coding agents, drawn as a 16-bit sci-fi world.

- **Planets** are repos (or plain directories).
- **Moons** are git worktrees.
- **Blobs** are agent sessions: they shimmer, grow with context, bounce when blocked, turn red and sad on failing CI, and slowly rot when their PR goes stale.

Agent-agnostic via the [Agent Client Protocol](https://agentclientprotocol.com) (Claude Code, Codex, and any other ACP agent). A Tauri app with a Rust backend.

![A planet view: a blob on a worktree moon is blocked on a permission request, shown in the session panel. The volcanic planet has a construction crane for its uncommitted diff and smoking factories from too many agents.](docs/screenshots/session.png)

![The galaxy view: each repo is a planet whose biome comes from its main language: volcanic Rust, jungle TypeScript, ocean Python, tundra Go, crystal Ruby, toxic C, a ringed gas giant for a polyglot repo, and barren rock for a plain folder.](docs/screenshots/galaxy.png)

## Run it

Needs Rust, Node 22+, pnpm, `git`, and (for PR/CI signals) the GitHub CLI `gh`, signed in. On Linux, also the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux).

```sh
pnpm install
pnpm tauri dev                          # run with hot reload
pnpm tauri build                        # build the app bundle
```

Checks: `pnpm typecheck`, `pnpm test`, and `cargo test` / `cargo clippy` in `src-tauri/`.

First launch: press `a` and give a path to a repo or folder. Press `?` in the app for every key.

## Keys

| Key | Action |
|---|---|
| Arrows | Move between planets, or blobs (most urgent first) |
| `Enter` | Zoom in / open session / focus the reply box |
| `Esc` | Zoom out one level |
| `Space` | Jump to the next blocked blob, across planets |
| `y` | Allow a blocked permission request (`1`–`9` picks any option) |
| `n` | Spawn a blob where focused (planet root or the selected blob's moon) |
| `Shift+N` | New moon (worktree) + blob on it |
| `Del` | Delete blob: shocked eyes, shake, shatter. `Esc` / `u` during the shake undoes it |
| `Shift+Del` | Delete the selected blob's moon (removes the worktree; again to force a dirty one) |
| `f` | Fork the selected session into a new blob |
| `s` | Stop the current turn |
| `w` | Wake a dormant blob (loads its session) |
| `a` | Add a planet |
| `r` | Refresh PR/CI signals and look for existing sessions |

Closing the window keeps agents running. The tray icon brings it back and bounces while anything is blocked.

## How it works

- **`src-tauri/src/agent.rs`** — the ACP client. Each blob gets its own agent subprocess (on its own thread) speaking ACP over stdio: `initialize`, `session/new` / `session/load` / `session/resume` / `session/fork`, `session/prompt`, `session/cancel`. Permission requests park until you answer. `session/list` discovers sessions you already have; they're placed on a planet by working directory and appear dormant.
- **`src-tauri/src/signals.rs`** — polls `gh pr list` per repo planet and joins PRs to blobs by branch. CI state comes from the status-check rollup. Linear-style issue keys in branch names (e.g. `eng-142`) become amber dots. Also keeps moons in sync with `git worktree list`, and runs the optional auto-cleanup of merged, clean moons.
- **`src-tauri/src/world.rs`** — planets, moons, blobs, settings. Persisted as JSON.
- **`src/render.ts`** — the pixel renderer, ported from [`prototypes/galaxy.html`](prototypes/galaxy.html).
- **`src/model.ts`** — the rules for how a blob looks: palette, mood, dormancy, decay, urgency order.

## Planets

Every planet is generated from its directory, so the same repo always becomes the same world. The app surveys each planet (`src-tauri/src/survey.rs`) for its dominant language (by tracked file extensions), file count and commit count. `src/biome.ts` turns that, plus a hash of the path, into a look:

| Dominant language | Biome |
|---|---|
| Rust | volcanic: basalt, lava seas, glowing cracks |
| TypeScript, JavaScript | jungle: continents, oceans, clouds |
| Python | ocean world: islands, heavy cloud |
| Go | tundra: ice, crevasses, polar snow |
| Java/Kotlin, C#, PHP | desert: dunes, canyons, craters |
| Ruby, Elixir, Swift, Haskell | crystal: faceted, sparkling |
| C, C++, Zig | toxic swamp: glowing acid pools |
| Shell, or no language over 35% | gas giant: turbulent bands, a storm |
| Plain folders, docs-only repos | barren rock: craters |

Unknown languages get a biome picked from the path's hash. Bigger repos are bigger planets. Repos with 1,000+ commits wear rings. Spin speed, axial tilt, terrain and clouds all come from the path's hash.

### Work on the surface

- **Construction:** uncommitted work in a planet's root checkout or a moon's worktree appears as construction on it. This is `git diff HEAD` plus untracked files, polled every few seconds. Under 40 changed lines shows cones, under 400 shows scaffolding, and more shows a crane swinging a load. Hover a planet or moon to see `+/−` lines, file counts and the biggest changed files. The session panel shows the same diff for the selected blob's checkout.
- **Pollution:** a planet root or moon with too many agents (`crowdedAt`, default 4) grows factories with smoking chimneys, a smog belt, and a brown haze over its surface. These get worse as more agents pile on.

## Settings

`settings.json` in the app's config dir (`~/.config/knoware/` on Linux, `~/Library/Application Support/knoware/` on macOS) is written with defaults on first launch:

```json
{
  "agents": {
    "claude": { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp@latest"] },
    "codex": { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp@latest"] }
  },
  "defaultAgent": "claude",
  "dormantAfterHours": 2,
  "sessionDecayStartDays": 2,
  "sessionDecayFullDays": 14,
  "prDecayStartDays": 3,
  "prDecayFullDays": 21,
  "autoCleanupMergedMoons": false,
  "worktreeRoot": "~/.knoware/worktrees",
  "signalsPollSecs": 60,
  "diffPollSecs": 8,
  "crowdedAt": 4
}
```

Any ACP agent can be added under `agents`. [`scripts/mock-agent.mjs`](scripts/mock-agent.mjs) is a fake agent for trying the app without spending tokens: add `"mock": { "command": "node", "args": ["/path/to/scripts/mock-agent.mjs"] }` and set `"defaultAgent": "mock"`.

## Docs

- [`docs/spec.md`](docs/spec.md) — the design spec.
- [`docs/backlog.md`](docs/backlog.md) — features to consider later (gaps vs. Conductor).
- [`prototypes/galaxy.html`](prototypes/galaxy.html) — the original visual prototype.
