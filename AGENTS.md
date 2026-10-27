# Working on Trace

Instructions for AI coding agents (Codex reads this file; Claude Code reads it through `CLAUDE.md`) and for people new to the code. Read this first, then the doc for your task.

## What this is

**Trace** (formerly *AI Coding Hub*) is an Electron desktop app for Windows and macOS. It runs the real **Claude Code** and **Codex** CLIs, plus plain shells, in up to eight "channels" side by side. Each channel is a terminal or a chat view. Around the channels it adds:
- Git review
- usage and cost tracking
- shared rules and handoff memory for both agents
- sync between computers
- a phone web app reached over Tailscale

Trace has no model API client and never touches credentials: the CLIs own sign-in, models, permissions and tools.

- **Source:** this repository, `KGeary1995/Coding-Hub` (private). The package name is still `ai-coding-hub`.
- **Downloads and update feed:** `KGeary1995/trace-releases` (public; release files only).
- **Version:** `package.json` `version`. Release notes for the next or current release are in `docs/RELEASE_NOTES.md`.

## Where to read next

| Task | Read |
|---|---|
| Understand how it fits together | [docs/architecture.md](docs/architecture.md) |
| Build, run, test | [docs/development.md](docs/development.md) |
| Package, sign, publish | [docs/windows-releases.md](docs/windows-releases.md) (covers Mac too) |
| Something is broken | [docs/troubleshooting.md](docs/troubleshooting.md) |
| What a feature does for users, data locations | [docs/reference.md](docs/reference.md) |
| Visual design and tokens | [docs/design/trace/README.md](docs/design/trace/README.md) |
| All docs, and which are historical | [docs/README.md](docs/README.md) |

## Commands

```sh
npm ci                 # Node >= 22.13 (node:sqlite); postinstall checks node-pty
npm run dev            # app with reload
npm run typecheck      # renderer + host
npm test               # vitest (unit)
npm run test:release   # release/packaging invariants
npm run test:memory    # memory MCP server over stdio
npm run test:pty       # real PTY
npm run test:desktop   # end-to-end smoke (needs a display; xvfb + CODING_HUB_TEST_NO_SANDBOX=1 on Linux)
npm run build          # typecheck + renderer + phone + host
```

Before you call a change done, run `typecheck`, `test` and the smoke test nearest your change. On Windows without Developer Mode, about four symbolic-link tests fail with `EPERM`; that's expected. Report results honestly, including flaky or skipped checks.

## Map

- `electron/main.ts`: startup, IPC `handle()`, the launch pipeline (`prepareLaunch`), shutdown
- `electron/preload.ts`: the `window.codingHub` bridge. Channel names are written out literally
- `electron/services/`:
  - `cli/` (PTYs, launch flags, attention hooks)
  - `chat/` (chat channels)
  - `hub/` (rules, MCP config, memory, sync, telemetry; the `hub` request dispatcher is in `service.ts`)
  - `storage/`, `remote/` (phone, Tailscale, linked computers), `repository/` (files, Git, worktrees), `workbench/`, `updates/`, `design/`, `coaching/`
- `src/`: React 18 renderer. zustand stores in `state/`, side effects in `runtime/`, UI in `components/`, `screens/`, `shell/`
- `shared/`: contracts used by both sides (`ipc.ts`, `hub.ts`, `types.ts`, `schemas.ts`, `chat.ts`) and pure logic
- `phone/`: phone PWA. `scripts/`: build, packaging, smoke tests, fixture CLI. `.github/workflows/`: CI and releases

## Rules that keep it working

1. **The renderer is untrusted.** Every native call goes through `handle()` in `main.ts` (sender check, zod validation, `HostResult`). Don't expose Node, arbitrary paths or arbitrary executables to the renderer. To add a channel, update `shared/ipc.ts` and `electron/preload.ts`, and register it with `handle()`.
2. **Throw `HubError(code, message)`** on the host, with a message a person can act on. Other errors become a generic `HOST_ERROR` on purpose.
3. **Never write a user's config with plain `fs` writes.** Use `readConfig`/`updateConfig` (`electron/services/hub/config.ts`): hash check, backup, atomic replace, unknown fields kept.
4. **The order of launch arguments matters.** In `prepareLaunch`, Claude's `--mcp-config` must stay last, because it takes a list. A Claude run's `runId` is also its `--session-id`.
5. **Don't rename legacy identifiers:**
   - `~/.coding-hub`, the `AI Coding Hub` profile and install folders
   - the `AI-Coding-Hub-*` Drive folders, the `coding-hub:` IPC prefix, `window.codingHub`
   - the `coding-hub-memory` MCP server, `CODING_HUB_*` variables, the `ai-coding-hub` package and app ID

   Installs, synced computers and project configs depend on them.
6. **Memory notes are immutable.** They live in `memory/<key>/<uuid>.json` and are written to a temp file and renamed. The key comes from `projectMemoryKey()` (based on the Git origin), and sync is additive.
7. **Context:** Codex reports a window (`limit > 0`). Claude reports only the tokens in use (`limit: 0`). Never guess a Claude window, and keep every ratio behind `limit > 0`.
8. **Platforms:** Windows `kill()` takes no signal. Stop process trees with `stop-process.ts`. Never signal PID 0.
9. **Long-running jobs** must block updates and backups (`hasSessions`, `readyForBackup` in `main.ts`).
10. **Match the code style:** dense lines, short `/** … */` comments that explain why, named exports, plain-sentence UI text ("Trace", "channels").

## Releasing (summary)

1. `npm version <x.y.z> --no-git-tag-version`, and rewrite `docs/RELEASE_NOTES.md`. It becomes the public release description.
2. Merge to `main` through a PR, and wait for **CI** and **Windows release candidate** to pass on the merge commit. Release doesn't check this. Windows runners sometimes time out in heavy tests: rerun the failed job once (`gh run rerun <id> --failed`), and investigate if it fails again.
3. Push the tag on the exact commit that passed: `git tag v<x.y.z> <sha> && git push origin v<x.y.z>`. That starts **Release**, which builds Windows and both Mac disk images and publishes them all to `trace-releases` as `Trace-<x.y.z>-…`. A manual run (`gh workflow run release.yml --ref main -f publish=true`) also works, but it builds whatever `main` holds when it starts, so don't merge anything else in between. A published version is never replaced.

Windows installs update themselves from that feed. Macs download new versions from the downloads page.

## Shared memory for agents working here

When you run inside Trace, recent handoff notes are added to your context, and the `coding-hub-memory` tools (`read_memory`, `write_handoff`) are available. Write a handoff before you finish: decisions, files changed, checks run, what's left, blockers. Never include credentials or raw logs.
