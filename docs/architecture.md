# Project architecture

AI Coding Hub separates a sandboxed React renderer from the Electron native host. Local CLIs own model access, authentication, approval prompts, shell tools, and Git context. There is no model API client.

```text
AI-Coding-Hub/
├── electron/
│   ├── main.ts                  Window lifecycle, validated IPC, native service wiring
│   ├── preload.ts               Fixed contextBridge allowlist
│   └── services/
│       ├── cli/
│       │   ├── account-connections.ts Official login commands and redacted statuses
│       │   ├── account-login-manager.ts Temporary login PTY, owner checks, cancellation
│       │   ├── stop-process.ts  Windows tree stop / Unix group escalation
│       │   ├── auth-status.ts   Redacted authentication diagnostics
│       │   ├── discovery.ts     PATH/native/npm launcher discovery and help probes
│       │   ├── engine-adapter.ts Engine-specific raw arguments and environment overrides
│       │   └── pty-manager.ts   Four owned PTYs, input/output/resize/stop
│       ├── updates/
│       │   └── update-service.ts Stable Windows feed, guarded update lifecycle
│       ├── storage/
│       │   └── workspace-storage.ts SQLite snapshots, run metadata, bounded logs
│       ├── repository/
│       │   ├── project-setup.ts Local creation/validation and GitHub CLI clones
│       │   ├── worktrees.ts     Isolated branch creation and guarded removal
│       │   ├── project-checks.ts Instruction scope scan and explicit npm checks
│       │   ├── filesystem.ts    Owner-bound directory handles and bounded file previews
│       │   └── git.ts           Local Git status and visual diff data
│       └── hub/
│           ├── service.ts       Strict integration requests and local preferences
│           ├── config.ts        MCP and extension discovery; guarded config edits
│           ├── rules.ts         Shared rule source, instruction blocks, guarded multi-file saves
│           ├── rules.test.ts
│           ├── memory.ts        Immutable curated handoffs and project installation
│           ├── memory-server.ts Standalone stdio MCP process for both CLIs
│           ├── drive.ts         Google Drive for desktop folder mirror
│           ├── telemetry.ts     Structured CLI log parsing and SQLite usage history
│           └── hub.test.ts      Config, memory, sync, and telemetry tests
├── shared/
│   ├── updates.ts               Update requests and status
│   ├── types.ts                 Session, CLIEngineConfig, MCPConfig, UsageTelemetry, GridTile
│   ├── help-content.ts          Searchable offline AI reference with related topics
│   ├── hub.ts                   Integration requests, usage, notes, pricing preferences
│   ├── ipc.ts                   Typed native bridge and channel registry
│   ├── schemas.ts               Runtime validation for sessions/workspaces/repositories
│   └── diff-parser.ts           Colored unified/combined diff rows and line numbers
├── src/
│   ├── main.tsx                 React entry point
│   ├── App.tsx                  Navigation, retained session canvas, explorer shell
│   ├── styles.css               Desktop theme and responsive integration surfaces
│   ├── state/
│   │   ├── workspace-store.ts   Session settings, directory bindings, layouts, lifecycle
│   │   └── hub-store.ts         Usage updates, preferences, integration bridge
│   ├── runtime/
│   │   ├── use-native-host.ts   Host events, restore/autosave, start/stop, usage updates
│   │   └── terminals.ts         Retained Xterm/WebGL instances and ordered input
│   └── components/
│       ├── AccountsPanel.tsx
│       ├── ProjectsPanel.tsx
│       ├── Navigation.tsx
│       ├── WorkspaceHeader.tsx
│       ├── SessionGrid.tsx
│       ├── SessionTile.tsx
│       ├── EngineControls.tsx
│       ├── EngineHealth.tsx
│       ├── UpdatesPanel.tsx
│       ├── WorktreeControls.tsx
│       ├── WorktreeManager.tsx
│       ├── ProjectValidation.tsx
│       ├── AccessibilityControls.tsx
│       ├── TerminalViewport.tsx
│       ├── CommandMenu.tsx
│       ├── WorkspaceExplorer.tsx
│       ├── SessionHistory.tsx
│       ├── RepositoryPanel.tsx
│       ├── FileTree.tsx
│       ├── FileBrowser.tsx
│       ├── DiffViewer.tsx
│       ├── FeaturePanel.tsx
│       ├── RulesPanel.tsx       One rule editor and project application status
│       ├── HelpPanel.tsx        Search, categories, related topics, local articles
│       └── HubPanels.tsx        MCP, skills/plugins, shared memory, usage, settings
├── scripts/
│   ├── check-native.cjs
│   ├── run-pty-smoke.cjs
│   ├── pty-smoke.cjs
│   ├── memory-smoke.cjs
│   ├── desktop-smoke.cjs
│   ├── verify-windows-package.cjs
│   └── fixtures/interactive-cli.cjs
├── assets/icon.{png,ico}
├── docs/architecture.md
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.electron.json
├── vite.config.ts / tailwind.config.cjs / postcss.config.cjs
├── electron-builder.cjs
├── index.html
└── README.md

~/.coding-hub/                   Local runtime data outside the source directory
├── storage.db                   Workspace snapshot and run metadata
├── logs/<run-uuid>.log           Bounded terminal output
├── shared-rules.json             Canonical rules and registered projects
├── updates.json                 Automatic-check preference
├── preferences.json             Drive path, font size, exact-model price rates
├── memory/<project>/<uuid>.json  Immutable curated handoff notes
└── telemetry/
    ├── usage.db                 Deduplicated usage events and run metadata
    └── <run-uuid>/              Codex TUI logs for thread correlation

G:\My Drive\Coding Hub/
└── AI-Coding-Hub-Memory/<project>/<uuid>.json  Shared notes only
```

