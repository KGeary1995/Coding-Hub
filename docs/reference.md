# Trace reference

How each part of Trace works, what it stores, and the release history. To install Trace and get started, see the [README](../README.md).

Trace (formerly AI Coding Hub) is a local Electron desktop workspace for running **Claude Code and OpenAI Codex CLI side by side**. This source release includes the multi-session terminal grid, engine-specific settings, local persistence, file explorer, Git diff review, MCP management, skills/plugins inspection, usage history, shared handoff memory through Google Drive for desktop, a searchable AI help guide, and shared project rules for both engines.

## Codex model catalog and application stability (v1.7.2)

Codex session settings now load the full model catalog reported by the installed official CLI, including additional/hidden models and every returned page. Suggestions use exact CLI model values, and reasoning controls show the selected model's advertised levels. Custom model IDs remain editable; blank fields retain CLI defaults. **Use Codex CLI defaults** clears resume metadata as well as model/reasoning overrides so recovery starts a fresh conversation while preserving the old conversation in native history.

Terminal rendering now defaults to software; optional WebGL acceleration is in Settings and applies after an app restart. Native event delivery is guarded during renderer loss, and display crashes offer reload after terminal cleanup. **Settings → Running application → Application stability & crash diagnostics** shows bounded local lifecycle records. Native crash dumps remain local and are excluded from memory sync, backups and support exports. The reported Windows application close during Claude use has not been reproduced or attributed to a specific cause; see [the release notes and validation limits](models-stability-v1.7.2.md).

## Code review and reliability fixes (v1.7.1)

This release fixes Git push destination review, short/overlapping Codex usage correlation, Unix child-process cleanup, linked design-task editing, large verification results, escaped memory/design records, memory limits and redirected storage, malformed MCP messages, repeated Drive scans, and signed upgrade baseline selection. Vitest is upgraded to remove the critical development-tool advisories found during review. See [the audit report](audit-v1.7.1.md) for reproduction evidence, validation, and outstanding Windows/provider checks and development-dependency advisories.

## Professional workflow release (v1.7.0)

All eight productivity improvements are included with progressive disclosure. One **Workflow center** adds Recovery, Search, Templates, and Support tabs. Git delivery stays collapsed under Changes; session names/budgets live in expandable settings; design comparison and linked tasks appear only when requested. The terminal canvas retains its existing focus.

| Improvement | Where it lives |
| --- | --- |
| Session recovery | Workflow center → Recovery: failure history, exact-directory/profile diagnostics, setup guidance, and explicit retry |
| Persistent conversations | Session settings and native history: names, pinned references, retained native IDs, and unsent prepared requests |
| Git delivery | Changes → Git delivery: reviewed staging, unstaging, commit, non-force push, and draft/regular PR creation through local gh |
| Unified search | Workflow center → Search, or Ctrl/Cmd+Shift+F: files, notes, rules, and optional recorded output |
| Usage budgets | Session settings → Session name & budget alerts: per-run token/cost targets and context warnings |
| Project templates | Workflow center → Templates: layouts, raw engine parameters, budgets, optional rules and verification profiles |
| Release reliability | Workflow center → Support: redacted diagnostic export, Windows signature inspection, and a certificate-required signed build/upgrade workflow |

See [the complete workflow guide](workflows-v1.7.md). Signing setup is prepared; no signing certificate or published signed release is supplied. `npm.cmd run dist:win` still builds an ordinary candidate, while `npm.cmd run dist:win:signed` requires native Windows and configured certificate/publisher settings.

## Desktop interface refresh (v1.6.1)

The app now uses a consistent dark desktop design system: restrained blue accents, clearer typography, aligned controls, readable data tables, and matching configuration/review surfaces. The workspace overview shows actual running sessions, reported tokens, configured-price estimates, and assigned working directories; unavailable usage remains unknown. Idle session cards explain how to launch or resume without covering running terminal output.

Collapse navigation with the button beside the app name to give terminals more room. Icon buttons retain names, tooltips, keyboard access, and active states. The choice persists in the desktop profile. Project context stays in the top bar, session layouts adapt to smaller windows, and the task editor sits beside the task board at larger widths. Compact density, interface scale, and higher contrast remain available in Settings.

To update an installed Windows copy, extract this version into a new folder, run `npm.cmd ci` and `npm.cmd run dist:win`, then open the new **Setup.exe** under `release`. Source files do not replace an older installed shortcut. `npm.cmd start` runs the source edition directly.

## Complete workflow release (v1.6.0)

This release adds all eight workflow improvements. See [the usage guide](workflows-v1.6.md) for setup and examples.

| Feature | Where to use it |
| --- | --- |
| Connection diagnostics | Accounts & connections: installation, login, configuration, directory, and native terminal checks |
| Version and installation clarity | Settings: renderer/host versions, executable, source/installed edition, and active data folder |
| Native conversation resume | Session history → View native CLI conversations: default accounts and named Claude profiles |
| Coaching experiments | AI coaching: compare A/B prompt wording, measured CLI tokens, time, rework, and outcome evidence |
| Backup and restore | Settings: verified local backups, export/import, separate restored data copy, explicit restart |
| Tasks | Tasks: give a channel a job and its files, send it, follow its status and changed files, warn about clashes |
| Repository verification | Verification profiles: saved argument-based npm/pnpm/yarn/Python/Cargo/Go/.NET checks and recorded results |

Conversation resume uses the installed CLI's advertised resume support and recorded conversation ID. Resumed-run telemetry counts newly reported usage rather than previous conversation totals. Login and terminal diagnostics leave actual provider/model completion unverified until you send a task. Backups exclude CLI credentials and external repositories. Task scopes help coordinate work; they do not enforce permissions or identify who edited a file.

## AI coaching (v1.5.0)

**AI coaching** shows local usage trends, token totals, configured-price estimates, and heuristic suggestions. Add curated prompt examples and record successful/partial/failed outcomes; no full session logs are mined automatically. Select up to five examples and review the complete coaching report. Nothing is sent to a model by opening this screen or preparing a report.

**Live coaching** (on by default; **Coach my prompts as I send them** on the AI coaching screen) checks each prompt you send in a Claude Code or Codex channel, terminal or chat, as soon as the CLI writes it to its transcript. The checks run on this computer: a thin first prompt, a problem with no error text, a task with no way to tell it worked, "better" with no meaning, several asks at once, or a very long prompt. Slash commands and short replies get none. Up to two tips appear in a strip under that channel, and every prompt is listed, newest first, under **Live coaching** on the AI coaching screen, where **Save as example** adds it to your examples. **Ask AI** (on the strip or the list) sends that one prompt, and the end of the agent's reply before it, to Claude Haiku through Claude Code (`claude -p --model haiku`, no tools, no MCP servers) on that channel's Claude account (the default account for Codex channels), and to Codex (`codex exec` in a read-only sandbox, low reasoning) only when Claude Code is not installed: a Claude review takes a few hundred tokens, a Codex one about 24,000. Its usage counts in **Σ today** and on the Usage screen: the review's session is kept, in `~/.coding-hub/coaching`, which Session history does not list. Another computer's channels are coached on that computer; their tips show on its tab here and on the phone, and **Ask AI** there has that computer's CLI review the prompt. It takes a few seconds and uses a little of your plan; it returns advice and a rewrite with `[placeholders]` for details only you know. Coached prompts are kept on this computer only (`coaching/live-tips.json`), for 30 days and at most 500; the screen lists the newest 50, sums up the last 7 days (how many prompts had each kind of tip, and the change that would help most), and **Clear coached prompts** forgets them. The switch is `coaching/live.json`. Trace's own coaching channels are not coached.

For deeper agent advice, explicitly approve the reviewed report and choose **Prepare Claude coaching** or **Prepare Codex coaching**. This creates an idle session in a separate local report directory, with your shared rules applied. Choose its account/model, start it, finish any CLI trust/setup prompts, then click **Send coaching request**. The agent is asked to analyze the selected examples, suggest meaning-preserving rewrites, and propose measurable experiments. Advice appears in the interactive terminal and ordinary local session history. Provider CLI configuration/tools/approvals still apply; the prompt asks for analysis without commands, edits, or unrelated file access. This optional step uses provider inference and is not offline AI. Local heuristic findings are not labeled as AI advice, and token use alone does not establish outcome quality. Prompt examples and prepared reports remain under `~/.coding-hub/coaching`, outside curated Drive memory. The 100 most recent prepared coaching reports are kept; when another is prepared, the oldest folder not used by a session tile is deleted. Prompt examples are capped at 100. Prepared requests now persist with the workspace. After restarting, start the idle tile, handle CLI prompts, and explicitly send the retained request.

The setup guide dismisses automatically after a shared or independent project folder is configured, and can be dismissed manually. Completion is remembered in the desktop profile.

## Codex launch troubleshooting

