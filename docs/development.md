# Development

How to build, run and test Trace from source. [architecture.md](architecture.md) explains how the code fits together, and [windows-releases.md](windows-releases.md) covers packaging and publishing. Problems are in [troubleshooting.md](troubleshooting.md).

## Prerequisites

| Need | Why |
|---|---|
| **Node.js 22.13 or later** (CI pins 22.16.0) | `engines` requires it. Host code and Vitest use `node:sqlite` (`DatabaseSync`), so an older Node fails `npm test` |
| **Git** | Git review, worktrees and most smoke tests create real repositories |
| **Windows** | Nothing extra: node-pty ships ConPTY binaries. Use `npm.cmd` in PowerShell if script execution is restricted. Turn on **Developer Mode** if you want the symbolic-link tests to run; without it they are skipped |
| **macOS** | Xcode Command Line Tools. Mac packaging only runs on macOS |
| **Linux** | Python 3, make, a C/C++ compiler and Electron's GTK/NSS/X11 libraries; xvfb for the GUI smoke tests |
| **Claude Code / Codex** (optional) | Only to use real channels. Every automated test uses the fixture CLI `scripts/fixtures/interactive-cli.cjs` |

## Setup and run

```sh
npm ci           # postinstall downloads Electron and test-loads node-pty (scripts/check-native.cjs)
npm run dev      # host + phone build, Vite on 127.0.0.1:5173, Electron with reload
npm start        # full production build, then electron . --production
npm run dev:web  # renderer only in a browser: no host, no live channels
```

If node-pty fails to load (a channel shows Failed with `The terminal process could not start`), run `npm run rebuild:native`.

To keep a development copy away from your real data, set `CODING_HUB_STORAGE_DIR` to an absolute path. A new storage folder has no saved preferences, so on Windows its notes still go to your real Google Drive folder (`G:\My Drive\Coding Hub`) until you choose another in Settings: to prevent that, also set `CODING_HUB_DEFAULT_DRIVE_DIR` to a scratch folder. An empty value means no folder, but PowerShell and cmd cannot set an empty variable (they remove it instead); Git Bash (`CODING_HUB_DEFAULT_DRIVE_DIR= npm run dev`) and Node can. Electron's profile can be moved with `--user-data-dir=<dir>`.

## Build outputs

| Output | Produced by | Notes |
|---|---|---|
| `dist/` | `vite build` | The renderer. The build injects a CSP meta tag that must match the CSP in `electron/main.ts` |
| `dist/phone/` | `npm run build:phone` | The phone PWA, served by `RemoteServer` |
| `dist-electron/` | `npm run build:host` (`tsc -p tsconfig.electron.json`, CommonJS) | Host entry `dist-electron/electron/main.js`, including `services/hub/memory-server.js` |
| `release/` | `dist:win` | `Trace-<v>-Windows-x64-Setup.exe`, its blockmap, `-Portable.exe`, `latest.yml`, `last-build.json`. Each attempt stages in `release/.build-<id>/`, which is never deleted, so clear old ones by hand |
| `release/mac/` | `dist:mac` | `Trace-<v>-macOS-{arm64,x64}.dmg` and `.zip`, `latest-mac.yml`. Deleted and rebuilt each run. `TRACE_MAC_OUTPUT` names another folder, which is emptied only if it is under `release/`, new, empty or an earlier Mac build |

Packages contain exactly `dist/`, `dist-electron/`, `package.json` and `node_modules`. ASAR is off and node-pty isn't rebuilt (`npmRebuild: false`), because node-pty needs real file paths and ships Node-API prebuilds.

## Scripts

