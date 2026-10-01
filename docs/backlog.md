# Backlog — gaps vs. Conductor

Features Conductor has (as of v0.89, Sep 29 2026) that Knoware doesn't yet. Check the ones to pull into scope.

Already covered by the spec: worktrees (moons), several agents per branch, PR/CI status on blobs, blocked-agent attention + `Space` jump, Linear issue dots, resuming existing sessions, auto-cleanup of merged worktrees (setting).

**Suggested v1 shortlist:** 1, 4, 5, 8, 9, 14, 18, 23, 34.

## Workspace setup
- [ ] 1. Setup script per repo that runs when a moon is created (install deps, copy `.env`).
- [ ] 2. Run scripts (e.g. dev server) with their own ports per moon. *Running servers as lights on the moon.*
- [ ] 3. Archive script that runs before a moon is deleted.
- [ ] 4. Copy gitignored files (e.g. `.env`) into new worktrees automatically.
- [ ] 5. Create a moon from a branch, PR, GitHub issue, or Linear issue.
- [ ] 6. Auto-name the branch from the first prompt.
- [ ] 7. Sparse checkout for monorepos.

## Code review
- [ ] 8. Diff viewer: split/unified, `j`/`k` between files, mark as viewed.
- [ ] 9. Comments on diff lines, sent to the agent as feedback.
- [ ] 10. Edit code directly in the diff.
- [ ] 11. File viewer and search across files.
- [ ] 12. "Agent reviews this" action with a separate review model. *Reviewer blob with a different hat.*
- [ ] 13. One-click revert of a file or change.

## PRs and git
- [ ] 14. Create a PR from a moon (repo PR template, optional draft).
- [ ] 15. Commit and push / pull latest main without the agent.
- [ ] 16. Merge from the app: auto-merge when CI passes, merge-queue status.
- [ ] 17. GitHub review comments synced both ways, threads resolvable in-app. *Comments rain on the blob.*
- [ ] 18. Send failing CI to the agent as "fix this". *Sad red blob, one key.*
- [ ] 19. CI logs and job failure reasons in the app.
- [ ] 20. Merge conflict resolution with agent help.
- [ ] 21. Stacked PRs (`gh stack`, Graphite).
- [ ] 22. Deployment preview links (e.g. Vercel).

## Session control
- [ ] 23. Checkpoints with rewind: chat only, or chat + files.
- [ ] 24. Fork a chat or a whole moon from any point. *The blob splits in two.*
- [ ] 25. Plan-mode toggle.
- [ ] 26. Queue follow-ups, or steer mid-turn.
- [ ] 27. Stop-agent key.
- [ ] 28. Model and effort picker per blob.
- [ ] 29. Usage and rate-limit display.
- [ ] 30. Custom prompts per action (review, create PR, fix errors, resolve conflicts).

## Environment
- [ ] 31. Built-in terminal per moon.
- [ ] 32. Environment variables per workspace.
- [ ] 33. Manage MCP servers in the app.

## Notifications
- [ ] 34. System notifications that open the right session when clicked.
- [ ] 35. Completion sounds. *Blob noises: plip, squish, sad bloop on red CI.*
- [ ] 36. Dock badge and unread markers.

## Automation and remote
- [ ] 37. Scheduled and GitHub-triggered agents (Conductor's Routines).
- [ ] 38. Cloud workspaces that keep running with the laptop closed.
- [ ] 39. Sharing with teammates.
- [ ] 40. Mobile companion app.
- [ ] 41. Knoware's own MCP / CLI / API so agents can spawn blobs and moons.
- [ ] 42. Deep links that open a new moon or blob.

## Polish
- [ ] 43. ⌘K command palette.
- [ ] 44. Battery-aware: stop idle agent processes, keep the Mac awake while agents work.

Sources: [Conductor docs](https://www.conductor.build/docs), [release notes](https://releasebot.io/updates/conductor), [changelog](https://www.conductor.build/changelog).
