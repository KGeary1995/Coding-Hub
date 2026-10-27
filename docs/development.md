# Development

How to build, run and test Trace from source. [architecture.md](architecture.md) explains how the code fits together, and [windows-releases.md](windows-releases.md) covers packaging and publishing. Problems are in [troubleshooting.md](troubleshooting.md).

## Prerequisites

| Need | Why |
|---|---|
| **Node.js 22.13 or later** (CI pins 22.16.0) | `engines` requires it. Host code and Vitest use `node:sqlite` (`DatabaseSync`), so an older Node fails `npm test` |
| **Git** | Git review, worktrees and most smoke tests create real repositories |
| **Windows** | Nothing extra: node-pty ships ConPTY binaries. Use `npm.cmd` in PowerShell if script execution is restricted. Turn on **Developer Mode** if you want the symbolic-link tests to pass |
| **macOS** | Xcode Command Line Tools. Mac packaging only runs on macOS |
| **Linux** | Python 3, make, a C/C++ compiler and Electron's GTK/NSS/X11 libraries; xvfb for the GUI smoke tests |
| **Claude Code / Codex** (optional) | Only to use real channels. Every automated test uses the fixture CLI `scripts/fixtures/interactive-cli.cjs` |

## Setup and run

```sh
npm ci           # postinstall downloads Electron and test-loads node-pty (scripts/check-native.cjs)
npm run dev      # host + phone build, Vite on 127.0.0.1:5173, Electron with reload
npm start        # full production build, then electron . --production
npm run dev:web  # renderer only in a browser: no host, no sessions
```

If node-pty fails to load (`FAULT: The terminal process could not start`), run `npm run rebuild:native`.

To keep a development copy away from your real data, set `CODING_HUB_STORAGE_DIR` to an absolute path. Electron's profile can be moved with `--user-data-dir=<dir>`.

## Build outputs

| Output | Produced by | Notes |
|---|---|---|
| `dist/` | `vite build` | The renderer. The build injects a CSP meta tag that must match the CSP in `electron/main.ts` |
| `dist/phone/` | `npm run build:phone` | The phone PWA, served by `RemoteServer` |
| `dist-electron/` | `npm run build:host` (`tsc -p tsconfig.electron.json`, CommonJS) | Host entry `dist-electron/electron/main.js`, including `services/hub/memory-server.js` |
| `release/` | `dist:win` | `Trace-<v>-Windows-x64-Setup.exe`, its blockmap, `-Portable.exe`, `latest.yml`, `last-build.json`. Each attempt stages in `release/.build-<id>/`, which is never deleted, so clear old ones by hand |
| `release/mac/` | `dist:mac` | `Trace-<v>-macOS-{arm64,x64}.dmg`. Deleted and rebuilt each run |

Packages contain exactly `dist/`, `dist-electron/`, `package.json` and `node_modules`. ASAR is off and node-pty isn't rebuilt (`npmRebuild: false`), because node-pty needs real file paths and ships Node-API prebuilds.

## Scripts

| Script | What it does | Needs a display |
|---|---|---|
| `typecheck` | `tsc --noEmit` for the renderer (`tsconfig.json`: `src`, `shared`, `phone`) and the host (`tsconfig.electron.json`) | no |
| `test` | `vitest run`: unit tests next to the code (`*.test.ts(x)`), node environment, no DOM | no |
| `test:release` | `node --test scripts/release-paths.node-test.cjs`: artifact names, versions, staging, workflow invariants | no |
| `test:pty` | Real PTY start, input, resize and stop under Electron-as-Node | no |
| `test:memory` | The memory MCP server over stdio: negotiation, tools, malformed input, persistence | no |
| `test:desktop` | Largest end-to-end smoke: PTYs, restore, unavailable storage, files, Git review, usage, MCP, skills, Drive mirror, rules, help | yes |
| `test:design`, `test:profiles`, `test:workbench`, `test:enterprise`, `test:productivity`, `test:models-stability`, `test:remote` | Feature smoke tests (layout at several sizes, Claude profiles, design and coaching, diagnostics/verification/preview, Git delivery and backups, model catalog and crash recovery, phone pairing) | yes |
| `test:paste` | Windows only: Ctrl+V and Alt+V with an image or text on the real system clipboard, in a terminal channel and a chat channel (records what reaches the CLI) | yes |
| `test:packaged -- <executable>` | Starts a fixture CLI inside a packaged app | yes |
| `test:install` | Windows install → upgrade → uninstall with data checks. Only on CI (`GITHUB_ACTIONS=true`) or with `--isolated-windows-vm`, because it changes system registration | yes |
| `build` | typecheck, renderer, phone, host | no |
| `dist:win`, `dist:win:signed`, `dist:mac`, `verify:win` | Package and verify. See [windows-releases.md](windows-releases.md) | no |
| `rebuild:native` | `npm rebuild node-pty` | no |