| Script | What it does | Needs a display |
|---|---|---|
| `typecheck` | `tsc --noEmit` for the renderer (`tsconfig.json`: `src`, `shared`, `phone`), the host (`tsconfig.electron.json`) and the host tests (`tsconfig.test.json`) | no |
| `typecheck:tests` | `tsc --noEmit -p tsconfig.test.json`: the host tests (`electron/**/*.test.ts`), `scripts/lib/*.test.ts` and `vitest.setup.ts`, which Vitest runs without checking. The last step of `typecheck`, and a script of its own | no |
| `test` | `vitest run`: unit tests next to the code (`*.test.ts(x)`), node environment, no DOM | no |
| `test:release` | `node --test scripts/release-paths.node-test.cjs`: artifact names, versions, staging, workflow invariants | no |
| `test:pty` | Real PTY start, input, resize and stop under Electron-as-Node | no |
| `test:memory` | The memory MCP server over stdio: negotiation, tools, malformed input, persistence | no |
| `test:desktop` | Largest end-to-end smoke: PTYs, restore, unavailable storage, files, Git review, usage, MCP, skills, Drive mirror, rules, help, and that the application menu has no Reload, Force Reload or Close Window item (Ctrl+R / Ctrl+W, Cmd on a Mac) | yes |
| `test:design`, `test:profiles`, `test:workbench`, `test:enterprise`, `test:productivity`, `test:models-stability`, `test:remote` | Feature smoke tests (layout at several sizes, Claude profiles, coaching, diagnostics/verification, Git delivery and backups, model catalog and crash recovery, phone pairing) | yes |
| `test:tables` | Round Table seats, end to end, against stand-in CLIs (`scripts/fixtures/table-seats-cli.cjs`) that log what they receive: the setup panel (seats, names, instructions, who edits), changing the seats of an open table, saved tables under **Yours**, a hierarchy with a second reviewer and no final reviewer, and a table seated again after a restart. `TABLE_SMOKE_SHOTS=<folder>` keeps a screenshot of each stage. Runs in CI (Linux) and in the Windows release candidate. | yes |
| `test:screen` | A linked computer's screen through noVNC against a stand-in screen-sharing server: sign-in, picture, lock note, keys, reconnecting | yes |
| `test:screen-service` | Windows only: the screen service started with `--screen-service`, a second Trace showing it, restarts after crashes. Reads the real screen; input goes to a log | yes |
| `test:paste` | Windows only: Ctrl+V and Alt+V with an image or text on the real system clipboard, in a terminal channel and a chat channel (records what reaches the CLI) | yes |
| `test:packaged -- <executable>` | Starts a fixture CLI inside a packaged app | yes |
| `test:install` | Windows install → upgrade → uninstall with data checks. Only on CI (`GITHUB_ACTIONS=true`) or with `--isolated-windows-vm`, because it changes system registration | yes |
| `build` | typecheck, renderer, phone, host | no |
| `node scripts/gpu-crash-smoke.cjs` (after `build`) | Windows only: crashes the GPU process of a built app with hardware acceleration on, then checks on the real screen that the window still paints | yes |
| `node scripts/design-tour.cjs <outDir>` (after `build`, or `--dev` against a running Vite) | Screenshots Trace in use, for checking the design: a throwaway Git project (`scripts/lib/tour-project.cjs`) with a modified, a staged and an untracked file; fixture Claude Code and Codex (terminal and Round Table chat, started through the setup panel) plus a real shell; a waiting and a failed channel, every menu, overlay and view with content, long views as `-a`, `-b`, … to the bottom, and a short list again at 1100×800 (`-1100`) and with Higher contrast (`-contrast`). The shot list is at the top of the script. No real agent CLI starts. Home, Claude/Codex/GitHub config and the Drive folder point into the temp folder; `--real-usage` keeps the real home so Usage shows your numbers (the screenshots then hold personal data, and the Terminal channel's two commands go into your own shell history). `--only=word,…`, `--size=WxH` (the page's size, so every shot's: 1440×900 by default), `--visible`. A shot waits for a state's entry animation (the three blinks of a waiting or failed channel) to end. About a minute | yes |
| `npx electron scripts/make-icon.cjs --disable-gpu` | Draws the app icon (the amber keycap, relit for Midnight; see `docs/design/trace/DECISIONS.md`) in a hidden Electron window and writes `assets/icon.png` (1024), `assets/icon.ico` (256 to 16) and the phone's `phone/public/icon-512.png`, `icon-192.png` and `apple-touch-icon.png`. The top bar (`TraceMark.tsx`) and the phone (`phone/main.ts`) draw the same keycap themselves: change all three together | yes |
| `node scripts/real-round-table-check.cjs <outDir>`, `real-hierarchy-check.cjs <outDir>`, `real-table-seats-check.cjs <outDir>`, `codex-reviewer-memory-check.cjs` | Manual checks with the real Claude Code and Codex CLIs on your own logins (they use some of your plans). Never in CI. The scratch project and Trace data are removed at the end; the log and screenshots stay in `<outDir>` | yes (not the Codex one) |
| `dist:win`, `dist:win:signed`, `dist:mac`, `verify:win` | Package and verify. See [windows-releases.md](windows-releases.md) | no |
| `rebuild:native` | `npm rebuild node-pty` | no |

The smoke scripts remove their temporary folder with `removeFolder` (`scripts/lib/cleanup.cjs`): it retries for about 5 s while a process the test started still holds the folder, then leaves it with a warning instead of throwing, so the test's own failure is the one printed. Unit tests get a scratch backup folder for each test file (`vitest.setup.ts`), removed when that file's tests end. The `test:<feature>` scripts all run `npm run build` first. They launch Electron through Playwright's `_electron`, with an isolated `--user-data-dir`, `CODING_HUB_STORAGE_DIR`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and with the fixture CLI standing in for `claude` and `codex`. A fresh storage folder has no `preferences.json`, and on Windows Trace then mirrors notes into `G:\My Drive\Coding Hub`: where that folder exists, test notes and session summaries reached the developer's real Google Drive. So the scripts that start Trace (all but the two named below) spread `NO_DRIVE` (`scripts/lib/no-drive.cjs`) into Trace's environment and `vitest.setup.ts` sets the same variable, `CODING_HUB_DEFAULT_DRIVE_DIR=` (empty): it replaces the default folder of a computer with no saved preferences (`defaultDriveDirectory` in `electron/services/hub/preferences.ts`; empty means none). A test that syncs saves a temporary folder of its own. Add `NO_DRIVE` to any new script that starts Trace. Two scripts do not spread it: `scripts/design-tour.cjs` writes a `preferences.json` that names a temporary Drive folder instead, and `scripts/gpu-crash-smoke.cjs` does not set it yet (it opens no project and writes no note). A build from before the variable ignores it: the install smoke's baseline release, or an older packaged app given to `packaged-smoke.cjs`, still uses the default folder. In unit tests the variable covers a `HubService` without saved preferences only; `DEFAULT_PREFERENCES.driveDirectory` (`shared/hub.ts`) is still the Windows folder, so a test that builds preferences from it must set `driveDirectory` itself. On restricted Linux runners, set `CODING_HUB_TEST_NO_SANDBOX=1` (test-only; it adds `--no-sandbox --disable-gpu --disable-dev-shm-usage`) and run under `xvfb-run -a`. `CODING_HUB_*_SCREENSHOT` variables make individual smokes save screenshots. `CODING_HUB_TEST_DESKTOP_IDLE=<seconds>` (test-only) sets how long the computer counts as idle, which decides whether a phone gets its own channel size; the remote smoke sets it.

Smoke scripts that start a Round Table use `startTable(page, item, setup)` from `scripts/lib/navigate.cjs`: **+ Channel → Round Table** (or `Round Table (hierarchy)`) opens the seat setup panel (`dialog.table-setup`), so it runs `setup(panel)` if given, then presses **Start Round Table**.

Never start the GUI with `ELECTRON_RUN_AS_NODE` set: it makes Electron behave as plain Node.

## What CI runs

| Workflow | When | What |
|---|---|---|
| `ci.yml` (**CI**, ubuntu) | every PR, pushes to main | `npm ci`, `test`, `test:release`, `build`, then the desktop, design, profiles, workbench, enterprise, productivity, models-stability, remote and screen smokes under xvfb, then the memory server and real PTY checks (`memory-smoke.cjs`, `run-pty-smoke.cjs`; Electron as Node, no display) |
| `windows-release.yml` (**Windows release candidate**) | nightly on main when it changed, ready PRs labeled `windows`, manual | `test`, `test:release`, seven smokes (desktop, design, profiles, workbench, enterprise, productivity, models-stability), the paste smoke, `dist:win`, a legacy-named 1.2.0 baseline, `test:install`. Uploads installers except on PRs |
| `release.yml` (**Release**) | `v*` tags, or manual on main with **Publish** | Windows: `test` + `dist:win`, with a warning when there is no signing certificate. Mac: `test`, `test:pty`, `dist:mac`, packaged smoke (arm64). Then publish: refused unless **Windows release candidate** passed on the same commit, then publishes to `KGeary1995/trace-releases` with `RELEASES_TOKEN` |
| `signed-release.yml` | manual | Signed Windows build and install test with certificate secrets. Never publishes |

Every job has a time limit (`timeout-minutes`: 30 for CI, 60 for the Windows jobs, 90 for the Mac release job, which waits on notarization), so a hung test stops instead of running for GitHub's default six hours. The actions are pinned to commit hashes. The remote, screen and screen-service smokes don't run on Windows in any workflow, and `test:screen-service` and the GPU crash smoke run nowhere automatically: run them yourself when you change that code.

## Verifying a change

1. `npm run typecheck`
2. `npm test` (on Windows without Developer Mode, the symbolic-link tests are skipped, so an `EPERM` failure is a real one)
3. The smoke test closest to what you changed, for example `test:memory` for memory, `test:pty` for PTY code, `test:desktop` for the bridge, channels or storage, and `test:remote` for the phone
4. For launch arguments or hooks, check against a real CLI. Run `claude --version` and `codex --version`, and test the flags the host passes. Trace gates features on CLI versions (for example `supportsHttpHooks` in `electron/services/cli/attention.ts`)
5. Update `docs/reference.md`, which is the behaviour reference users read, and this folder if you changed how things are built or fit together

## Conventions

- **Style:** match the surrounding code. Files are dense, with many statements on one line, and comments are short `/** … */` notes saying *why*, often about a race or user-visible behaviour. Exports are named.
- **Host errors:** throw `HubError(code, message)` (`electron/services/cli/engine-adapter.ts`) with a message a person can act on. It reaches the renderer as `{ ok: false, error }`. Never let raw error text cross IPC.
- **Renderer:** check `result.ok`, or use `hubCall`, which throws. Panels use `useOperation()` for busy, error and notice state.
- **User files:** edit them only through `readConfig` / `updateConfig` (`electron/services/hub/config.ts`). That keeps a backup, does an atomic replace and refuses to overwrite a file that changed since it was read.
- **UI text:** plain sentences. The product is **Trace**; sessions are **channels**.
- **Legacy names:** don't rename them. See the list in [architecture.md](architecture.md#names-that-must-not-change).