Accounts & connections reports local login status, not verified model access or a successful interactive launch. On Windows, Trace prefers the native Codex binary inside official npm packages so ConPTY attaches directly to the console program; older JavaScript launchers remain a fallback and run with the installed Node.js (`node.exe` on PATH), because Electron's own executable shows no output in a Windows pseudoconsole. Native package executable entries are launched directly rather than interpreted as JavaScript. Failed coding runs preserve a bounded terminal diagnostic even when the CLI clears its alternate screen. A failed Codex tile offers **Use Codex CLI defaults**, clearing model and reasoning overrides before you retry.

If Codex still exits with code 1, read the error printed above the exit marker and shown in the session tile. In PowerShell, change to the same project directory and test `codex.cmd --version`, `codex.cmd login status`, and `codex.cmd` (use `codex` for native installations). Resolve the CLI's actual error, such as invalid local configuration, unavailable model, missing dependency, terminal compatibility, or provider access. Cloud fixture tests do not prove that a specific Windows/provider installation is fixed.

## Multiple Claude accounts (v1.4.0)

Open **Accounts & connections → Claude account profiles**. Add a name such as Personal or Work, then use **Connect Claude profile** and complete the official CLI login. Choose the intended account in the browser; browser cookies can preselect your current account. Repeat for your other accounts. Up to ten named profiles are supported, plus **Default**, which preserves your existing local CLI login.

In each Claude session, open **Settings → Claude account profile**, select a profile, and start the session. Connect a named profile before launching; the host verifies its CLI login and blocks unverified or signed-out profiles. Different profiles can run at the same time, within the existing four-session limit. Stop a session before changing its account. Reconnecting a named profile requires stopping sessions using it; other profiles can continue. Labels can be renamed without changing login storage or saved session assignments.

Named profiles use separate `CLAUDE_CONFIG_DIR` directories under `~/.coding-hub/claude-profiles/<profile-id>/`. The registry stores only profile IDs, labels, and creation dates. Claude Code handles credential storage and refresh; Trace does not copy, read, or export credential files. Authentication environment overrides inherited from the host are cleared for named profiles. The default login and other host environment variables are preserved. Project settings can still explicitly configure authentication helpers or environment values; review those if the CLI reports an unexpected account. Named profiles start with independent user settings, skills, and user MCP configuration; project-level instructions and integrations remain shared. Profile credentials are not included in curated Drive memory or source archives. Usage follows each profile's structured session logs, and profile choices are retained in local workspace/history settings.

Every Claude channel shows whose account it runs on, in that account's colour: a chip with the account's name in the tile's header and a stripe down the tile's left edge. A named profile shows its name. A channel on **Default** shows the name of the profile signed in to the same account (so it reads Personal when your default login is your personal account), or the account's email when no profile matches. To find out which account a login is, Trace reads only the email and organization from `.claude.json` (`oauthAccount`), never the credentials file. Phones and linked computers show the same name and colour for each channel.

Profile tests use isolated fixture CLIs to exercise separate logins, simultaneous PTYs, telemetry, reconnect protection, and restart persistence. Real subscription login and model completion must be verified on your desktop with your own accounts. Credential-directory behavior was inspected in Anthropic's published Claude Code 2.1.29 CLI; use a current official CLI.

## Workbench layout (v1.3.0)

Navigation is grouped into Workbench, Review & insights, Agent configuration, and Resources. The active project and local CLI health sit above a compact session toolbar. The terminal canvas fills the remaining window; columns, rows, and a four-session grid adapt to its height. Larger custom tiles scroll within the canvas. Toggle the file explorer beside the layout controls, or isolate a session with **Maximize** in its detail row. Project setup remains visible until a root folder is selected.

Accounts shows connection actions first, with executable paths and login commands under **CLI details & login command**. The temporary sign-in terminal expands while a login is active. The shared visual system uses neutral surfaces, blue navigation/actions, amber Claude accents, and green for Git additions and running/authenticated states. Existing compact density, zoom, contrast, keyboard shortcuts, and saved layouts remain available.

## Run on Windows

Install **Node.js 24 LTS** (minimum 22.13), Git for Windows, and the official Claude Code and Codex CLIs. Authenticate each CLI using its normal login flow. Extract the source ZIP into a local development folder, then open PowerShell **in the folder containing `package.json`**:

```powershell
npm.cmd ci
npm.cmd run dev
```

`npm.cmd` avoids the blocked PowerShell `npm.ps1` wrapper without changing execution policy. Verify `claude --version`, `codex --version`, and `git --version` in the terminal used to launch the app. Use `claude.cmd` / `codex.cmd` for npm launchers if their PowerShell wrappers are blocked. Claude Code may require Git Bash according to its current Windows installation instructions.

After installation, `npm.cmd start` builds and opens the production app. Restart the app after installing a CLI, changing PATH, or editing native host source. Renderer edits reload during development.

## Account and project setup (v1.2.1)

Open **Accounts & connections** to connect Claude Code, OpenAI Codex, and GitHub before starting a coding session. Refresh detects existing CLI sign-ins; Connect runs the official login command in a temporary interactive terminal. The CLI may open your browser or display a URL/code. Credentials remain with the provider CLI; login output is excluded from coding history and Drive memory. Account setup does not require a project or shared-rule application. Missing CLIs show installation guides and Windows commands; installing the app does not install the agent CLIs.

Open **Projects** to browse an existing folder, enter its absolute path, create a new local project, or list/clone GitHub repositories. A folder picker hides files; use **Use this folder** to select its current location. GitHub listing requires the local GitHub CLI (`gh`) and its own login; it lists up to 100 repositories for the account/selected owner. Cloning requires Git and a parent folder, preserves existing folders, and opens the new local copy. Independent session settings also provide **Browse repository folder**. Apply shared rules to the selected folder when rules are configured.

**Stop** now terminates a Windows session’s process tree before closing ConPTY, verifies its launcher exited, and gives cleanup more time. Unix stops its process group with TERM/KILL escalation. A missing PTY exit event is recovered only after the process is verified gone. Account-login cancellation shares these safeguards. The terminal exits its alternate screen and disables input after exit; Stop failures keep the PID available and surface an error.

Windows packaging uses a fresh staging folder for every attempt, avoiding the locked `release/win-unpacked` rename failure. Verified installers/update metadata are then copied to `release/`; prior staging directories remain intact. `npm run verify:win` follows the last successful build manifest. A Windows workflow additionally installs two package versions, checks retained data, and uninstalls in an isolated runner.

## Navigation

Trace replaces the sidebar with a top bar and a status bar:
- **Top bar:**
  - the project switcher;
  - the **Workspace**, **Changes** and **Projects** tabs;
  - the **Insight** menu: Usage, Session history, Files and **More tools** (AI coaching, Tasks and Verification profiles);
  - the layout controls (Workspace only) and the command field (**Ctrl+Shift+P**);
  - Help, and the **Agent setup** menu: Accounts, Shared memory, Shared rules, MCP servers, Skills & plugins, Settings and Workflow center;
  - **+ Channel** to add a channel (up to eight): Claude Code, Codex CLI, Gemini CLI, Terminal, or a Round Table.
- **Status bar:** every channel's state and tokens today, the project, today's tokens and cost on this computer (**Σ today**: read from Claude Code's and Codex's own logs every 15 seconds, so it also counts use outside Trace or while Trace was closed, for every Claude account; a reply counts once, on the local day it was written), alerts, save status and the host connection. Click a channel or an alert to jump to its terminal.
- **Keyboard:** **Alt+1…8** focuses a channel. **G** then a letter opens a view:
  - W Workspace, C Changes, P Projects;
  - U Usage, H History, F Files, L More tools, T Tasks, V Verification, D Design, O Coaching;
  - A Accounts, M Memory, R Rules, S Settings.

The app installs as **Trace** (Trace.app, Trace.exe, Start Menu and desktop shortcuts). Before 1.11 it installed as AI Coding Hub. The app ID, the Electron profile folder (still named `AI Coding Hub`), the data folder (`~/.coding-hub`), the Drive folders (`AI-Coding-Hub-Sync`, `AI-Coding-Hub-Memory`) and the update channel keep their original names, so existing installs upgrade in place and computers on different versions keep syncing. On Windows the Trace installer replaces the old-name install; on a Mac, Trace offers once to move AI Coding Hub.app to the Trash (only if you click **Move to Trash**).

## Screens

