# Knoware — design spec

A keyboard-first desktop control surface for running and steering coding agents, rendered as a 16-bit sci-fi world of shimmering blobs, planets, and moons.

Status: design settled via grilling session (Oct 1, 2026). Prototypes built inline in chat.

---

## Architecture

- **App:** Tauri desktop app.
  - Rust backend acts as the **ACP client** (Agent Client Protocol), using the `agent-client-protocol` crate.
  - Renderer is a pixel-art canvas web UI.
- **Agent-agnostic:** any ACP agent works.
  - Claude Code and Codex run via their ACP adapters (npm packages, spawned as subprocesses over stdio).
  - Requires Node on the machine.
- **Background:** closing the window does not kill agents. The app lives in the tray/menu bar with a blob icon that bounces when something is blocked.
- **Signals layer** (separate from ACP): PR + CI state from GitHub, issue links from Linear. Joined to blobs by branch and working directory.
- **Early risk to check:** canvas pixel rendering and palette cycling in the macOS WebKit webview.

## World model

| Thing | Meaning |
|---|---|
| Galaxy | All planets |
| Planet | Git repo root, or the working directory if not in a repo (like a terminal cwd) |
| Moon | A git worktree (= one branch), orbiting its planet |
| Blob | An agent session; lives on a planet (root checkout) or orbits a moon (worktree) |

- Several blobs can share a moon (e.g. builder + reviewer on one branch).
- Non-repo planets (e.g. `~/notes`) have no moons and no PR/CI signals.
- **Session sources:**
  - Spawned from the app.
  - Discovered via ACP `session/list` (placed on a planet by cwd) and resumed with `session/load`. Discovered sessions appear dormant.
  - If a session looks live elsewhere, offer **fork from here** instead of resume.
- **Moons persist** until deleted. Deleting a moon plays the explosion and drops its blobs to the planet root as dormant.
- **Auto-cleanup setting** (default off): merged + clean moons fall into the planet and their worktree is removed. A dirty worktree stays and wobbles.

## Blob visuals

- 16-bit, faceless, eyes only. Moody sci-fi palette: flat colors, palette-cycling shimmer (4-tone ramp sliding diagonally). Slow animations.
- **Shape:** wavy edges by default.
  - Working: waves travel faster.
  - Dormant: waves nearly still.
  - Decaying: sags toward goop.
- **Size:** context used.
- **Color / mood:**
  - Teal: working.
  - Purple: PR open, CI running.
  - Green + happy eyes: CI passing.
  - Red + sad eyes (with a tear): CI failing.
  - Amber: blocked.
- **Sub-agents:** smaller trailing blobs.
- **Linked issues:** small amber dots attached to the body.
- **Labels** (pixel font):
  - Default: session name, about 12 characters.
  - Focused or blocked: last message or command, about 24 characters.
  - Hidden at galaxy level (planet names only).

### Attention (two tiers)

1. **Blocked:** ACP permission request. Bounce + `!` speech bubble. First in the `Space` queue.
2. **Your turn:** turn ended. Quiet pose, eyes looking up. No bounce.

No heuristic "question" tier, so the bounce stays trustworthy.

### Time states

- **Waiting:** your turn, recently.
- **Dormant:** asleep with z's, after about 2 hours idle. Also the state for discovered sessions.
- **Decay:** two clocks; the blob shows whichever is worse. Greying, crumbling pixels, sagging, a fly circling.

| Clock | Measures | Decay starts | Fully crumbled |
|---|---|---|---|
| Session | time since last activity | 2 days | 14 days |
| PR | time since last push or review | 3 days | 21 days |

- Merged or closed PRs stop the PR clock.
- All thresholds are settings.

## Interaction (fully keyboard navigable)

Zoom levels: **galaxy → planet → session**.

| Key | Action |
|---|---|
| Arrows | Move between planets (galaxy) or blobs (planet, in stable slots, urgency order) |
| `Enter` | Zoom in / open session |
| `Esc` | Zoom out one level |
| `Space` | Jump to the next blocked blob, across planets |
| `n` | Spawn a blob where focused (planet root or the selected blob's moon) |
| `Shift+N` | New moon (worktree) + blob on it |
| `Del` | Delete blob: shocked eyes → shake → shatter |
| `Esc` / `u` during shake | Undo delete |
| `y` | Allow a blocked permission request |

- **Session view:** split panel. The world stays visible on the left; the session (messages, actions, reply) is on the right.
- **Edge markers:** pulsing markers at the screen edge point to blocked blobs on other planets.
- **Delete animation:** shocked eyes, shake that builds, then the blob shatters into pixel chunks that drift away. No fire. The tether snaps back to the planet. The shock + shake window (~2.3s) is the undo window.

## Open questions

- **Sub-agent data:** where it comes from. ACP only exposes sub-agents as tool calls.
- **Agent types:** whether they look different (hats, eye shapes).
- **Notifications:** system notifications beyond the tray icon.
- **Settings:** how per-project settings are exposed.

## Other ideas from brainstorming (not yet decided)

- **Molting:** context compaction makes the blob shrink and leave a husk.
- **Review comments:** rain down as droplets; unread ones stick to the blob.
- **File collisions:** two agents on the same files bump into each other and look annoyed.
- **Finished sub-agents:** absorb back into the parent with a "plip."
- **Wrap-up:** a merged + closed session becomes a ghost that floats off, or joins a gravestone garden.
- **Broken main:** a failing main branch or deploy gives its planet stormy weather.