## Process boundary

Each renderer request is checked against the window's main frame and exact application URL. The preload exposes a fixed set of methods; it does not expose Node, arbitrary IPC, shell execution, or arbitrary executable launch. Zod validates payloads. Session writes and resizes require an owned session/run reference. Repository operations require owned directory handles; traversal, Git metadata reads, links, and special files are rejected.

Claude and Codex run in native PTYs with argument arrays. Windows npm launchers resolve to the official package's declared JavaScript entry and run in Electron's Node mode. No approval-bypass flags are inserted. Closing/reloading stops owned processes; restoration recreates idle panel settings rather than reattaching PIDs.

## Configuration edits

Native discovery reads engine-specific user/project files, returns environment/header names without secret values, and stores private source handles. Edits verify a file hash, preserve unknown parsed fields, write private backups, and replace files atomically. TOML comments and formatting may normalize. Parse failures never become empty configurations. Claude disablement uses project-scoped engine settings; Codex uses the server's enabled flag. The app does not connect every discovered server or run hooks to inspect them.

## Usage

Claude sessions receive a generated UUID through the advertised `--session-id` flag. Their matching JSONL transcript provides assistant message usage; repeated snapshots are deduplicated by message ID. Codex receives a separate `log_dir` without changing CODEX_HOME, and its TUI thread ID binds the matching rollout. Ambiguous same-directory sessions are not guessed. Cumulative token events are upserted; reasoning already inside output is not added again. Missing fields stay unknown. Exact model price rates determine local cost estimates; daily activity groups by session start date.

## Shared memory

A standalone local MCP process reads/writes the same immutable project note files as the app. Installation is an explicit UI action that updates project MCP entries and appends marked instructions, preserving existing contents. Neither model's conversation is automatically copied into the other model's context. The agent reads curated handoffs through MCP, subject to normal CLI permissions.

Drive synchronization is additive and idempotent. Conflicting IDs preserve both versions and stop the sync for review. Google Drive for desktop owns authentication and cloud transport. Database contents, raw terminal logs, and credentials are excluded. The folder mirror completing does not prove that Google Drive's cloud upload has completed.

## Shared rules and help

The native rules service stores a single versioned rule document. Renderer requests carry the saved-state revision and fingerprints of both project instruction files. Saves preserve text outside the marked section, create private backups, replace files atomically, and roll back prior replacements if a later operation fails. It rejects malformed section markers, links, oversized files, duplicate project targets, and stale edits. Both engine launches check that the selected cwd has the current block in `CLAUDE.md` and `AGENTS.md` when nonempty rules are saved. Existing running agents must be restarted; project instructions guide model behavior while CLI permissions and external checks provide actual enforcement.

Help content is bundled TypeScript data with category filters, full-article search, and validated related-topic IDs. It makes no network requests and includes the distinctions between MCP, skills, plugins, rules, and handoff memory.

## Windows updates

Electron-updater runs only in the native host. The packaged GitHub provider is fixed, and validated renderer actions cannot set URLs or credentials. Installed Windows editions use NSIS, explicit downloads, and a confirmed restart; development and portable editions are disabled. Active/pending PTYs and failed workspace flushes block installation. The host prevents new launches while preparing the update. Normal exit never installs downloaded updates. Local data lives outside the install directory. The manual candidate workflow builds and uploads release assets; publication and signing prerequisites are documented in windows-releases.md.

## Isolated work and validation

Managed worktree records and directories live under the storage root. A new random branch starts at the current committed HEAD; no source edits, staging, or merging occur automatically. Git post-checkout hooks are disabled for this infrastructure action. Removal refuses active/pending or saved session bindings and any tracked/untracked changes, and never deletes the branch. Shared rules are applied explicitly to each worktree.

Project checks discover a fixed set of npm script names. A native trust confirmation precedes execution with inherited local environment, bounded output, and process-group cleanup on timeout/shutdown. These checks execute project code and its npm hooks, so the renderer cannot silently substitute arbitrary commands. Instruction scans report scope overlap, not semantic proof of conflicts or model compliance.

Memory revisions append new linked IDs. Drive conflict review fingerprints both inspected notes; resolution preserves the remote content under a new ID, leaves local content intact, backs up the original conflicting remote file, and replaces it only if unchanged. Sync then resumes as an additive mirror. Provider billing and actual Google Drive cloud synchronization are not owned by this app.

## Bootstrap and authentication

Account login is independent of workspace directory selection and rules gates. The host selects fixed official CLI login arguments; renderer requests cannot supply executables, flags, or URLs. Installation-guide links are a fixed allowlist. The login PTY sends temporary events through separate channels, bypassing coding history/telemetry and shared memory. Output can contain a one-time sign-in code and is cleared on navigation; credentials remain in the CLI’s store. Cancelling, navigation, renderer death, and shutdown terminate owned login processes. Update restart is blocked by pending/running login flows.

Projects supplies explicit local folder browsing, typed validation, new folder creation, and fixed GitHub CLI list/clone operations. Creation reserves an empty destination and preserves existing/partially cloned folders. GitHub account status does not prove repository permissions.