- **No project yet:** the workspace shows a "no signal" scope and three ways in: **Open folder** (Ctrl O), **Clone from GitHub** and **New project** (Ctrl ⇧ N). Below them are recent project folders (from session history) and which CLIs are installed and signed in. **Use channels without a project** shows the channels anyway, for channels with their own folders.
- **Command menu (Ctrl ⇧ P):** actions, live channels, project files and memory notes in one list. Start with `>` for actions, `@` for channels, `/` for files or `#` for memory, or press Tab to switch scope. ↑↓ move, Enter runs, Esc closes. File and memory results come from the same local search as Workflow center and wait for a pause in typing.
- **Notices:** a channel that needs approval, or has failed, raises a notice bottom-right with **Answer** or **Retry** / **Open log**. It stays until the channel moves on or you dismiss it.
- **Changes:** the changed files on the left, the diff in the middle and a **Delivery** stepper on the right: stage, commit, push and pull request. Each step still asks for native confirmation; there is no force push or discard.
- **Usage:** pick a window (Today, 7, 14 or 30 days) and an engine. The strip totals input, output (with reasoning shown as part of it), cache reads, sessions and estimated cost, with the change from the previous window. The chart stacks each day's tokens by engine (cache excluded); the table lists each session with its context at the last report.
- **Agent setup:** Accounts, Shared memory, Shared rules, MCP servers, Skills & plugins, Settings and Workflow center share one screen with a status line for each. Accounts lists Claude Code, Codex and GitHub as rows.

## Channel tiles

