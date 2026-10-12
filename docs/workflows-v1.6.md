# AI Coding Hub 1.6 workflow guide

## Diagnose a connection

Choose **Accounts & connections**, select the engine and (for Claude) account profile in diagnostics, then run the checks. Installation, advertised flags, login status, configuration syntax, working directory, and a real stdin/stdout terminal probe are checked locally. Configuration contents and credentials are excluded from the report. A successful login does not establish model access, billing, or a successful task. Start a session and send a small task for that final check. Follow the recovery guidance beside a failed check.

## Identify the app you opened

**Settings → Running application** shows renderer and native host versions, source/installed/portable edition, executable, app folder, and active data folder. A mismatch is reported explicitly. Launching an old installed shortcut still opens the old installation. To run this source release, extract it and run `npm.cmd ci`, then `npm.cmd start` from its `package.json` folder. Installed copies require rebuilding and installing the new Setup.exe.

## Resume a native conversation

Open **Session history → View native CLI conversations**. Refresh searches Claude Code project logs, named Claude profile logs, and Codex session/archived-session logs. The bounded scan lists metadata without loading full prompt contents into the UI. Choose **Resume in new tile**, or choose a replacement folder if the original moved. Make room by closing an idle tile when four tiles are present.

The tile uses the native conversation UUID and original account profile; it remains idle until you click Start. The installed CLI must advertise resume support. Concurrent launches of the same conversation/account are blocked within Coding Hub. Processes launched outside the app are not tracked. New-run usage skips preexisting Claude events and subtracts previous Codex cumulative totals. Context usage still describes the conversation's actual context, including prior turns. This does not import claude.ai or Claude desktop chat history.

## Review a live design

Start your project's development server using your normal local workflow. In **Design workspace**, expand live preview/review and enter an HTTP(S) URL on `localhost`, `127.0.0.1`, or `[::1]`. Approve only a server you trust. A separate sandboxed browser window supports JavaScript without a Coding Hub preload, Node integration, downloads, requested permissions, or access to other network origins. Same-origin HTTP/WebSocket requests work; external/CDN resources are blocked. Browser isolation does not restrict what the server's backend can do with its own permissions.

Capture the visible viewport as a saved immutable image. Select it and click positions on its annotation view or enter percentage coordinates, then save a comment. Prepare Claude/Codex feedback to create an idle tile containing the selected preview, annotations, and shared rules. Start it, handle CLI trust prompts, then click **Send design feedback**. This optional inference uses the chosen provider CLI account. Preparing feedback sends nothing automatically. The feedback request asks for recommendations without commands or edits; actual permissions still come from the CLI. Previously imported static HTML continues to block scripts and network access.

## Compare coaching experiments

In **AI coaching**, create an experiment with a hypothesis, success criterion, and exact A/B prompt wording. Run comparable tasks through the normal CLI tiles, then record each trial with its variant, recorded run, minutes, rework count, outcome, and evidence. Each measured run can be used once per experiment. Unlinked trials are allowed and clearly have no measured tokens.

The comparison shows sample counts, successful outcomes, mean self-reported time/rework, and mean tokens for linked runs with available telemetry. Missing telemetry remains unknown. Cached/reasoning tokens are not double-counted. These are descriptive comparisons; differing task difficulty, models, context, or tools can explain differences. No experiment automatically launches agents or asserts causal improvements.

## Back up and restore

Stop sessions, logins, and verification jobs. In **Settings → Local backup and recovery**, create a backup, optionally including output logs, then export it if desired. SQLite databases are snapshotted with WAL contents. Every file has a SHA-256 hash; import/restore validates paths, sizes, and hashes before offering activation. Backups support 64 MiB total, 16 MiB per file, 10,000 files, and 50 local records. They are unencrypted.

Included: workspace/layout settings, coding history and token usage, preferences, shared rules, curated memory, design archive/annotations, prepared reports, experiments, tasks, verification profiles/results, managed-worktree metadata, and Claude profile labels. Excluded: CLI credentials, profile credential directories, external repository contents, and external project instruction files. Do not treat a backup as a replacement for Git or repository backups. Reauthenticate named Claude accounts after restoring; default host authentication remains with its CLI.

Restore writes a separate directory below the base data folder's `restores/`, leaving the active data untouched. Review and confirm the prepared copy, then explicitly restart to activate it. App-managed report directory references are rebased to the restored copy; external project paths stay unchanged and must exist. A local desktop-profile pointer selects the restored data root. The UI shows the active path. To recover the original base data manually, close the app and move aside `storage-location.json` in its Electron user-data/profile folder. Keep original data until you have verified the restore.

## Coordinate tasks and run verification

**Task coordination** assigns a session, repository, and explicit relative paths or `directory/**` scopes. Use queued/active/review/done statuses. Audit reads Git status, lists current changed files, flags overlap, and identifies changes outside all task scopes. It does not attribute edits to an agent or enforce filesystem restrictions. Completion needs review notes; optionally link a passing check for the same directory. A recorded result describes files at the time it ran, so rerun after edits.

**Verification profiles** saves ordered checks as tool names plus JSON argument arrays, an existing working directory, and a 5–300 second timeout per step. Supported tools are npm, pnpm, yarn, Python, Cargo, Go, and .NET when installed. For example, `[{"label":"Tests","tool":"npm","args":["run","test"]}]`. There is no shell-string interpolation. Review the exact project and commands in the native approval dialog: package scripts, hooks, and programs still execute local code with your permissions. The sequence stops on the first failure or timeout. Cancel terminates the owned process tree. Results keep exit codes and bounded output and can be linked to task completion.

## Validation limits

The automated desktop suites use isolated fixture Claude/Codex CLIs and real native terminals, local SQLite, Git, local HTTP, screenshots, and process execution. They do not exercise real provider subscriptions, OAuth, model inference, Google Drive cloud transport, or a native Windows installer on the Linux build host. The Windows workflow includes the new desktop suite for platform validation when it runs successfully.
