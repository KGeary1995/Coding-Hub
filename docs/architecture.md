# Architecture

Trace (formerly AI Coding Hub) is an Electron app. A sandboxed React renderer draws the UI. The Electron main process (the "host") owns every native capability: processes, files, Git, SQLite, network listeners. The CLIs it runs (Claude Code, Codex, a plain shell) own model access, sign-in, permission prompts and tools. **Trace has no model API client and never handles credentials.**

Places in the code are named by function rather than line number, because the lines move faster than this page.

```text
renderer (src/, sandboxed)  ── window.codingHub (preload) ──►  host (electron/main.ts + electron/services/)
        ▲   zustand stores                                     │   node-pty / pipes ──► claude, codex, shell  
        └── session, usage, chat… events ◄─────────────────────┘   loopback HTTP ◄── Claude hooks, phone, linked computers
phone/ (PWA)               ── HTTPS via Tailscale serve ──► RemoteServer (127.0.0.1:47821)
shared/  typed contracts and pure logic used by both sides
```

## Repository layout

| Path | What lives there |
|---|---|
| `electron/main.ts` | Startup, window, IPC registration (`handle()`), launch pipeline (`prepareLaunch`), shutdown |
| `electron/preload.ts` | The `window.codingHub` bridge. Channel names are written out literally, because a sandboxed preload can't import project modules |
| `electron/services/cli/` | Engine discovery, launch flags (`engine-adapter.ts`, also home of `HubError`), `pty-manager.ts`, process-tree stop, account logins, Claude profiles, Codex model catalog, `attention.ts` (approval alerts) |
| `electron/services/chat/` | Chat channels: `claude-stream.ts` (stream-json), `codex-stream.ts` (app-server protocol), `chat-process.ts` (pipes, no PTY), `transcript.ts`. A reply's end is the `done` event, which Round Tables, tasks and automatic handoffs act on. A reply Claude Code starts by itself, when a background task of its own finishes and tells it so, ends with `settled` instead: for the conversation's display only (it closes the reply and its "is working" line), unless a reply Trace asked for is still owed |
| `electron/services/storage/` | `WorkspaceStorage` (`storage.db`, run logs), `HostHealth` |
| `electron/services/hub/` | The `hub` request dispatcher (`service.ts`), MCP/skills/plugins config (`config.ts`), shared rules, memory (`memory.ts`, `memory-server.ts`, `auto-memory.ts`), Drive mirror, device sync, telemetry/usage, plan limits |
| `electron/services/remote/` | Phone server, Tailscale, linked computers, web push, screen mirror |
| `electron/services/repository/` | File browsing, Git status/diff, project checks, project setup (clone), worktrees |
| `electron/services/workbench/` | Backups and restores, delivery (commit/push/PR), workflows, tasks, experiments, verification, diagnostics, native session lists |
| `electron/services/{coaching,design,updates}/` | AI coaching, Claude Design handoff import (host side only; no window uses it until the planned Claude tab), Windows auto-update |
| `src/` | React renderer. See [Renderer](#renderer) |
| `phone/` | Phone web app, built to `dist/phone` |
| `shared/` | Types and pure logic shared by host and renderer (`ipc.ts`, `hub.ts`, `types.ts`, `chat.ts`, `schemas.ts`, `terminal-input.ts`, `help-content.ts`, …) |
| `scripts/` | Build, packaging and smoke-test scripts. See [development.md](development.md) |
| `docs/design/midnight/` | The visual design specification (Midnight): tokens, shared parts, rules for changing a screen |
| `docs/design/trace/` | The earlier design hand-off and prototypes (historical), and `DECISIONS.md` |

## Host process

### Startup (`electron/main.ts`)

1. **Paths:**
   - The storage root is `CODING_HUB_STORAGE_DIR` or `~/.coding-hub`.
   - An activated backup restore can redirect it to `restores/<uuid>` (`resolveStorageRoot` in `services/workbench/backups.ts`).
   - `userData` is forced to `appData/AI Coding Hub`, the legacy name kept on purpose so profiles survive the rename.
2. **Services built at module load:** Claude profiles, plan limits, account logins, native sessions, model catalog, repository files/Git, `AttentionServer`, and `PtyManager` with its launch hooks.
3. **Packaged Mac:** adopt the login shell's `PATH`, so CLIs installed by Homebrew/npm are found.
4. **`requestSingleInstanceLock()`**, then `whenReady`:
   - offer to trash a leftover `AI Coding Hub.app` (Mac)
   - start the attention endpoint
   - HostHealth and local crash dumps (`crash-dumps/`, never uploaded)
   - `WorkspaceStorage`
   - `HubService` + `TelemetryService`, which are **optional**: built in try/catch, so `hub` may be null
   - `AutoMemory`, handoff import, coaching, diagnostics, verification, tasks, experiments, backups, delivery, workflows
   - `RemoteServer`, Tailscale polling, linked computers
   - IPC handlers, the window, `updates.start()`

**Shutdown:** `before-quit` flushes the workspace, stops processes (with a "still running" dialog listing PIDs), gives auto-memory summaries up to 10 s (`autoMemory.drain`), then up to 5 s for the Drive syncs those summaries started (`hub.drain`), saves `DayUsage`, then closes every service. An update restart drains the same way before the installer takes over (`prepareRestart`). If Trace is opened again while it quits (`second-instance`, or `activate` from a Mac's Dock or Finder), it relaunches once it has quit (`reopenAfterQuit`), except during an update install or a Restart.

**Startup failure:** any error in `whenReady` records `host-start-failed` in host health and, if no window was made, shows "Trace could not start" and quits.

**Application menu (`applicationMenu`):** Trace sets its own menu: Edit, and View with zoom and full screen (DevTools only in source runs); on a Mac also the app menu and Window. There is no Reload, Force Reload or Close Window, so Ctrl+R / Ctrl+W (Cmd on a Mac) cannot reload or close the window and stop every channel. On Windows and Linux the menu stays hidden until Alt is pressed. `scripts/desktop-smoke.cjs` checks that the menu has no Reload, Force Reload or Close Window item and no Ctrl+R / Ctrl+W accelerator, then presses the keys as well.

**Main window:** `backgroundThrottling: false`, so terminals keep processing output while the window is hidden or minimized. `document.visibilityState` can therefore stay `visible` while the window is minimized.

**Workspace flush:** main sends `workspace-flush`, and the renderer answers with `finishWorkspaceFlush(workspace)` within 2 s.

### IPC

- **Bridge:** `contextBridge.exposeInMainWorld('codingHub', …)` in `electron/preload.ts`. The type is `CodingHubHost` in `shared/ipc.ts`, and channel names (`coding-hub:*`) are in `IPC_CHANNELS` (`shared/ipc.ts`).
- **Every handler goes through `handle()`** (`main.ts`). It does three things:
  - `assertSender` checks that the caller is the main window's main frame at the exact app URL
  - payloads are validated with zod
  - results are wrapped as `HostResult`: `{ ok: true, value } | { ok: false, error: { code, message } }`
- **Errors:** `HubError(code, message)` becomes `{ code, message }`. A `ZodError` becomes `INVALID_REQUEST`. Anything else becomes a generic `HOST_ERROR`, so messages never leak internals.
- **Dispatchers:** two big ones take tagged requests.
  - `hub`: `electron/services/hub/service.ts`, `hubRequestSchema` and `execute()`. It handles rules, inventory/MCP/extensions, memory, Drive, device sync, preferences and usage. `memory-write-many` saves 1 to 100 notes in order with one Drive sync per project (a Round Table's findings); if one fails, `MEMORY_PARTIAL` says how many were saved first. `rules-forget` removes a registered project whose folder no longer exists from the shared-rules registry, and touches no file in any project.
  - `workbench`: `main.ts`, routed by action prefix. It handles runtime, plan limits, `host-health`, `remote-*`, `linked-*`, `flow-*`, `native-*`, `verification-*`, `task-*`, `experiment-*` and `trial-*` (including `experiment-delete`, which removes its trials, and `trial-delete`), `backup-*`, `preview-*`. `channel-transcript` returns a channel's conversation from its CLI's own transcript; `channel-task-transcript` (`sessionId`, `mark`) returns one task's part of it, from the task's prompt to the next task's prompt (the prompt is searched for backwards through up to 256 MB, 1 MB at a time, without holding the process; the reply is the last 200 messages from at most the 8 MB before the next task's prompt, or the end; `taskHistory` in `chat/transcript.ts`), or null. `mark` must be a send mark (`Task t-<8 hex>:`); the window falls back to `channel-transcript` when the host refuses it. `flow-open-link` opens only http and https links (`webLink` in `shared/schemas.ts`; errors `LINK_SCHEME`, `LINK_INVALID`).
  - Other channels are direct: sessions, chat, workspace, Git/files, accounts, projects, updates, designs, coaching, and `coding-hub:window-health` (`reportWindowHealth`): the window's stall reports, `{ kind: long-task | stall | context-lost | context-restored, ms?, detail? }`, zod-validated and taken at most 10 a minute.
- **Host → renderer events:** `session-event`, `chat-event`, `usage`, `update-status`, `account-event`, `storage-error` (also used for notices), `linked-event`, `remote-control`, `workspace-flush`.

**Adding an IPC channel:** add it to `IPC_CHANNELS` and `CodingHubHost` in `shared/ipc.ts`, write the literal string and method in `electron/preload.ts`, and register it with `handle()` in `main.ts`. A long-running job should also block updates and backups. Add it to `busyJobs()` in `main.ts` (the one check the self-updater, `prepareRestart` and the Mac install-script update use) and to `readyForBackup`.

**Install-script update (`scriptUpdate`):** while an update a linked computer started through the Mac install script downloads, starting channels, accounts, projects, project checks and project tools are refused with `UPDATE_RUNNING`, and workflow changes (Git delivery, applying a template) with `WORKFLOW_BUSY` (`workflowReady`); everything else keeps working. The flag clears when the script exits (`startMacUpdate` returns its `ChildProcess`) or after 15 minutes.

**Stall labels:** main-process work is named for the stall record with `timed(label, run)` (`electron/services/storage/host-health.ts`); names only, and only synchronous work is timed. `handle()` labels every IPC request. See [troubleshooting](troubleshooting.md#trace-stops-responding-for-a-moment) for the labels.

### Launching a channel, end to end

1. **Renderer:** `startSession` (`src/runtime/use-native-host.ts`) calls `window.codingHub.startSession`.
2. **Host checks:** it refuses during a pending update restart, or while the Claude profile is signing in.
3. **`PtyManager.start`** (`electron/services/cli/pty-manager.ts`):
   - validates the request and the 8-channel limit (`MAX_CHANNELS` in `shared/schemas.ts`)
   - refuses to resume a conversation that is already open
   - real-paths the cwd and discovers the engine
   - builds arguments with `buildLaunch`
4. **Before the arguments are finished**, `PtyManager` waits for its `beforeLaunch` hook (`AutoMemory.ready`), at most 3 s, ignoring errors. For an agent channel that awaits `hub.syncProject(memoryKey)` for up to 1.5 s (`SYNC_BEFORE_LAUNCH_MS`), so notes another computer wrote seconds ago are in the starting context, and reads the project's notes without holding the main process.
5. **`prepareLaunch`** (`main.ts`) adds, in order:
   1. the shared-rules check (`rules.verifyLaunch`)
   2. telemetry: Claude gets `--session-id <runId>`, so **a Claude run's runId is its conversation ID**; Codex gets `--config log_dir=…`
   3. approval alerts: Claude (version 2.1.63 or later) gets `--settings` with HTTP `Notification`, `PostToolUse` and `Stop` hooks pointing at the loopback `AttentionServer`; Codex gets OSC 9 notification config
   4. memory (`AutoMemory.prepare`): Claude gets `--append-system-prompt` (recent notes) and `--mcp-config`. **`--mcp-config` takes a list, so it must stay last.** Codex gets `developer_instructions` (merged after the user's own) and `mcp_servers.coding-hub-memory.*`. A project that installed its own `coding-hub-memory` is used instead; stale program paths are repaired, and a different memory key is reported.
   5. channel tools, when **Settings → Preferences → Let agents see and message other channels** is on (1.33.0, off by default): `ChannelTools.register` gives the run its own secret loopback address (`electron/services/cli/channel-tools.ts`, which also says which run is asking), and the `trace-channels` MCP server (`electron/services/hub/channel-server.js`, given that address in `CODING_HUB_CHANNEL_TOOLS_URL`) joins Claude's `--mcp-config` list (a file under `<storage>/channel-tools`, removed when the run ends) or Codex's `mcp_servers.trace-channels.*`. Unlike the memory server it talks to Trace. Codex keeps asking before each call.
6. **Spawn:**
   - Terminal channels use node-pty. Output is batched (16 ms / 32 KB) with flow control: pause above 1 MB unacknowledged, resume below 256 KB.
   - Chat channels use plain pipes and a JSON protocol, so raw writes and raw phone typing are refused; phones and linked computers send chat requests instead (`PtyManager.chatRemote`), and every chat event also goes to the remote's streams (`RemoteServer.onChat`, with a bounded per-channel replay).
   - `shell` channels skip every agent feature and aren't recorded.
   - `isAgentConfig()` marks the agent configs: Claude, Codex and Gemini CLI (`agy`), which have a model, permissions, resume and notices. `isChatEngineConfig()` marks Claude and Codex, the only ones with chat channels, shared memory, tasks and per-run usage; `isChatRun()` marks any run driven through its protocol rather than a terminal (a chat channel, or a Gemini CLI seat at a Round Table: `agy acp`, `GeminiStream`, from 1.28); Gemini CLI's usage by day comes from its conversation files (`gemini-usage.ts`, read by `DayUsage`); `shell` is the only other channel type. A Gemini channel is a terminal: notices come from agy's OSC 7501 status in its output (`GeminiStatusReader`), and its conversation from the line agy prints as it quits or from agy's own list (`gemini-conversations.ts`, read only). Trace 1.20's fixed Gemini seat is gone: `legacyWorkspaceSchema` still reads a workspace that holds one, and `migrateWorkspace` (`shared/workspace-migration.ts`) drops it on load (a Gemini seat named in a table's `seats`, as 1.28 writes, stays), in the host (`WorkspaceStorage.loadMigrated`) and in the window (`hydrate`); 1.19's Gemini channels load as they are. A Round Table is a set of seats, each one a chat channel (see below). At a hierarchy table `ReviewChains` gives the plan once per task to each challenger in turn (`challenging`), the planner answers (`plan-responding`), and the person approves (`plan-review`).
   - **Round Table seats (from 1.26):** `shared/table-seats.ts` is the model and its rules, used by the host, the window and the phone. A table has 2 to 8 seats (`MIN_SEATS`, `MAX_SEATS`); each seat is a CLI process and counts toward `MAX_CHANNELS`. A seat is an agent (Claude Code, Codex or, as a seat that reviews or plans, Gemini CLI: `SeatEngine`, `GEMINI_SEAT_RULE`) and a model (both belong to its chat channel), plus a name, instructions of the person's own and, at a hierarchy (`TableKind`), duties (`plan`, `challenge`, `build`, `review`, `final`). `checkSeats` is the one place that says whether seats make a table: a discussion needs only the count; a hierarchy needs exactly one builder that is the lead and only builds, exactly one planner, and at most one final reviewer. The lead is the channel that shows the table: the first seat at a discussion, the builder at a hierarchy. `BUILT_IN_PRESETS` are the two tables Trace comes with; a `TablePreset` is a table to start again, and the person's own are `HubPreferences.tablePresets` in `preferences.json` (at most 20, per computer; device sync picks only prices, terminal and memory settings, so they are not synced).
   - **Where seats live:** an open table is `RoundTableState.seats` (`TableSeatState`: session, run, engine, name, instructions, duties) with `driverSeat` (the discussion seat that edits) and, at a hierarchy, `SavedChain.turnSeat` and `blockedSeat`. A saved table is `SavedRoundTable.seats` (`SavedSeat`: session id and what the person set) with `driverSeat`; `savedSeats()` reads a table saved before 1.26 (no `seats`) as Claude Code with Codex, or as lead, planner and reviewer with `LEGACY_DUTIES`, and `hiddenSeatIds()` lists every hidden seat of either form. A Round Table's hidden seats have no tile (`checkLayout` in `shared/schemas.ts` uses `hiddenSeatIds`), and project templates map seat ids with the other session ids. `partner` and `planner` stay filled (the first other seat, and the planner) so a phone or linked computer on an older Trace still reads the table.
   - **Requests:** `table-open` carries `seats` (and `driverSeat`); without them it is read as before 1.26 (`partner`, `planner`). `table-seats` replaces the seats of an open table (names, instructions, duties, added and removed seats) and `table-driver` takes a `seat`. `RoundTables` (discussion, `round-table.ts`) and `ReviewChains` (hierarchy, `review-chain.ts`) each have `setSeats`, which checks everything before it changes anything and refuses while the table works (`TABLE_BUSY`, `TABLE_STEP`); a chat sits at one table only (`TABLE_TAKEN`). The window side is `src/runtime/round-table.ts` (`openTable`, `startTable`, `changeSeats`: new seats start first, the host is asked, and only then are removed seats stopped; a changed model restarts that seat, and `restoreTables` seats the table again) and `src/state/table-presets.ts`; `TableSetup.tsx` is the panel, with its logic in `table-setup-model.ts`. A phone or linked computer may send `table-open` and `table-seats` only with Can start and stop agents, and only for channels of the computer that serves it; the phone and the linked computer's tab have no Seats button.
7. **While it runs:**
   - Output goes to `logs/<runId>.log` (the first 3 MiB, then the newest 2 MiB in `.tail.log` and `.tail-1.log`), the renderer and the phone.
   - `TelemetryService` polls the CLI's own transcript every 750 ms:
     - Claude: `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`, respecting `CLAUDE_CONFIG_DIR`
     - Codex: rollouts under `~/.codex/sessions/YYYY/MM/DD/`, respecting `CODEX_HOME`
     - Claude's agents: `agent-*.jsonl` anywhere under `<conversation>/subagents/`, up to three folders deep, so a workflow's agents (`workflows/<run id>/`) count as well as the Task tool's. The top folder is listed on every read, the whole tree at most every 5 s or when the conversation gains usage, so a new workflow agent can be counted up to 5 s late (`walkSubagents`; limits `SUBAGENT_DEPTH`, `SUBAGENT_ENTRIES`, `SUBAGENTS` in `telemetry.ts`)
     - Gemini CLI has no transcript: its requests are rows of its conversation's SQLite file (`gemini-usage.ts`). A Gemini run (`startGemini`) is tied to a conversation and reads that file every 2 s when the file or its write-ahead log changed. The conversation is the one a Round Table seat reports when it is ready, the one a resumed channel names, or for a terminal the single new conversation in its folder (`geminiConversationSince`; never guessed between two). Each request is an event keyed `gemini:<conversation>:<row>`, so a row counts once and for one run; a resumed conversation counts from the rows it had when the run started. These records are left out of the usage file other computers read, whose schema admits only Claude Code and Codex. `DayUsage` still reads the same files for the day's total, which stays the one count of the day.
   - It enforces `maxSessionTokens`. If telemetry can't start while a token limit is set, the run is stopped, not left unenforced.
8. **On exit:** telemetry finalizes, and auto-memory writes a session-summary note (new git status lines, commits, the agent's last message).

### Approval alerts ("Needs you")

1. Claude Code's `Notification` hook with type `permission_prompt` or `elicitation_dialog`, or Codex's OSC 9 notification, calls `PtyManager.notifyAttention`.
2. That sends an `attention` event, and the tile shows Needs you.
3. Needs you clears on:
   - a real keystroke in that channel typed after the alert (`clearAttention`, `src/state/workspace-store.ts`; terminal replies are filtered by `isPersonInput`)
   - input from a paired phone
   - for Claude, a `PostToolUse` or `Stop` hook to `<hook url>/resolved` (`notifyResolved`), whose body is never read

Each run's hook URL carries a 32-byte secret, checked with `timingSafeEqual`.

### Usage and context

`electron/services/hub/telemetry.ts` turns transcript events into `UsageRecord`s, deduplicated by message ID and stored in `telemetry/usage.db` for 366 days. The database runs in WAL mode with `PRAGMA synchronous=NORMAL`: after a power cut the last few records may be lost, and the next start reads them again from the CLI's logs.

**Context (`UsageRecord.context`):**
- **Codex** reports its window: `{ used, limit }` drives the percentage, the limit state (80% or more) and budgets.
- **Claude** records only the amount in use: `{ used, limit: 0 }`, where used = input + cache reads + cache writes + output of the latest reply.
- Every consumer requires `limit > 0` before computing a ratio. Keep it that way, and don't invent a Claude window.

**Today's total (`DayUsage`, `hub/day-usage.ts`):** The status bar's Today total (formerly "Σ today") and the daily budgets come from the CLIs' own logs for the last 60 days, read in the background with `fs.promises` in 1 MB pieces. `days()` and `totals()` answer at once from what has been read and report `complete: false` while a read runs; callers that answer only once (the phone, the budget alerts) `await settled()` first, which waits at most 2 s. Where each log was read to, and the totals so far, are saved in `<storage root>/day-usage.json` (version 1) at most once a minute while logs grow, when a catch-up finishes and at quit, so a start reads only what the logs gained since. A Codex rollout's progress is kept until its date folder leaves the 60 days. Deleting the file makes the next start read the 60 days again.

### Shared memory

- **Notes:** immutable JSON files at `memory/<projectKey>/<uuid>.json`, written to a temp file and renamed (`memory.ts`).
- **Keys:** `projectMemoryKey(dir)` (`auto-memory.ts`) is `<repo>-<hash of the normalized origin>` for Git clones, so every clone and worktree shares one key, or `<folder>-<hash of the path>` otherwise.
- **The MCP server:** `memory-server.ts` is a standalone stdio MCP server (`read_memory`, `write_handoff`, `list_decisions`, `retire_decision`, `list_open_items`, `resolve_open_item`), launched with the app's own executable and `ELECTRON_RUN_AS_NODE=1`. Its arguments are the memory root and a key.
- **Sync:** additive. Drive mirror at `<drive>/AI-Coding-Hub-Memory/<key>/` (`DriveMirror` in `drive.ts`). Everything that touches the Drive folder is asynchronous (`syncLater`): Drive answers each file in about half a millisecond and downloads files it has not cached, and the synchronous sync this replaced froze the window and terminals for seconds. One sync per project runs at a time; a request made before it starts joins it, and requests made while it runs share one more sync afterwards (`drive-resolve` waits its turn). Notes are immutable, so a note of the same size on both sides is not read. A pair whose sizes differ but hold the same note is remembered in `memory/.drive-compared.json` (`COMPARED_FILE`), a cache that is safe to delete. A content conflict keeps both files and is reported, without stopping the project's other notes.
- **Who starts a sync:** `HubService.trackProject` starts one in the background and adds the project to the 30-second tick; `syncProject` does the same but can be awaited and never throws (the launch uses it); `drain(limit)` waits for pending ones at quit and update restart, after `AutoMemory.drain`. Saving a note writes it here at once and copies it to Drive in the background. `memory-list`, `memory-projects`, `drive-sync`, `drive-conflicts` and `drive-resolve` are answered by `HubService.executeAsync`; `execute` refuses them with `HUB_ASYNC`.
- **Note limit:** a project found above its limit (another writer added a note while Drive notes were copied, say) is brought back under it by its next write, which moves the oldest handoffs to `archive/`. Open items and decisions are never moved.

### Security boundaries

- **Main window:**
  - `sandbox`, `contextIsolation`, no `nodeIntegration`
  - new windows and navigation denied, all permission requests rejected
  - a CSP header, matched by a meta tag that `vite.config.ts` injects at build
- **Paths:** the renderer never names arbitrary paths or executables. Repository reads refuse symbolic links and stay inside the project. Memory, design and handoff code refuse links and `..`.
- **Config edits** (`hub/config.ts` `updateConfig`):
  - check a hash of what was inspected
  - keep unknown fields
  - keep a private copy of the old text under `config-backups/` in the storage root (one folder per file, the newest 20; `hub/file-backups.ts`), never beside the file, and replace the file atomically
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
- **Platforms:** enabled for an installed (NSIS) Windows build, and for a Mac app built with the Developer ID (`traceMacUpdates` in its `package.json`), each with `resources/app-update.yml` (`updatesEnabled`). Ad-hoc signed Macs, portable and source builds offer "Open downloads page".
- **Feed:** GitHub releases of `KGeary1995/trace-releases` (`electron-builder.cjs`, `shared/updates.ts`).

## Renderer

- **Stack:**
  - React 18 + TypeScript, built by Vite 6 (`base: './'`, dev server on `127.0.0.1:5173`)
  - zustand 5 stores, `react-grid-layout` for the channel grid, `lucide-react` icons
  - xterm 6 with the fit and WebGL addons. WebGL is opt-in through the `terminalWebGL` preference.
  - **Styling:** plain CSS with `--tr-*` custom properties from `src/tokens.css`, one stylesheet per owner, imported by `src/main.tsx` in this order: `src/ui.css` (element rules and every class more than one area uses), `src/shell.css` (the window frame), `src/tile.css` (channels), then `src/styles/` `chat`, `linked`, `start`, `changes`, `usage`, `tasks`, `setup`, `settings`, `workbench`. Rules of equal specificity are decided by that order, so a few rules sit in a later file than their owner to keep an override working. The phone app imports `src/styles/chat.css` for its chat view. Tailwind's utility classes are effectively unused, but `src/ui.css` starts with `@tailwind base`, which supplies the base reset, so don't remove Tailwind.
  - **Fonts:** Inter (interface), Plus Jakarta Sans (titles) and IBM Plex Mono (terminals, code), bundled. `src/main.tsx` waits for Plex Mono before rendering, because terminals measure their cells when created.
- **Navigation:** `App.tsx` switches on `useWorkspaceStore().activeView` (`NavigationView` in `src/state/workspace-store.ts`):
  - `workspace` → `SessionGrid` (+ `WorkspaceExplorer`)
  - `history` → `SessionHistory`
  - `files`/`diff` → `RepositoryPanel`
  - `computer` → `screens/LinkedComputerView`
  - everything else → `components/FeaturePanel.tsx`, which lazy-loads screens. `HubPanels.tsx` holds the MCP, skills, memory and settings panels; `screens/UsageScreen.tsx` holds usage.
  - The shell around every view is `shell/Topbar`, `shell/StatusBar` and `shell/Toasts`.
- **A channel tile** (`components/SessionTile.tsx`, design sheet 08): header with state chip and the header action, a detail row (facts and Stop, Settings, Task, Duplicate, Maximize, Close) that appears over the top of the terminal while the header is pointed at or focused (and sits in the flow, always shown, while settings are open or a notice follows the header), then `TerminalViewport.tsx` or `chat/ChatView.tsx`, then `tile/ScopeStrip.tsx` as the tile's foot (context gauge, tokens, output trace).
- **Window health:** `src/runtime/window-health.ts`, started once in `src/main.tsx`, reports long tasks, late timers and a terminal's lost WebGL context (`terminals.ts` signals it, `use-native-host.ts` reports it) through `reportWindowHealth`.
- **Channel state** (`src/state/channel-state.ts`): idle, starting, working, waiting (Needs you), limit, finished or failed.
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

`phone/` is a TypeScript PWA (`main.ts`, `api.ts`, `public/sw.js`), with React for the chat view and some screens (`chat.tsx`, `screens.tsx`), built by `vite.phone.config.ts` into `dist/phone`. It reuses `src/tokens.css`, the terminal theme and the `shared/remote.ts` types.

**Serving:** `RemoteServer` serves it, and Tailscale HTTPS exposes it on the tailnet.

**Pairing and API:**
- The phone pairs with a code (`POST /api/pair`) and keeps a bearer token.
- `/api/stream` is server-sent events (`channels`, `output`, `replay`, `resize`). There are also `/api/input`, `/api/size` and `/api/alerts` (Web Push).
- If the computer that served the phone is off, it can talk to sibling computers directly.
- Chat events pass through `forFollowers` (`electron/services/remote/chat-replay.ts`) before the replay buffer and the streams: phones and linked computers get a Round Table's state without image data (a waiting message's images as `waitingImageCount`, no task images).

**Shared code:** the phone uses `src/components/chat/ChatParts.tsx` with the desktop, but must not load zod or `shared/schemas.ts`. Checks that need schemas go in desktop-only files (such as `src/components/chat/seat-model.ts`); `seat-model.test.ts` guards this by walking the imports from `phone/main.ts`.

## Data on the user's machine

| Path (under the storage root, normally `~/.coding-hub`) | Contents |
|---|---|
| `storage.db` | SQLite (WAL). Tables `workspace` (one saved snapshot) and `runs` (`status`, `recordedBytes`, `logTruncated`, …). Runs left `running` after a crash are marked interrupted, and PIDs are never reattached |
| `logs/<runId>.log`, `.tail.log`, `.tail-1.log` | Terminal output: 5 MiB per run (the first 3 MiB, then the newest 2 MiB), 100 runs, 30 days. See [troubleshooting](troubleshooting.md) for stale sizes on Windows |
| `telemetry/usage.db`, `telemetry/<runId>/` | Usage records; Codex log directories (one left by a locked log is removed at the next start) |
| `day-usage.json` | `DayUsage`'s progress: log paths, engines, read positions, token totals by day and Claude message ids. Safe to delete while Trace is closed |
| `memory/<key>/<uuid>.json`, `memory/<key>/archive/`, `memory/.drive-compared.json`, `auto-memory/` | Handoff notes; handoffs moved aside at the note limit; Drive pairs already compared; per-run `--mcp-config` scratch files (`<runId>.mcp.json`; any left by an earlier start are removed at startup) |
| `preferences.json`, `shared-rules.json`, `updates.json`, `host-health.json` | Preferences (including the person's own Round Table presets, `tablePresets`), the rules source, update checks, the last 100 lifecycle events, and a separate list of the last 200 stalls (main process of 250 ms or more, window long tasks and stalls, GPU process deaths) |
| `machine.json`, `device-sync.json`, `linked-computers.json`, `remote*.json` | Sync identity and state, linked computers, phone server, devices, push keys. `remote-unlinked.json` lists computers removed under Other computers, which may not link themselves again without a code. Backups never carry these (nor `device-sync.json`); a restore keeps this computer's current ones |
| `config-backups/<folder>_<file>-<hash>/` | Earlier versions of configuration and instruction files Trace edited (`.mcp.json`, `config.toml`, `CLAUDE.md`, `AGENTS.md`, `.claude.json`, the rules source), the newest 20 each, with `original-path.txt` naming the file. Not in backups |
| `worktrees.json`, `worktrees/`, `coaching/`, `tasks.json`, `verification.json`, `experiments.json`, `backups/`, `restores/`, `crash-dumps/` | Feature data |
| `designs/`, `design-annotations.json` | Left by the removed Design workspace: no longer read or written, still backed up, never deleted |
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