Each session is a channel (CH1–CH4, in grid order). From top to bottom, a tile shows:
- **Header:** the channel badge in the engine's colour, the name (the channel's folder, unless you renamed it in its settings), what it is working on (the title its CLI gives its terminal, such as Claude Code's task summary), the model, the Claude account it runs on (also a coloured stripe down the tile's left edge), `ctx` (context used: a percentage for Codex; for Claude Code, the tokens in context after the last reply, with no percentage because Claude Code does not record its window size) and `tok` (the channel's new tokens today, across restarts of the channel and of Trace: input outside the prompt cache, plus output; hover for the cache reads it leaves out). Then the action for the current state, and the state chip.
- **Scope strip:** the terminal's output per second over the last two minutes, a dashed limit rail and, along the bottom, a bar for the context or session budget used, with a marker at 80%. The trace only ever shows real output.
- **Detail row:** point at the header, or tab into it, to swap the strip for the process ID, folder, cost and context, and the Interrupt, Stop (or Restart), Settings, Duplicate, Maximize and Close buttons.
- **The terminal.**

| State | Chip | Action |
|---|---|---|
| idle | ○ IDLE | **▶ Start** (or Enter on the tile) |
| starting | ◌ ARMING (pulses) | — |
| working | ● RUN | — |
| waiting | ◆ HOLD (frame turns magenta) | **Answer** jumps to the terminal |
| finished | ✓ STOP | **Review changes** (G C) |
| failed | ✕ FAULT (frame turns red) | **Retry** and **Open log** |
| limit | ▲ CLIP (context or budget ≥ 80%) | **Write handoff** opens Shared memory |

With the tile focused, Enter starts an idle channel or moves into its terminal.

**Terminal channels** (+ Channel → Terminal) run your login shell (zsh or bash) on macOS and Linux, or Windows PowerShell, in the channel's folder. On Windows, PowerShell runs as administrator through Windows' own sudo when it is on and set to **Inline** (Settings → System → Advanced → **Enable sudo**); Windows asks for approval each time a terminal starts, also when it is started from the phone or another computer. With sudo off, or set to a new window or no input, the terminal runs normally and says how to turn sudo on. They have no model, usage, shared rules check, shared memory or approval alerts, and their output is not saved to session history. They appear on the phone page like any other channel.

**Gemini CLI channels** (+ Channel → Gemini CLI) run Google's Gemini CLI (`agy`) in a terminal in the channel's folder. Trace finds `agy` on PATH (`agy.exe` on Windows; not an npm launcher) and lists it under Local engines with its version.
- **Model:** always `gemini-4-argon-high`, the highest model on the subscription, passed with `--model`. There is no model setting. Trace refuses to start when `agy --help` does not list `--model`.
- **Permissions** (the tile's Settings; applies when the channel starts): Allow edits passes `--mode accept-edits` (with agy 1.5.6, file edits went through without asking and running a command asked first); Full access passes `--dangerously-skip-permissions`; Ask passes no mode, so agy's own settings decide. A level whose flag `agy --help` does not list is refused rather than dropped.
- **Sign-in:** agy handles its own sign-in; Trace does not check it. The first start in a folder asks whether you trust that folder.
- **What it does not have:** chat, resume, usage and cost, context, the "waiting for you" alert, shared memory and rules, tasks, coaching, image paste and Round Table seats. Those are for Claude Code and Codex channels.
- **Phones and other computers** list a Gemini channel as a terminal, because Trace 1.18.0 and older refuse a channel list holding an engine they do not know. Adding a Gemini CLI channel on a computer with an older Trace says to update Trace there. A project template holding a Gemini channel cannot be read by an older Trace that syncs templates; it reports one shared template file it could not read, and syncs the rest.

**Pasted images:** the CLI attaches the clipboard image itself when it receives its image key: Alt+V on Windows, Ctrl+V on a Mac. On Windows, Ctrl+V pastes like Windows Terminal: text is pasted, and when the clipboard holds only an image Trace sends Alt+V for you. On a Mac, Cmd+V with only an image on the clipboard sends Ctrl+V for you. Alt+V and Ctrl+V still go straight to the CLI. Trace also reads the image and shows it under the terminal as **Attached**, numbered in the order pasted in that run (matching Claude's `[Image #N]` for clipboard pastes). Pressing Enter in the channel moves attached images to a smaller **Sent** row with the time. Click a thumbnail to enlarge it; × removes an attached one from the strip (the agent keeps what it was given). Dropping files on a channel types their paths, quoted when needed, and dropped images are attached too. The strip clears when the channel restarts.

## Chat channels

A **chat** channel runs the agent without its terminal screen, and Trace draws the conversation. **+ Channel** no longer offers Claude chat or Codex chat on their own (on the computer or the phone): a chat comes with a **Round Table** (its leading channel is a Claude chat), with **New worktree…** on a task, or from a linked computer; chat channels you already have keep working. Claude Code runs in its structured mode (`--print --input-format stream-json --output-format stream-json`) instead of its terminal screen, and Trace draws the conversation: your messages with images inline, replies formatted (headings, lists, tables, code), tool calls as cards with their results (edits as before/after), and Claude's thinking folded away. It runs in the channel's folder with the channel's account profile, model, shared rules, shared memory and MCP tools, as a terminal channel does, and usage is recorded the same way.

- **Images:** paste, drop or attach (button) up to 10 per message. They go to Claude as images, not file paths. Images over about 5 MB, or in other formats, are redrawn as JPEG at most 2000 px.
- **Approvals:** when Claude asks to use a tool your permission settings do not already allow, a card offers **Allow**, **Allow edits this run** (when Claude suggests it) or **Deny**. The channel shows as waiting (status bar, notice, phone alert) until you answer; **Answer** goes to the card.
- **Stop** interrupts the reply; Claude keeps what it has done. A restarted chat continues the conversation.
- **Codex chat** runs Codex's app server (`codex app-server`, the protocol its IDE extension uses): images go in as images, commands and file changes appear as cards with their output, and Codex's approval requests offer **Allow**, **Allow for this session** or **Deny**. Codex's own settings (approval policy, sandbox) apply as in its terminal.
- Terminal-only screens such as `/config` or the model picker are not part of chat; use a terminal channel for those. On the phone, a chat channel's last 300 events (or 2 MB) of its current run are shown when it is opened, then it follows live; **Conversation** reads the whole transcript.

## Round Table

A Round Table puts you, Claude Code and Codex in one conversation. In a **Claude chat** or **Codex chat** channel, press the people button beside the message box: Trace starts the other agent in the background, in the same folder, and seats both at a table in the channel you started from. A Round Table is one tile; the other agent has no tile of its own. If the conversation was already under way, the leading agent writes a short summary for the newcomer, which also gets the latest eight messages.

- **Turns:** each message goes to both agents. When both have answered, each is shown the other's answer and replies, for up to **Rounds** rounds (0–5, 2 by default). The discussion stops early when both reply `AGREE`. A message sent while they work stops both and goes to both.
- **Driver and reviewer:** the driver edits files; the reviewer is read-only (Claude Code's plan mode, or Codex's read-only sandbox), and Trace declines any edit it asks for anyway, with a line in the thread. **Swap** changes roles without restarting either agent. A Claude reviewer that becomes the driver again returns to the permission mode its own settings started it in; a Codex one returns to `workspace-write`, even if your Codex config uses another sandbox.
- **One thread:** the leading channel shows both agents' messages, each labelled in its engine's colour, with the bar above it: roles, Swap, Rounds, where the discussion is, **Stop both** and **Close**, each agent's tokens today, and how the other agent is doing (running, working, needs approval, stopped). Its approvals appear in the thread, and the tile, status bar and notices show them under the channel's number. **Show Codex** (or **Show Claude**) shows the other agent's own conversation, with what Trace passed to it.
- **Starting, stopping, closing:** the other agent starts and stops with the channel, and closes with its tile. After a restart, starting the channel starts both, and they sit at the table again. **Close** on the bar ends the table and stops the other agent. Tables saved by 1.16, where the other agent had its own tile, open as one tile.
- **Eight at most:** the other agent is still a CLI running on this computer, so it counts toward the eight channels Trace runs at once.
- **Phone and other computers:** a Round Table is one channel on the phone and in another computer's tab, and an approval the other agent waits for shows on that channel. A phone allowed to start agents can open one too.
- Both agents run on your own logins and plans; every message passed between them is used by both. Trace never calls a model itself.

- **Findings:** the reviewer reports each problem on its own line as `FINDING high|medium|low path:line — the problem`, and Trace numbers them F1, F2, …. The driver answers `FIXED F1: …` or `DECLINED F1: …`, and the reviewer checks it with `VERIFIED F1` or `REOPENED F1: …`. Each agent is told, with the other's answer, which findings wait for it. The table bar lists every finding with its evidence, answers, and the files it was reviewed and answered on (a hash of the repository, `repositoryState`). The next round waits until the record is written and the files' state is taken; a finding from a turn during which files changed is marked (the driver works while the reviewer reads). The record, and a message waiting for the agents (published as soon as it is sent, with its images up to 6,000,000 base64 characters; beyond that the bar says how many would be lost), are saved with the table and come back after a restart. A kept message waits for **Send now** or **Drop it**; a new message is refused until then, and Needs you lists it. Closing a table first saves its review record (every finding, verified ones included) as a note, and each finding not yet verified as an open item, in the channel's memory project. If memory cannot be written, the table stays open and says so; a table closed elsewhere keeps its findings with the channel, and Needs you offers **Save to memory**.

### Hierarchy Round Table

**+ Channel → Round Table (hierarchy)** seats three agents in the project folder, in one tile: the **builder** (this Claude chat, `claude-opus-5-5` by default, the only seat that edits files), the **planner and final reviewer** (a hidden Claude chat, `claude-fable-5-2` by default, read-only) and the **reviewer** (a hidden Codex chat, read-only). Trace runs fixed steps (`electron/services/chat/review-chain.ts`) and passes each step's output to the next:

1. **Plan:** the planner reads the project and writes numbered steps, files and checks, ending with `PLAN READY`. It runs in Claude Code's plan mode, and its brief tells it to write the plan in its reply, not in a plan file, and not to call `ExitPlanMode` (Trace declines both).
2. **Approve:** the table waits for you. **Approve plan** starts the builder; anything you write instead goes back to the planner as what to change.
3. **Build:** the builder implements the plan and reports what it changed.
4. **Review:** Codex reviews the files and reports `FINDING` lines, or `NO FINDINGS` on its last line. A reply with neither (and no `VERIFIED`/`REOPENED` answers to earlier findings), such as an empty reply or a question, stops the table at the review; **Continue** runs it again.
5. **Fix:** the builder answers each finding `FIXED` or `DECLINED`; Codex checks them and looks again, for up to two review rounds.
6. **Final review:** the planner checks the work against the task, its plan and the findings, and ends with `APPROVED`, or `CHANGES NEEDED:` and what to change. Changes go back to the **Fix** step: the builder makes them, Codex reviews them once more, and the planner reviews again; up to twice, after which the table stops and asks you.

A task given to the table (from Tasks, or typed) is done only on `APPROVED`; while the plan waits, or the table needs you, the task is marked so and Needs you lists it. A message you write during the steps goes along with the next one. While the table waits for you (stopped, or needs you), what you write goes on with the same task: it goes along with the stopped step when it continues, to the planner with the task if there is no plan yet, and otherwise to the builder as changes, which the planner then reviews again. A new task starts once the table is idle or done, or when it comes from Tasks. **Stop** halts the seat at work and **Continue** runs that step again, once the seat has stopped (the bar says **Stopping…** until then); an error stops it the same way (a step Trace itself could not finish says why on the bar), and after a restart the table comes back stopped at its step, with its plan, findings and a kept message. If the planner or reviewer stops on its own while the builder runs, the table refuses messages and tasks (they would reach the builder alone, unplanned and unreviewed) and offers **Reopen**, which starts it again with the work stopped at its step. A task's own `TASK COMPLETE` instruction is left out of the steps' prompts, since the planner's `APPROVED` decides; each seat may still end with `TASK BLOCKED:` when it needs you. The bar names the model at work on each step ("Opus 5.5 building…") and lists the three seats, each with what it is doing and its tokens today. In the thread each message is labelled with its model and seat; the planner has its own colour (lime), apart from the builder's amber and Codex's cyan. Each seat's model is on the bar under **Models**, used when that seat starts: the planner `claude-fable-5-2`, the builder `claude-opus-5-5` and the Codex reviewer `gpt-6-astra` by default. The reviewer no longer takes whatever Codex's own settings default to; a table saved before this gets `gpt-6-astra` for its reviewer when it starts again. Reviewer edits are declined as at any table.

## Tasks

**Tasks** (top bar, or G T) gives an agent a job, optionally limited to some files. **Save and send** types it into the channel.
- **Status:** every task asks the agent to end its reply with `TASK COMPLETE`, or `TASK BLOCKED: <what it needs>` (`shared/task-signal.ts`), as the reply's last line: anything after it, such as a question, means the task is not done. Each send gets its own id in the prompt (`Task t-1a2b3c4d: …`), and only replies after that prompt count, so an earlier task's reply, or one with the same title, never finishes this one. When a turn ends (Claude's Stop hook, or a chat reply), Trace reads the reply (a chat's from the conversation, a terminal's from the CLI's transcript; at a Round Table, the driver's): `TASK COMPLETE` moves the task to **Ready for review**; `TASK BLOCKED` keeps it in **Working**, waiting for you, with what it needs; any other ending keeps it there marked "not confirmed done". A channel that stops or fails, or a chat turn that ends in an error, leaves it in **Working**, marked, with **Send again**. A Codex terminal that has drawn nothing for 45 s is checked from its transcript the same way; without either line it gets a "may be finished" mark, cleared when it draws again. You can always move a task by hand.
- **Checks:** a passing verification result attached to a task says whether it still describes the task's files. Each run records the commit and the content of every changed file (up to 5,000 files and 256 MB; beyond that it says it cannot tell), and whether they changed while it ran.
- **Everything about this task:** what was asked, channel, folder, branch and commit, changed files, the check, the Round Table findings reported while it was its channel's task, and the pull request chosen for it (**For task** in Changes → Delivery).
- **At a Round Table** a task goes to both agents.
- **New worktree…** on a To do task creates a `coding-hub/<id>` branch and folder from the committed HEAD (uncommitted changes are not copied), applies the shared rules there, adds a Claude or Codex chat, moves the task to it and sends it. Dependencies are not installed.
- **Needs you** in the status bar, and at the top of the phone's channel list, lists everything waiting for you: approvals with the exact request and how long they have waited, failed channels, channels near a limit, and tasks that stopped (also after Trace restarts), went quiet or are ready for review.

## Approval alerts

When Claude Code or Codex stops to ask for your approval, its tile turns to HOLD, shows the request, and offers **Answer** in its header, which focuses that terminal. You answer the CLI's own prompt; the app never types an answer for you. The alert clears when you type in that terminal, or, for Claude Code, when it reports that a tool finished or its turn ended, so a prompt you answered before the alert arrived does not stay on HOLD.

- **Claude Code 2.1.63 or later:** the app adds HTTP hooks (Notification, PostToolUse and Stop) that report to a local endpoint (127.0.0.1) only the app knows. Tool results sent to it are never read.
- **Codex:** the app turns on its approval notifications and reads them from the terminal output.

Older Claude Code versions, `--bare`, or organisation settings that disable hooks leave a tile without alerts.

## Continuous integration

Every pull request runs **CI** (`.github/workflows/ci.yml`) on Linux: unit tests, release-path tests, the production build with type checks, and the seven desktop smoke tests against fixture CLIs on a virtual display. Pull requests that are ready for review (not drafts) also run the full **Windows release candidate** workflow, including the installer build and install, upgrade and uninstall test; its installers are uploaded only for `main` and manual runs.

## Windows installer and updates (v1.2)

The per-user installer creates Start Menu and desktop shortcuts and does not require administrator access. Installed editions provide **Settings → Application updates**, with automatic stable-release checks, explicit downloads, progress, and a confirmed restart. Checks contact GitHub; project contents and terminal output are not sent. Source and portable editions use manual upgrades.

Installation is blocked while CLI processes are running or starting. The app saves the workspace before starting the installer and blocks new launches during that restart. Downloaded updates do not install on ordinary app exit. All local settings, rules, history, and handoffs remain in `~/.coding-hub` across upgrades and uninstall.

A public stable GitHub release with its installer, `latest.yml`, and blockmap is required for live updates. No release has been published by this change. The manual Windows workflow builds and tests a reviewable candidate; [release instructions](windows-releases.md) cover signing and publication.

## Reliability and workflow improvements (v1.2)

- **CLI health:** inspect installed versions, advertised flags, and redacted local authentication status. Fresh discovery validates every launch. Unknown login or model access stays unknown; the app never tests model access through an API or bypasses CLI permissions.
- **Isolated worktrees:** in session settings, choose **Create isolated worktree**. This binds the panel to a unique `coding-hub/<uuid>` branch starting from committed HEAD. Uncommitted changes and untracked files are not copied. Apply shared rules in that directory before starting. Use Git diff with its repository selected, then combine branches through your normal Git review. Settings removes clean, unbound managed worktrees. Its branch is deleted with it only when its commits are already merged elsewhere (`git branch -d`), and so are earlier leftover `coding-hub/` branches no worktree uses; a branch with work of its own is kept. No automatic merges or commits.
- **Recovery:** interrupted processes are marked in history. **Restore launch settings to a session** creates an idle panel with its recorded repository and parameters; it never revives a PID. A recorded native conversation ID is retained when available; launch/resume still requires Start. With four panels, confirmation allows replacing the first idle panel; active panels are preserved. Start the new CLI when ready.
- **Rules validation:** the Shared rules page scans bounded project instruction files, warns about nested/local/override scopes, and offers defined npm `test`, `typecheck`, and `lint` scripts. A native confirmation precedes execution of project code and npm pre/post hooks. Output is capped at 512,000 characters and checks stop after 60 seconds. Semantic conflicts and compliance beyond test coverage cannot be guaranteed.
- **Memory history:** search handoff titles, content, and authors. Revise notes by creating new immutable handoffs linked to their originals. Concurrent revisions coexist. **Inspect Drive conflicts → Keep both versions** preserves both reviewed contents under separate IDs and a backup of the conflicting remote file; stale resolution is rejected. The local folder mirror is tested, while Google Drive owns actual cloud transport.
- **Usage evidence:** each run shows its CLI JSONL source, reported-count label, event count, and configured-price basis. Missing/invalid primary token fields stay unknown. Costs use current exact-model rates and recalculate historical estimates when rates change; they are not billing records.
- **Display and keyboard:** Settings offers 80–125% interface scale, compact/comfortable density, and higher contrast. `Alt+1–8` focuses sessions, `F1` opens help, and `Ctrl/Cmd+Shift+P` opens commands. Visible focus, a skip link, and reduced-motion support improve navigation. Display settings remain in the local Electron profile, separately from synced memory.

## Help and shared rules (v1.1)

**Help & AI guide** provides searchable local articles covering AI agents, models, reasoning, tokens/context, MCP, skills, plugins, hooks, permissions, instruction scope, memory, prompting, review, usage, authentication, Windows setup, and troubleshooting. Search titles and article text, filter by category, and follow related topics. The guide is available offline and can be opened from navigation, the top bar, or the command menu.

**Shared rules** provides one saved rule document for Claude Code and Codex:

1. Open Shared rules and write your expectations, or use the example as a starting point.
2. Select the workspace root, independent session repositories, and any additional project folders you want to receive them. Previously registered projects are listed too.
3. Choose **Save and apply**. The identical managed section is written into each selected project's `CLAUDE.md` and `AGENTS.md`. Existing text and shared-memory sections are preserved; private backups are created.
4. Restart running sessions to load the new instructions. When nonempty shared rules exist, the native host refuses new launches in a directory unless both engine files contain the current saved version. Apply the rules to a new project before starting its sessions.

The rule source is local at `~/.coding-hub/shared-rules.json`; it is separate from Drive handoff notes. Updating the rules applies them to selected projects. Unselected projects with an older version must be updated before their next launch through Trace. CLI sessions started outside this app use their own normal instruction discovery.

Saving with no projects selected stores the rule draft locally. Clearing the editor and saving removes only the managed rules section from selected projects. Refresh/reload explicitly replaces an unsaved draft. Stale project files and stale saved-rule revisions are rejected rather than overwritten; failed multi-file saves roll back completed replacements when no external edit or file lock prevents restoration.

These rules are real project instructions, not a guarantee of model compliance. Higher-priority engine instructions, nested project files, and CLI permissions still apply. Resolve contradictory instructions and verify results. Tests, hooks, permissions, and CI provide mechanical enforcement when required. Rules do not automatically commit, deploy, or change permission settings.

## Automatic shared memory

Every Claude Code and Codex session started in Trace gets shared project memory automatically, in every project, with no changes to project files. Turn it off in **Settings → Automatic shared memory for every project**.

- **At launch** the session receives the project's most recent handoff notes (up to about 6,000 characters and eight notes, labelled as history rather than instructions: notes someone wrote first, newest first, then at most two automatic session summaries in the space left) and the `coding-hub-memory` tools **read_memory** and **write_handoff**. Claude Code gets them through `--append-system-prompt` and `--mcp-config`; Codex through `--config developer_instructions` and `--config mcp_servers.…`. Any `developer_instructions` already set in your Codex configuration are kept and come first.
- **When the session ends** Trace writes a summary note: the files that changed during the session (from `git status`), commits made, and the agent's last message. Sessions that changed no files, made no commits and ended on a message under 200 characters (or none) are skipped, and so are the hidden agents at a Round Table (the partner, planner or reviewer): the leading channel's summary covers the table. Agents can still write fuller handoffs with **write_handoff**.
- **Project keys are automatic.** Clones and worktrees of the same Git remote share one key on every computer (for example `app-1a2b3c4d5e`); unrelated folders with the same name stay separate. **Shared memory** shows the key for the selected project.
- **Memory tools:** `read_memory` (newest first; `query` returns notes containing every word; `supersededBy` marks replaced notes; `commitStatus` says whether commits a note names are in this clone and on remote branches, as of the last fetch), `write_handoff` (`supersedes` to revise a note, `open_items` for what is still to do, `commits` for commits it made; `author` defaults to the engine Trace started), `list_open_items` and `resolve_open_item`. Codex is started with `default_tools_approval_mode="approve"` for Trace's own memory server only, so chats and Round Table reviewers can use them.
- **Pinned decisions** are notes titled `Decision: …`, retired by a `Retired decision: …` note that supersedes them (`write_handoff` `decisions`, `list_decisions`, `retire_decision`); they come first in the launch notes.
- **Open items** are notes titled `Open item: …`; resolving one writes `Resolved: …` that supersedes it, so every version of Trace and Drive sync handle them. They come first in the launch notes, and **Shared memory** lists them with **Resolve** and a field to add one.
- **A channel's memory project:** **Shared memory project** in a channel's settings picks another project's notes; a Round Table uses the leading chat's. A channel started in the home folder without one raises a notice.
- Applies only to sessions started in Trace. For CLIs run from other terminals, or for teammates who clone the repository, use the project installation below. When a project already has `coding-hub-memory` installed, sessions use that server instead of adding a second copy. If that entry points at a program that no longer exists (for example after an update moved the app), Trace updates its paths to the current install and says so. If it uses a different memory key from the folder's automatic key, Trace warns, because those sessions read and write the other key's notes.

## Shared Google Drive memory

On Windows the default shared folder is **`G:\My Drive\Coding Hub`**; on a Mac there is no default, so choose the folder Google Drive for desktop keeps there. When the folder can't be used (none chosen, not a full path on this computer, or missing), Memory and Settings → Sync between computers say why, with Drive folder ID `1X057crI-PHRV3ie1tl5btF4bUbuhxzwM` retained as a reference. Google Drive for desktop handles authentication and cloud upload; no separate OAuth credentials are required by Trace.

1. Confirm **Settings → Local Drive folder** points to the actual synced/mounted folder. Save preferences if you change it.
2. Open your project, then open **Shared memory**. Use the same **shared project key** on every desktop participating in that project's handoffs. Different project keys keep notes separate.
3. Optional (automatic memory covers sessions started in Trace): use **Enable memory for both CLIs** and review the changes, then **Install local memory server**. It uses the folder's automatic memory key when one is available, so terminal sessions and sessions started in Trace share notes. This adds a `coding-hub-memory` entry to project `.mcp.json` and `.codex/config.toml`, and appends marked instructions to `CLAUDE.md` and `AGENTS.md`. Existing files receive private backups. Existing server entries with that name are never silently replaced.
4. Restart the CLI sessions. Approve the MCP server / project trust through the CLI's normal controls. The local server exposes **read_memory** and **write_handoff**.
5. Save a manual handoff or ask the agent to record its decisions, changed files, checks, remaining work, and blockers. The next agent can read those notes through MCP.

Notes are stored locally at `~/.coding-hub/memory/<project-key>/<uuid>.json` and mirrored into `G:\My Drive\Coding Hub\AI-Coding-Hub-Memory\<project-key>\`. Sync is additive and retries every 30 seconds for projects opened in the app; **Sync now** gives an explicit result. If Drive is offline, notes remain local and sync later. Conflicting note IDs preserve both files and require review. Google Drive may create its own conflict copies; these are not silently merged.

The app reports folder synchronization, not Google's cloud upload completion. Check Drive for desktop's own status when moving between machines. The existing Drive folder URL is a reference; the app uses the local folder, not a website connector. Terminal logs, SQLite databases, and credentials do not sync. Conversations are not automatically copied between agents; curated notes are read as project data. The memory server uses the app's current executable and compiled source paths; reinstall its project entries if you move the app directory or switch to a packaged executable.

## Sync between computers

Turn on **Settings → Sync settings, rules, templates and usage between computers** on each computer, with the same Drive folder. Every 30 seconds (or with **Sync now**) Trace exchanges these through `AI-Coding-Hub-Sync\` in that folder:

| Item | How it merges |
|---|---|
| Settings (price rates, terminal font size and rendering, automatic memory) | A change on one computer is taken by the others. The Drive folder and the sync switch stay per computer. |
| Shared rules (the text) | Same as settings. Rules that arrive from another computer are saved but not applied to this computer's projects; Shared rules says where they came from, and those projects' sessions do not start until you apply them. |
| Project templates | Merged as a set; deleting one deletes it everywhere. |
| Usage history | Each computer writes only its own file. Usage shows other computers' sessions with the computer's name; the status bar's today total counts this computer only. |

If settings or rules change on two computers before they sync, nothing is overwritten: **Settings → Sync between computers** shows the conflict and lets you keep this computer's version or take the other one. Running sessions, recorded output, the project list, verification profiles and account sign-ins stay on each computer. Usage records include project folder paths, so they are visible to anyone with access to the Drive folder.
## Phone access

Read and type into running channels from your phone, including answering approval prompts. It is off until you turn it on in **Settings → Phone access**.

1. **Install Tailscale** on this computer and your phone (tailscale.com/download), signed in to the same account. Tailscale is a private network between your own devices; nothing is opened to the internet.
2. **Set up Tailscale HTTPS.** Trace asks for confirmation, then runs `tailscale serve --bg --https=443 http://127.0.0.1:47821`. Your tailnet must have HTTPS certificates turned on (Tailscale admin console → DNS). If they are off, or Tailscale wants Serve approved, the card shows the steps, opens the Tailscale page, and tries again by itself when you come back to Trace. Remove it later with `tailscale serve reset`.
3. **Pair a phone.** Scan the QR code with the phone's camera, or open the address shown and type the code. A code works once, for five minutes and ten tries.

On the phone:

- **Add it to your home screen** (Share → Add to Home Screen on iPhone, or Install app on Android) so it opens like an app.
- **Channels** lists every channel with its state; one that needs you is outlined and shows the request.
- **A channel** keeps the desktop's size while you use the computer: the phone shows that layout with its text shrunk to fit the screen's width (swipe sideways if it is still wider). Once the computer has had no keyboard or mouse input for two minutes, the phone redraws the channel at its own size (like tmux), and the desktop's size comes back as soon as the computer is used again. **Fit to phone** takes the phone's size at once, until you type in that channel at the desktop; **Desktop size** gives it back. **A− / A+** change the text size, and so how much fits. The CLI also gets the desktop's size back when you leave the channel on the phone or the phone disconnects.
- **Scroll** by swiping up or down over the channel. **Copy** opens the channel's text, where you can press and hold to select part of it, or **Copy all**. Tap the terminal to open the message box, use the key row (Enter, Esc, arrows, 1–3, y, n, Tab, Ctrl C) for prompts, or type a line and press **Send**.
- A restarted channel starts its screen afresh. **Conversation** in a Claude Code or Codex channel shows its whole conversation from the CLI's own transcript, including what was said before restarts, also for channels on linked computers.
- **Screen** at the top of the channel list shows the computer's screen and controls it: tap to click, drag to move, type in the field under it, with keys for Esc, Tab, Return, Backspace and the arrows. It goes through that computer's own screen-sharing server, relayed by Trace over the same remote: on a Mac, macOS **Screen Sharing** (turned on once there), which asks for its user name and password (they go to the Mac, not Trace); on Windows, Trace's screen service, when **Share this screen** is on there, which lets in a phone with **Can start and stop agents** on (Settings → Phone access, off by default; turning it off closes the phone's open screen), with no other password (the phone is named by the clock while it watches, and replaces any other viewer). The phone opens it with a one-time ticket (30 seconds, one use), at most two at once. A locked Mac shows black and takes no keys. The phone uses /api/phone-screen-ticket and /api/phone-screen, since a Windows computer that shares its screen passes /api/screen to its screen service.
- **Remove this phone** at the bottom of the list unpairs it.
- **Chat channels** (Claude chat, Codex chat) are the conversation itself, as on the computer: messages, tool cards, approvals, photos from the camera or library, Stop, and a Round Table's bar. What you send from the phone also shows on the computer.
- **Tabs along the bottom:** **Usage** (today's tokens and cost, the daily budget, and each account's plan limits), **Tasks** (the task board), **History** (conversations to resume), and **More** (memory handoffs for this computer's projects, with **Leave a handoff**, and the computer's screen).
- **Can start and stop agents** (Settings → Phone access, per phone, off by default) lets that phone start, stop, restart and add channels (**+**), move tasks, resume conversations and open a Round Table. Without it, those controls do not show, and the computer refuses them.
- **Alerts:** **Turn on alerts** under the channel list, and the phone gets a notification when a channel needs you or stops with an error, even with Trace closed. Tapping it opens that channel. On iPhone and iPad this works once Trace is added to the Home Screen and opened from there (iOS 16.4 or later). Settings on the computer shows which phones have alerts on and can **Send test alert**.

Alerts use Web Push. Trace encrypts each alert on the computer for that phone only (RFC 8291) and signs the request with a key of its own (VAPID, `remote-push.json`); the browser's push service (Google, Apple, Mozilla or Microsoft) carries it but cannot read it. The computer only ever sends to those push services, at most one alert per channel every 20 seconds.

How it is protected:

- Trace listens only on this computer (`127.0.0.1:47821`); the phone reaches it through Tailscale, which encrypts the connection and admits only your devices.
- Every request also needs the key a phone received when it paired. Only a hash of each key is stored (`remote-devices.json`), and **Remove** in Settings locks a phone out at once. Turning phone access off closes the listener.
- Requests must name this computer or its tailnet address, and Tailscale Funnel (public internet) requests are refused.
- A paired phone can read channel output and type into channels that are already running, the same as typing at the desktop, and use chat channels: send messages (up to 10 images), answer approvals, interrupt, and take part in a Round Table. It cannot start, stop, close or add channels unless **Can start and stop agents** is turned on for that phone in **Settings → Phone access** (off by default; it also lets the phone seat a Round Table partner). It cannot reconfigure channels or reach any other part of Trace, except **Screen**, which still needs the computer's own sign-in. Treat a paired phone like an unlocked keyboard on this computer, and remove phones you no longer use.

## Other computers

Trace on each of your computers can link to the others and show their channels.

- **Finding each other.** With sync between computers on, each computer writes its phone remote's tailnet address (never a key) to `AI-Coding-Hub-Sync/computers/<machine id>.json` in the Drive folder. **Settings → Other computers** lists the others. Only `https://<name>.ts.net` addresses are used, so a record in Drive cannot send a code or key anywhere else.
- **Linking.** **Show link code** on the computer to be reached gives a code for computers (five minutes, one use). The code decides what is created: a computer code gives a key that may also start, stop and restart channels; a phone's code cannot link a computer. The key is kept in `linked-computers.json` in this computer's data folder, and the other computer stores only its hash. **Unlink** removes it on both computers; the other computer can also **Remove** it.
- **Alerts:** when one of another computer's channels starts waiting for you or stops with an error, Trace shows a notification if its window is not in front (clicking it opens that computer's tab), and the status bar's alert cell lists it. Failures are reported by Trace 1.15 or later there. This computer's own channels notify the same way; **Settings → Alerts and daily budget → Desktop notifications** turns all of them off.
- **Daily budget and plan limits:** in **Settings → Alerts and daily budget**, a daily token budget and a daily cost budget (new tokens and estimated cost on this computer, as **Σ today** counts them), and the share to warn at (80% unless changed). Trace checks every minute and notifies once at that share and once when a budget is used up, even while it is in front; **Σ today** turns amber, then red. Claude's and Codex's own session and weekly limits (as the status bar shows them) are warned about the same way, once per window. What was said is kept in `usage-alerts.json`, so a restart does not repeat it.
- **Update:** **Update** on another computer's tab installs the latest Trace there and restarts it, after you confirm, once its channels are stopped. A copy that updates itself (Windows, or a Mac signed with Trace's Developer ID) uses its own updater; a Mac copy that cannot downloads the new version, checks it, swaps it in and waits until it answers on port 47821, and puts the old version back if it does not within two minutes (log: `/tmp/trace-update.log`). It needs Trace 1.15 or later there.
- **What a linked computer can do:** follow every channel's output (one stream), type and paste text into channels, add channels (**+ Channel** on that computer's tab adds a Claude Code, Codex, Gemini CLI or Terminal channel there, in its own workspace; chat channels are added only on the computer itself), and start, stop, restart or close them (**Close** asks first, stops the channel if it runs, and keeps that computer's last channel). The desktop window on the computer that runs a channel carries the request out, as its own buttons would. If that window is closed, the request is refused.
- **The tab.** Each linked computer gets a tab after the main views. While it is open and nobody uses that computer, each tile asks for its channel at the tile's size; otherwise the terminal keeps the other computer's columns and rows and scrolls. Ctrl+V pastes text, as in channels here. An image pasted into a Claude Code or Codex channel there (Ctrl+V on Windows; ⌘V or Ctrl+V on a Mac) is sent to that computer, which puts it on its own clipboard and presses the CLI's image key, as a paste there would; it replaces what was on that computer's clipboard. PNG and JPEG, up to 15 MB; it needs 1.12.1 or later on both. A count on the tab shows channels there that need you. Tiles move by their grip and resize by their corner; the arrangement is kept on this computer, per linked computer, and leaves that computer's own layout as it is. **Conversation** on a Claude Code or Codex tile shows that channel's whole conversation, including what was said before restarts.
- **Screen.** **Screen** on a linked computer's tab shows that computer's screen and lets you control it, through its own screen-sharing server (macOS **Screen Sharing**, port 5900) rather than through Trace, so it also works while Trace is closed there. Turn it on once on the Mac: **System Settings → General → Sharing → Screen Sharing**. Trace connects only to a linked computer's `<name>.ts.net` address, over Tailscale. Sign in as a user on that Mac; **Save on this computer** keeps the password encrypted by the system (Windows DPAPI, the macOS Keychain) in `screen-sharing.json`, and **Forget password** removes it. **Control** switches to **View only**, which sends nothing. **Ctrl as ⌘** (on by default on Windows, where the Windows key can't be sent) sends Ctrl as Command, so Ctrl+C, Ctrl+V and Ctrl+Tab do what a Mac expects; Ctrl+V first copies this computer's text to the Mac. Text copied on the Mac reaches this computer's clipboard. **Channels** goes back to the tiles and closes the connection. A screen that was showing and drops connects again by itself (**Reconnecting…**), after 1, 3 and 6 seconds; if all three fail, it shows **Disconnected** and why, and waits for **Reconnect**. The count starts again once it has stayed connected for 30 seconds. A first connection that fails, or a refused sign-in, is not retried. **A locked Mac** sends its screen black to viewers other than Apple's, so when Trace there says it is locked (asked every 5 seconds over the link), the screen shows **…is locked** with a password field. When Trace there cannot say (it is closed, or older than 1.13.1), **Unlock** in the bar opens the same field. **Wake and unlock** taps Shift to wake it and bring up its password field, types the password there and presses Return, then checks again; **Use saved password** uses the saved sign-in, which is the same password. Nothing about the password is sent to Trace on the Mac: it goes as keystrokes through Screen Sharing, like typing it there.
- **Sharing a Windows screen.** Windows has no screen-sharing server, so Trace provides one: **Settings → Other computers → Share this screen** (Windows only, off by default) lets linked computers see and control this screen with **Screen**, also while Trace is closed. It starts a background service (Trace run with `--screen-service`, about 100 MB while someone watches), registers it to start when you sign in (**Trace screen sharing** under Settings → Apps → Startup), and has `tailscale serve` pass `https://<name>.ts.net/api/screen` to it on port 47822, which listens on this computer only. A linked computer signs in with the key it was linked with; a phone comes through Trace's phone access, and only with **Can start and stop agents** on for it (Trace signs in for it with its own key, in `screen-service-local.json`, after checking the phone's one-time ticket), and a phone's own key is refused; and **Remove** under Other computers locks that computer out at once. One viewer at a time. While someone watches, a Trace icon by the clock names them and has **Disconnect**. Every display is sent as one picture, arranged as in Windows' display settings (one display scaled to 1920×1200 at most; several to 3840 wide and about two 1920×1200 screens' worth of pixels at most), as JPEG, only the parts that change, sent again sharper once the screen has been still for 0.4 s (so text that stays put is crisp); at most two updates are on their way at once, each confirmed by the viewer (an RFB fence), so a slow link gets fewer, newer pictures rather than a queue of old ones. With several displays, **Display** in the bar shows one of them on its own (numbered from the left) at the size one display gets, or all of them again; clicks map onto whichever display they land on (SendInput's virtual-desktop coordinates); keys and the mouse are pressed through Windows PowerShell, which every Windows has, so nothing else is installed; it starts when the viewer connects, so the first clicks are not held up. If the capture stops (a display's capture ends, or it fails) or the displays change (one added or removed, or a resolution or scaling change), the session ends and the viewer connects again to a capture of the new layout. On a Mac viewing it, **⌘ as Ctrl** (on by default) sends ⌘ as Ctrl, so ⌘C and ⌘V copy and paste. If the capture does not start within 20 seconds, the viewer is told so (rather than that sharing is off) and can **Reconnect**; turning **Share this screen** off and on restarts the service. If the service stops on an error, it starts itself again (unless that happens within a minute of starting), and Trace, while open, checks every minute and starts it again if it has gone. Limits: the computer must be on, awake, signed in and unlocked (while Trace there is open, the viewer says when it is locked: Windows takes no keys or clicks from other programs at its lock screen, so it must be unlocked at the computer); apps running as administrator can be controlled only with **Also control apps running as administrator** (below); the clipboard carries text only: any text with Trace's viewer (noVNC's extended clipboard), Latin-1 with other VNC viewers. **Also control apps running as administrator** (under Share this screen) runs the service as administrator: Windows asks permission once (an administrator account is needed) to register a scheduled task, **Trace screen sharing (administrator)**, which starts it with the highest rights when you sign in (and up to three more times if it fails), in place of the sign-in entry; Trace starts that task without asking. Windows prompts and the lock screen still cannot be controlled. **What it costs:** the service then runs as administrator at every sign-in without Windows asking, and Trace is installed per user, in a folder your account can write to, so any program running as you could replace Trace's program there and get administrator rights without a prompt; and anyone viewing the screen controls apps running as administrator. Turning it off asks permission again to remove the task. Turning sharing off stops the service and removes the sign-in entry and the Tailscale path (an administrator task left registered starts nothing while sharing is off). The switch is `screen-share.json`.
- **Phones.** A computer passes linked computers' channels on to its phones, never to other computers, so channels cannot loop. Every channel the phone sees names its computer, and the phone can switch between computers. The phone also asks its computer for a phone key to each other linked computer (issued as "<phone> (through <computer>)"; asking again replaces it). When its own computer does not answer, the phone app opens from its saved copy and connects straight to another computer with that key, then switches back when its computer answers. Those computers accept requests from the phone app's origin only when it is one of your computers' tailnet addresses, and still require a key. Phone keys never start or stop channels.

## Workspace

- Open a local project and launch each engine independently. CLIs inherit local authentication, environment, Git context, hooks, and tools. There are no direct model API requests or approval-bypass flags.
- Run **2–8** configured panels (each runs its own CLI, so more panels use more memory); duplicate, close, drag, resize, split into rows/columns, arrange a grid, or isolate a session. Panels may share the root or use independent repository directories. Launch settings lock while running.
- Click a terminal to type or paste. **Interrupt / Ctrl+C** interrupts an operation; **Stop** ends the process. Xterm supports ANSI output, interactive prompts, resize propagation, and a WebGL renderer with fallback.
- **Show explorer** opens a file tree beside the terminals. **Files** provides the larger source preview; **Changes** provides staged, unstaged, untracked, renamed, binary, and conflict diffs. Choose workspace or session context to review another repository. Refresh after agent changes. These views do not stage, discard, or commit; run Git commands in your normal workflow after review.
- **Ctrl+Shift+P** (Cmd+Shift+P on macOS) opens the command menu. Switching pages retains the same terminal and scrollback.

Closing/reloading stops the app's PTYs. The app restores directory bindings, models, raw settings, and layout as **idle** panels. It does not attach to old PIDs or resume an agent conversation automatically. **Restart** starts a new CLI process; use the CLI's own resume controls for prior conversations. Detached background jobs and remote processes have their own lifetimes.

File previews are bounded to 1 MiB / 4,000 rendered lines; folders list up to 500 entries. UTF-8 and BOM-marked UTF-16 are supported. Links and special files cannot be opened; Git metadata is hidden. Git commands have a ten-second timeout and 2 MiB output limit; lists cap at 1,000 changed paths. Limits and unsupported encodings are reported in the interface.

## Raw engine controls

Blank fields inherit local CLI settings. Suggested model names are editable examples; your CLI and account determine model availability.

**Claude Code:** model maps to `--model`; manual `thinking.budget_tokens` maps to `MAX_THINKING_TOKENS` only for explicit supported manual-thinking models. Adaptive-thinking aliases/default models are rejected when a manual budget is configured. The budget must be at least 1,024 and smaller than an explicit output limit. Maximum output tokens maps to `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. A session token threshold stops the process **after reported new tokens** (input outside the cache, plus output) reach it; a response may exceed it. Enforcement requires structured transcript usage and advertised `--session-id` support. It is not a hard request-level billing cap.

**Codex:** model maps to `--model`; reasoning maps to `--config model_reasoning_effort="<effort>"`. Choices are `none`, `low`, `medium`, `high`, and `xhigh`; supported efforts depend on the selected model. When advertised, `--no-daemon` keeps the session attached to its PTY.

Windows npm launchers resolve to the official package's declared JavaScript entry and run in Electron's Node mode with argument arrays, without shell interpolation.

## MCP, skills, plugins, and hooks

**MCP servers** inspects Claude's global `.claude.json` (including a custom CLAUDE_CONFIG_DIR / legacy `.config.json` when applicable), project-local server entries, project `.mcp.json`, and Codex's user/project `config.toml`. Environment and header names are displayed without their values. The legacy `~/.claude/mcp.json` is identified if present but is not treated as automatically active in current Claude Code.

Add stdio or HTTP servers, toggle enablement, or explicitly remove them. Claude toggles are project scoped; select a project before toggling its user servers. Edits preserve unknown settings, reject stale inspected files and parse errors, create private backups, and replace the target atomically. TOML comments and formatting may normalize. Enabled means configured; server health, authorization, and project trust are verified by the CLI when it starts. Restart sessions after edits.

**Skills & plugins** inspects local `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, skill folders, installed plugin metadata/cache manifests, configured plugin activation, and hook event names. Supported Codex skill and configured plugin activation can be toggled. Instruction files and Claude skills are inspected in place; hook commands are never executed by discovery. Inspection is bounded and does not resolve remote marketplaces or install third-party packages.

## Plan limits

The status bar shows how much of each subscription's limits is used, for example **Claude 5h 6% · wk 12%** and **Codex wk 3%**, amber from 75% and red from 90%. Hover for every limit, account and reset time; click for **Usage**, whose **Plan limits** card shows each limit as a bar, the plan, and **Check now**.

- **Claude:** Trace runs Claude Code's own `/usage` (`claude -p /usage --no-session-persistence`) for the default login and each connected account profile. It makes no model request and saves no session.
- **Codex:** Trace asks Codex's app server for `account/rateLimits/read`, also without a model request. Codex names its limits by length (a 5-hour session on plans that have one, and the week).
- Limits are read when Trace opens, every five minutes, and when you return to the window (at most once a minute). Accounts billed by API usage have no session or weekly limit to show.

## Usage and prices

Usage comes from the CLIs' **local structured JSONL session logs**. Claude sessions are correlated by the app's generated UUID; Codex uses a per-run TUI log directory and thread ID to locate its rollout. CODEX_HOME and CLI authentication are inherited unchanged. Same-directory Codex sessions are not assigned usage when their thread association is ambiguous. Unsupported versions, disabled transcript logging, or missing usage events display unknown values.

Repeated Claude message snapshots are deduplicated; Codex cumulative events replace earlier totals. Claude cache reads/writes are separate from noncached input. Codex cached input is already included in input, and reasoning tokens are already included in output. Missing reasoning or context limits remain unknown. Context percentage is shown only when the CLI supplies a usage/window pair.

Configure model IDs and **USD per million tokens** rates in **Settings → Model pricing**. An exact ID wins; otherwise a rate also matches the same model logged with a release date (`-YYYYMMDD`), ignoring case. Context-size variants such as `[1m]` are not merged. Unconfigured models show no cost estimate. Rates are user supplied; estimates are not an invoice and exclude discounts and billing adjustments. The Usage dashboard provides per-run counts, estimates, and the latest 14 active days. Daily totals group entire runs by session start date in local time, including sessions crossing midnight. Usage records retain up to one year and the UI loads the latest 2,000 runs.

## Local storage

All runtime data is outside the source folder, normally `C:\Users\<you>\.coding-hub` on Windows:

| Location | Contents |
| --- | --- |
| `storage.db` | Workspace settings and session run metadata |
| `logs/<run-id>.log` | Terminal output, up to 5 MiB per run |
| `telemetry/usage.db` | Deduplicated usage records and run metadata |
| `preferences.json` | Drive directory, terminal font size, price rates, sync switch |
| `machine.json`, `device-sync.json` | This computer's sync identity and name, and what was last synced between computers |
| `worktrees.json`, `worktrees/<uuid>/` | Managed isolated branches and working directories |
| `updates.json` | Automatic update-check preference |
| `shared-rules.json` | Canonical shared rules and registered project directories |
| `memory/<project>/<note-id>.json` | Curated handoffs |
| `designs/`, `design-annotations.json` | Left by the Design workspace, which was removed. Trace no longer reads or writes them; backups still include them, and nothing deletes them |
| `coaching/`, `experiments.json` | Curated examples, prepared reports, A/B trial evidence |
| `tasks.json`, `verification.json` | Task scopes, command profiles, recorded check results |
| `backups/`, `restores/` | Verified backups and separate restored data copies |
| `linked-computers.json`, `screen-sharing.json`, `screen-share.json` | Keys to linked computers, screen-sharing sign-ins (passwords encrypted by the system), and whether this Windows screen is shared |

Finished output retains up to **100 runs for 30 days**; active runs are excluded from pruning. The history viewer shows the last 1 MiB of large logs, strips ANSI escapes, and identifies capped/interrupted runs. Normal closing requests a final settings snapshot, stops processes, and flushes logs. Invalid/future saved data is preserved rather than overwritten. Storage failures do not prevent basic interactive CLI execution.

Storage is local and unencrypted. Logs include whatever a CLI prints, including echoed input. Input, environment variables, and authentication files are not collected separately. To change the storage root, set `CODING_HUB_STORAGE_DIR` to an absolute writable path before launch.

## Build and verification

```sh
npm run typecheck
npm test
npm run test:pty
npm run test:memory
npm run test:desktop
npm run test:design
npm run test:profiles
npm run test:workbench
npm run test:enterprise
npm run test:productivity
npm run build
```

The desktop smoke test uses test CLIs and isolated real repositories, databases, and a local Drive-folder fixture. It exercises production Electron/preload, actual PTYs, input/resize/retention/cleanup, file and Git review, unchanged index bytes, usage/cost updates, MCP toggles, skill inspection, shared notes/Drive mirror, restoration, unavailable storage, help search/navigation, matching rules in both engines, and launch rejection for unapplied rules. The standalone memory smoke checks an actual stdio MCP process across Claude/Codex fixture sessions.

Cloud Linux validation does not replace authenticated model completion tests or native Windows/macOS testing. Drive folder mirroring is tested locally; actual Drive authentication/upload is managed by your desktop installation and cannot be verified from the cloud machine. The Windows installer and update lifecycle are prepared; live distribution requires a published release. See [Windows releases](windows-releases.md).

Optional Windows installer and portable build:

```powershell
npm.cmd run dist:win
```

Outputs go into `release/`. Publishing is disabled. Builds are unsigned unless a signing certificate is configured. The output includes Setup.exe, Portable.exe, latest.yml, and an installer blockmap. The build checks PE architecture, native terminal helpers, and application assets, but does not prove native Windows behavior. node-pty uses real filesystem paths, so the package disables ASAR and retains required runtime helpers.

## macOS/Linux and cloud setup

Use `npm ci`, then `npm run dev` on a graphical desktop. Linux source builds need Python 3, make, a C/C++ compiler, and Electron's GTK/NSS/X11 libraries. macOS may require Xcode Command Line Tools. Windows uses supplied ConPTY binaries; native source rebuilding requires appropriate Visual Studio C++ tools and Windows SDK. `npm run rebuild:native` repairs the binding if needed.

For a read-only cloud home, use writable caches:

```sh
npm_config_cache=/workspace/.cache/npm npm_package_config_node_gyp_devdir=/workspace/.cache/node-gyp electron_config_cache=/workspace/.cache/electron ELECTRON_GET_USE_PROXY=1 NODE_USE_ENV_PROXY=1 npm ci
```

Keep TLS and package/artifact integrity checks enabled. `CODING_HUB_TEST_NO_SANDBOX=1` is a test-only desktop runner flag for restricted Linux CI; the production launcher does not supply it. `npm run dev:web` renders a browser preview, which cannot access local processes or native integrations.

See [the folder structure and architecture](architecture.md), [domain interfaces](../shared/types.ts), and [native bridge contracts](../shared/ipc.ts).
