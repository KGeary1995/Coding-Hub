# Architecture

Trace (formerly AI Coding Hub) is an Electron app. A sandboxed React renderer draws the UI. The Electron main process (the "host") owns every native capability: processes, files, Git, SQLite, network listeners. The CLIs it runs (Claude Code, Codex, a plain shell) own model access, sign-in, permission prompts and tools. **Trace has no model API client and never handles credentials.**

Line numbers below are for orientation. Check them against the code, which moves faster than this page.

```text
renderer (src/, sandboxed)  ── window.codingHub (preload) ──►  host (electron/main.ts + electron/services/)
        ▲   zustand stores                                     │   node-pty / pipes ──► claude, codex, shell
        └── session, usage, chat… events ◄─────────────────────┘   loopback HTTP ◄── Claude hooks, phone, linked computers
phone/ (PWA, no framework) ── HTTPS via Tailscale serve ──► RemoteServer (127.0.0.1:47821)
shared/  typed contracts and pure logic used by both sides
```

## Repository layout

| Path | What lives there |
|---|---|
| `electron/main.ts` | Startup, window, IPC registration (`handle()`), launch pipeline (`prepareLaunch`), shutdown |
| `electron/preload.ts` | The `window.codingHub` bridge. Channel names are written out literally, because a sandboxed preload can't import project modules |
| `electron/services/cli/` | Engine discovery, launch flags (`engine-adapter.ts`, also home of `HubError`), `pty-manager.ts`, process-tree stop, account logins, Claude profiles, Codex model catalog, `attention.ts` (approval alerts) |
| `electron/services/chat/` | Chat channels: `claude-stream.ts` (stream-json), `codex-stream.ts` (app-server protocol), `chat-process.ts` (pipes, no PTY), `transcript.ts` |
| `electron/services/storage/` | `WorkspaceStorage` (`storage.db`, run logs), `HostHealth` |
| `electron/services/hub/` | The `hub` request dispatcher (`service.ts`), MCP/skills/plugins config (`config.ts`), shared rules, memory (`memory.ts`, `memory-server.ts`, `auto-memory.ts`), Drive mirror, device sync, telemetry/usage, plan limits |
| `electron/services/remote/` | Phone server, Tailscale, linked computers, web push, screen mirror |
| `electron/services/repository/` | File browsing, Git status/diff, project checks, project setup (clone), worktrees |
| `electron/services/workbench/` | Backups and restores, delivery (commit/push/PR), workflows, tasks, experiments, verification, live preview, diagnostics, native session lists |
| `electron/services/{coaching,design,updates}/` | AI coaching, design archive and handoff import, Windows auto-update |
| `src/` | React renderer. See [Renderer](#renderer) |
| `phone/` | Phone web app, built to `dist/phone` |
| `shared/` | Types and pure logic shared by host and renderer (`ipc.ts`, `hub.ts`, `types.ts`, `chat.ts`, `schemas.ts`, `terminal-input.ts`, `help-content.ts`, …) |
| `scripts/` | Build, packaging and smoke-test scripts. See [development.md](development.md) |
| `docs/design/trace/` | The visual design hand-off (tokens, prototypes, decisions) |

## Host process

### Startup (`electron/main.ts`)

1. **Paths:**
   - The storage root is `CODING_HUB_STORAGE_DIR` or `~/.coding-hub`.
   - An activated backup restore can redirect it to `restores/<uuid>` (`resolveStorageRoot` in `services/workbench/backups.ts`).
   - `userData` is forced to `appData/AI Coding Hub`, the legacy name kept on purpose so profiles survive the rename.
2. **Services built at module load:** Claude profiles, plan limits, account logins, native sessions, model catalog, repository files/Git, `AttentionServer`, and `PtyManager` with its launch hooks.
3. **Packaged Mac:** adopt the login shell's `PATH`, so CLIs installed by Homebrew/npm are found.
4. **`requestSingleInstanceLock()`** (line 328), then `whenReady` (329):
   - offer to trash a leftover `AI Coding Hub.app` (Mac)
   - start the attention endpoint
   - HostHealth and local crash dumps (`crash-dumps/`, never uploaded)
   - `WorkspaceStorage`
   - `HubService` + `TelemetryService`, which are **optional**: built in try/catch, so `hub` may be null
   - `AutoMemory`, design archive, coaching, diagnostics, verification, tasks, experiments, live preview, backups, delivery, workflows
   - `RemoteServer`, Tailscale polling, linked computers
   - IPC handlers, the window, `updates.start()`

**Shutdown:** `before-quit` (line 619) flushes the workspace, stops processes (with a "still running" dialog listing PIDs), gives auto-memory summaries up to 10 s (`autoMemory.drain`), then closes every service.

**Workspace flush:** main sends `workspace-flush`, and the renderer answers with `finishWorkspaceFlush(workspace)` within 2 s.

### IPC

- **Bridge:** `contextBridge.exposeInMainWorld('codingHub', …)` in `electron/preload.ts`. The type is `CodingHubHost` in `shared/ipc.ts`, and channel names (`coding-hub:*`) are in `IPC_CHANNELS` (`shared/ipc.ts:108`).
- **Every handler goes through `handle()`** (`main.ts`). It does three things:
  - `assertSender` (line 229) checks that the caller is the main window's main frame at the exact app URL
  - payloads are validated with zod
  - results are wrapped as `HostResult`: `{ ok: true, value } | { ok: false, error: { code, message } }`
- **Errors:** `HubError(code, message)` becomes `{ code, message }`. A `ZodError` becomes `INVALID_REQUEST`. Anything else becomes a generic `HOST_ERROR`, so messages never leak internals.
- **Dispatchers:** two big ones take tagged requests.
  - `hub`: `electron/services/hub/service.ts`, `hubRequestSchema` and `execute()`. It handles rules, inventory/MCP/extensions, memory, Drive, device sync, preferences and usage.
  - `workbench`: `main.ts`, routed by action prefix. It handles runtime, plan limits, `remote-*`, `linked-*`, `flow-*`, `native-*`, `verification-*`, `task-*`, `experiment-*`, `backup-*`, `preview-*`.
  - Other channels are direct: sessions, chat, workspace, Git/files, accounts, projects, updates, designs, coaching.
- **Host → renderer events:** `session-event`, `chat-event`, `usage`, `update-status`, `account-event`, `storage-error` (also used for notices), `linked-event`, `remote-control`, `workspace-flush`.

**Adding an IPC channel:** add it to `IPC_CHANNELS` and `CodingHubHost` in `shared/ipc.ts`, write the literal string and method in `electron/preload.ts`, and register it with `handle()` in `main.ts`. A long-running job should also block updates and backups. Add it to `hasSessions` / `readyForBackup`.

### Launching a channel, end to end

1. **Renderer:** `startSession` (`src/runtime/use-native-host.ts`) calls `window.codingHub.startSession`.
2. **Host checks:** it refuses during a pending update restart, or while the Claude profile is signing in.
3. **`PtyManager.start`** (`electron/services/cli/pty-manager.ts`):
   - validates the request and the 8-channel limit (`MAX_CHANNELS` in `shared/schemas.ts`)
   - refuses to resume a conversation that is already open
   - real-paths the cwd and discovers the engine
   - builds arguments with `buildLaunch`
4. **`prepareLaunch`** (`main.ts`, about line 116) adds, in order:
   1. the shared-rules check (`rules.verifyLaunch`)
   2. telemetry: Claude gets `--session-id <runId>`, so **a Claude run's runId is its conversation ID**; Codex gets `--config log_dir=…`
   3. approval alerts: Claude (version 2.1.63 or later) gets `--settings` with HTTP `Notification`, `PostToolUse` and `Stop` hooks pointing at the loopback `AttentionServer`; Codex gets OSC 9 notification config
   4. memory (`AutoMemory.prepare`): Claude gets `--append-system-prompt` (recent notes) and `--mcp-config`. **`--mcp-config` takes a list, so it must stay last.** Codex gets `developer_instructions` (merged after the user's own) and `mcp_servers.coding-hub-memory.*`. A project that installed its own `coding-hub-memory` is used instead; stale program paths are repaired, and a different memory key is reported.
5. **Spawn:**
   - Terminal channels use node-pty. Output is batched (16 ms / 32 KB) with flow control: pause above 1 MB unacknowledged, resume below 256 KB.
   - Chat channels use plain pipes and a JSON protocol, so raw writes and phone input are refused.
   - `shell` channels skip every agent feature and aren't recorded.
6. **While it runs:**
   - Output goes to `logs/<runId>.log`, the renderer and the phone.
   - `TelemetryService` polls the CLI's own transcript every 750 ms:
     - Claude: `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`, respecting `CLAUDE_CONFIG_DIR`
     - Codex: rollouts under `~/.codex/sessions/YYYY/MM/DD/`, respecting `CODEX_HOME`
   - It enforces `maxSessionTokens`. If telemetry can't start while a token limit is set, the run is stopped, not left unenforced.
7. **On exit:** telemetry finalizes, and auto-memory writes a session-summary note (new git status lines, commits, the agent's last message).

### Approval alerts ("HOLD")

1. Claude Code's `Notification` hook with type `permission_prompt` or `elicitation_dialog`, or Codex's OSC 9 notification, calls `PtyManager.notifyAttention`.
2. That sends an `attention` event, and the tile shows HOLD.
3. HOLD clears on:
   - a real keystroke in that channel typed after the alert (`clearAttention`, `src/state/workspace-store.ts`; terminal replies are filtered by `isPersonInput`)
   - input from a paired phone
   - for Claude, a `PostToolUse` or `Stop` hook to `<hook url>/resolved` (`notifyResolved`), whose body is never read

Each run's hook URL carries a 32-byte secret, checked with `timingSafeEqual`.

### Usage and context

`electron/services/hub/telemetry.ts` turns transcript events into `UsageRecord`s, deduplicated by message ID and stored in `telemetry/usage.db` for 366 days.

**Context (`UsageRecord.context`):**
- **Codex** reports its window: `{ used, limit }` drives the percentage, the limit state (80% or more) and budgets.
- **Claude** records only the amount in use: `{ used, limit: 0 }`, where used = input + cache reads + cache writes + output of the latest reply.
- Every consumer requires `limit > 0` before computing a ratio. Keep it that way, and don't invent a Claude window.

### Shared memory

- **Notes:** immutable JSON files at `memory/<projectKey>/<uuid>.json`, written to a temp file and renamed (`memory.ts`).
- **Keys:** `projectMemoryKey(dir)` (`auto-memory.ts`) is `<repo>-<hash of the normalized origin>` for Git clones, so every clone and worktree shares one key, or `<folder>-<hash of the path>` otherwise.
- **The MCP server:** `memory-server.ts` is a standalone stdio MCP server (`read_memory`, `write_handoff`), launched with the app's own executable and `ELECTRON_RUN_AS_NODE=1`. Its arguments are the memory root and a key.
- **Sync:** additive. Drive mirror at `<drive>/AI-Coding-Hub-Memory/<key>/`. Conflicting IDs keep both files and pause for review.

### Security boundaries

- **Main window:**
  - `sandbox`, `contextIsolation`, no `nodeIntegration`
  - new windows and navigation denied, all permission requests rejected
  - a CSP header, matched by a meta tag that `vite.config.ts` injects at build
- **Paths:** the renderer never names arbitrary paths or executables. Repository reads refuse symbolic links and stay inside the project. Memory, design and handoff code refuse links and `..`.
- **Config edits** (`hub/config.ts` `updateConfig`):
  - check a hash of what was inspected
  - keep unknown fields
  - write a private `.coding-hub-backup-<uuid>` and replace the file atomically
  - TOML comments may be normalized
- **Loopback listeners:**
  - attention endpoint: random port, per-run secret
  - `RemoteServer`: `127.0.0.1:47821`, with Host/Origin checks and paired device keys (only hashes stored). Tailscale `serve` publishes it on the tailnet only after a consent dialog.
  - linked computers: only `*.ts.net` HTTPS addresses
  - web push: allow-listed push hosts only
- **Secrets on disk:** `remote-push.json` (VAPID private key) and linked-computer keys. Backups use an allowlist and exclude credentials.

### Updates

- **Library:** `electron/services/updates/update-service.ts` wraps electron-updater with automatic download and install turned off.
- **Schedule:** it checks 30 s after start, then every 4 h. Download and install are separate user actions, and install requires no running work plus a successful workspace flush.
- **Platforms:** enabled only for an installed (NSIS) Windows build with `resources/app-update.yml`. Mac, portable and source builds offer "Open downloads page".
- **Feed:** GitHub releases of `KGeary1995/trace-releases` (`electron-builder.cjs`, `shared/updates.ts`).

## Renderer

- **Stack:**
  - React 18 + TypeScript, built by Vite 6 (`base: './'`, dev server on `127.0.0.1:5173`)
  - zustand 5 stores, `react-grid-layout` for the channel grid, `lucide-react` icons
  - xterm 6 with the fit and WebGL addons. WebGL is opt-in through the `terminalWebGL` preference.
  - **Styling:** plain CSS with `--tr-*` custom properties (`src/tokens.css`, `styles.css`, `shell.css`, `tile.css`, `screens.css`, `views.css`, `workbench.css`). Tailwind is installed but effectively unused.
  - **Fonts:** IBM Plex Sans Condensed and Plex Mono, bundled. `src/main.tsx` waits for Plex Mono before rendering, because terminals measure their cells when created.
- **Navigation:** `App.tsx` switches on `useWorkspaceStore().activeView` (`NavigationView` in `src/state/workspace-store.ts`):
  - `workspace` → `SessionGrid` (+ `WorkspaceExplorer`)
  - `history` → `SessionHistory`
  - `files`/`diff` → `RepositoryPanel`
  - `computer` → `screens/LinkedComputerView`
  - everything else → `components/FeaturePanel.tsx`, which lazy-loads screens. `HubPanels.tsx` holds the MCP, skills, memory and settings panels; `screens/UsageScreen.tsx` holds usage.
  - The shell around every view is `shell/Topbar`, `shell/StatusBar` and `shell/Toasts`.
- **A channel tile** (`components/SessionTile.tsx`, design sheet 08): header with state chip, `ctx` and `tok`, then `tile/ScopeStrip.tsx`, then `TerminalViewport.tsx` or `chat/ChatView.tsx`.
- **Channel state** (`src/state/channel-state.ts`): idle, starting, working, waiting (HOLD), limit, finished or failed.
- **State:** `src/state/` holds zustand stores and pure helpers:
  - `workspace-store` holds sessions, tiles and views, and `applyEvent(SessionEvent)`
  - `hub-store` holds usage, preferences and `hubCall`
  - also chat, account, linked computers, plan limits, activity
- **Side effects:** `src/runtime/` holds them:
  - `use-native-host.ts` wires every host event once and exports `startSession`/`stopSession`
  - `terminals.ts` holds the xterm instances, ordered input and paste
- **Calling the host:** use `window.codingHub.<method>()` and check `result.ok`, or `hubCall<T>(request)`, which unwraps the result and throws `Error(message)`. Without `window.codingHub` (`npm run dev:web`), the UI renders but can't start sessions.
- **Persistence:** the workspace auto-saves when its JSON changes. Saves are refused until the workspace has loaded.

## Phone app

`phone/` is a framework-free TypeScript PWA (`main.ts`, `api.ts`, `public/sw.js`), built by `vite.phone.config.ts` into `dist/phone`. It reuses `src/tokens.css`, the terminal theme and the `shared/remote.ts` types.

**Serving:** `RemoteServer` serves it, and Tailscale HTTPS exposes it on the tailnet.

**Pairing and API:**
- The phone pairs with a code (`POST /api/pair`) and keeps a bearer token.
- `/api/stream` is server-sent events (`channels`, `output`, `replay`, `resize`). There are also `/api/input`, `/api/size` and `/api/alerts` (Web Push).
- If the computer that served the phone is off, it can talk to sibling computers directly.

## Data on the user's machine

| Path (under the storage root, normally `~/.coding-hub`) | Contents |
|---|---|
| `storage.db` | SQLite (WAL). Tables `workspace` (one saved snapshot) and `runs` (`status`, `recordedBytes`, `logTruncated`, …). Runs left `running` after a crash are marked interrupted, and PIDs are never reattached |
| `logs/<runId>.log` | Terminal output: 5 MiB per run, 100 runs, 30 days. See [troubleshooting](troubleshooting.md) for stale sizes on Windows |
| `telemetry/usage.db`, `telemetry/<runId>/` | Usage records; Codex log directories |
| `memory/<key>/<uuid>.json`, `auto-memory/` | Handoff notes; per-run `--mcp-config` scratch files |
| `preferences.json`, `shared-rules.json`, `updates.json`, `host-health.json` | Preferences, the rules source, update checks, lifecycle events |
| `machine.json`, `device-sync.json`, `linked-computers.json`, `remote*.json` | Sync identity and state, linked computers, phone server, devices, push keys |
| `worktrees.json`, `worktrees/`, `designs/`, `coaching/`, `tasks.json`, `verification.json`, `experiments.json`, `backups/`, `restores/`, `crash-dumps/` | Feature data |
| `claude-profiles/` | Named Claude profiles (labels; credentials stay with Claude Code) |

**Outside the root:**
- The Electron profile: `%APPDATA%\AI Coding Hub` or `~/Library/Application Support/AI Coding Hub`.
- The Drive folders `AI-Coding-Hub-Memory` and `AI-Coding-Hub-Sync`.
- A project's own `.mcp.json`, `.codex/config.toml`, `CLAUDE.md` and `AGENTS.md`, which change only on explicit installs.

## Names that must not change

These are deliberate leftovers from "AI Coding Hub". Existing installs, synced computers and project configs depend on them:
- the `ai-coding-hub` package name and app ID
- the `AI Coding Hub` profile folder and Windows install folder
- `~/.coding-hub`
- the `AI-Coding-Hub-*` Drive folders
- the `coding-hub:` IPC prefix and `window.codingHub`
- the `coding-hub-memory` MCP server name
- `CODING_HUB_*` environment variables

`scripts/product.cjs` holds the installed name (`Trace`) and the legacy one.