The `test:<feature>` scripts all run `npm run build` first. They launch Electron through Playwright's `_electron`, with an isolated `--user-data-dir`, `CODING_HUB_STORAGE_DIR`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and with the fixture CLI standing in for `claude` and `codex`. On restricted Linux runners, set `CODING_HUB_TEST_NO_SANDBOX=1` (test-only; it adds `--no-sandbox --disable-gpu --disable-dev-shm-usage`) and run under `xvfb-run -a`. `CODING_HUB_*_SCREENSHOT` variables make individual smokes save screenshots. `CODING_HUB_TEST_DESKTOP_IDLE=<seconds>` (test-only) sets how long the computer counts as idle, which decides whether a phone gets its own channel size; the remote smoke sets it.

Never start the GUI with `ELECTRON_RUN_AS_NODE` set: it makes Electron behave as plain Node.

## What CI runs

| Workflow | When | What |
|---|---|---|
| `ci.yml` (**CI**, ubuntu) | every PR, pushes to main | `npm ci`, `test`, `test:release`, `build`, then the desktop, design, profiles, workbench, enterprise, productivity, models-stability and remote smokes under xvfb |
| `windows-release.yml` (**Windows release candidate**) | pushes to main, ready PRs, manual | `test`, `test:release`, seven smokes (not remote), `dist:win`, a legacy-named 1.2.0 baseline, `test:install`. Uploads installers except on PRs |
| `release.yml` (**Release**) | `v*` tags, or manual on main with **Publish** | Windows: `test` + `dist:win`. Mac: `test`, `test:pty`, `dist:mac`, packaged smoke (arm64). Then publishes to `KGeary1995/trace-releases` with `RELEASES_TOKEN` |
| `signed-release.yml` | manual | Signed Windows build and install test with certificate secrets. Never publishes |

`test:pty` and `test:memory` don't run in CI except `test:pty` on the Mac release job. Run them yourself when you change PTY handling or the memory server.

## Verifying a change

1. `npm run typecheck`
2. `npm test` (on Windows without Developer Mode, the symbolic-link tests fail with `EPERM`; that's expected)
3. The smoke test closest to what you changed, for example `test:memory` for memory, `test:pty` for PTY code, `test:desktop` for the bridge, sessions or storage, and `test:remote` for the phone
4. For launch arguments or hooks, check against a real CLI. Run `claude --version` and `codex --version`, and test the flags the host passes. Trace gates features on CLI versions (for example `supportsHttpHooks` in `electron/services/cli/attention.ts`)
5. Update `docs/reference.md`, which is the behaviour reference users read, and this folder if you changed how things are built or fit together

## Conventions

- **Style:** match the surrounding code. Files are dense, with many statements on one line, and comments are short `/** … */` notes saying *why*, often about a race or user-visible behaviour. Exports are named.
- **Host errors:** throw `HubError(code, message)` (`electron/services/cli/engine-adapter.ts`) with a message a person can act on. It reaches the renderer as `{ ok: false, error }`. Never let raw error text cross IPC.
- **Renderer:** check `result.ok`, or use `hubCall`, which throws. Panels use `useOperation()` for busy, error and notice state.
- **User files:** edit them only through `readConfig` / `updateConfig` (`electron/services/hub/config.ts`). That keeps a backup, does an atomic replace and refuses to overwrite a file that changed since it was read.
- **UI text:** plain sentences. The product is **Trace**; sessions are **channels**.
- **Legacy names:** don't rename them. See the list in [architecture.md](architecture.md#names-that-must-not-change).
