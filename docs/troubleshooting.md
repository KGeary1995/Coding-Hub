# Troubleshooting

Symptoms, causes and fixes for Trace, both when it runs on someone's computer and when you develop it. Each entry names the code involved, so you can check the current behaviour before relying on this page.

User-facing basics (CLI not found, Codex exits at once, Tailscale) are in the [README](../README.md#troubleshooting).

## Running Trace

### Trace stops responding for a moment

**Symptom:** for one to three seconds the window, every terminal and the phone stop answering, then carry on.

**Cause up to 1.22.0:** work done on the main process, tied to events rather than a timer (the [audit of 17 November 2026](audit-2026-11-17.md#the-1-to-3-second-freezes) measured it). The largest was memory sync with Google Drive: Drive answers each file in about half a millisecond, and a project's first comparison after a start read every note on both sides (1 to 2 s for 300 to 800 notes), every channel start listed the project's Drive folder, and notes were copied one at a time. After every start, today's usage also re-read weeks of CLI logs in passes of up to about 100 ms, and every Git call, channel start and plan-limits check could run `reg.exe` synchronously on Windows.

**Now:** Drive sync runs in the background (`DriveMirror.syncLater`, `electron/services/hub/drive.ts`) and remembers the notes it compared (`memory/.drive-compared.json`); today's usage is read in the background and keeps its progress in `day-usage.json`; the registry PATH is read in the background. See [architecture.md](architecture.md#shared-memory).

**Check:** a freeze now leaves a record, in the `stalls` list of `~/.coding-hub/host-health.json` (`HostHealth.stall`, `electron/services/storage/host-health.ts`). It is kept apart from the lifecycle events, so channel starts cannot push it out, and holds the last 200 entries. Each entry has `time`, `side` (`main`, `window` or `gpu`), `kind`, `ms` and `job`:

- **The main process** (`side: "main"`, `kind: "main-stall"`): Node's event-loop delay sampler (`monitorEventLoopDelay`, read once a second by `MainStalls`) records any stall of 250 ms or more. `job` names the labelled job (`timed()`) that took at least half of it, with its time, or `after <job>` for the last labelled job before it. The labels are a window call's IPC channel and action (`hub drive-sync`, `workbench usage-today`), `session-<event>` (a channel's output or exit), `launch-prepare`, `tailscale-check`, `usage-alerts`, `hub-tick` (the synchronous part of the hub's 30-second tick: sync between computers through the Drive folder, `HubService.tick`) and `telemetry-poll` (a channel's 750 ms usage read, `TelemetryService`). `timed()` measures only the synchronous part of what it wraps (for an IPC call, up to the handler's first `await`). Background work that runs in pieces, such as the Drive memory sync or today's usage read (`DayUsage`), has no label of its own. A stall in unlabelled work shows as `after <job>`, and that job may not be the cause. A stall over a minute is a computer that slept and is not recorded.
- **The window** (`side: "window"`): `src/runtime/window-health.ts` reports long tasks of 250 ms or more (`long-task`, with the task's name), timers late by a second or more while the window is visible that no long task explains (`stall`), and a terminal's lost graphics context (`context-lost`; `context-restored` is accepted but nothing sends it yet). The window is untrusted, so the host takes at most 10 of its reports a minute, and only a kind, a length and a short label. The host also records Chromium's own `unresponsive` and `responsive` events for the window (no length; Chromium sends them only after several seconds), and they are not limited.

Note the time of a freeze, then look for an entry within a few seconds of it:

```powershell
(Get-Content "$HOME\.coding-hub\host-health.json" | ConvertFrom-Json).stalls | Select-Object -Last 20
```

A stall with no channel starting or ending around it, or many in a row, is worth reporting with those entries. **Settings → Running application → Application stability & crash diagnostics** shows the same record. A freeze with no entry at all, on either side, points outside Trace's processes: the GPU process (its deaths are recorded as `side: "gpu"`), the display driver, or the computer itself.

### "Trace could not start"

Something failed while Trace was starting (`app.whenReady` in `electron/main.ts`), before it could open its window. Trace records `host-start-failed` in `~/.coding-hub/host-health.json` and quits, instead of running on with no window. Open it again; if it keeps happening, the events just before `host-start-failed` in that file show how far it got.

### Today's usage is missing the last few replies after a power cut

`telemetry/usage.db` runs in WAL mode with `PRAGMA synchronous=NORMAL` (`TelemetryService`, `electron/services/hub/telemetry.ts`), so a power cut can lose its last few records. Nothing needs doing: the next start reads them again from the CLIs' own logs.

### `~/.coding-hub/crash-dumps` fills up

Crash dumps stay on this computer and are never uploaded. From this version Trace removes those older than 14 days at each start (`pruneCrashDumps`, `electron/services/storage/host-health.ts`), and programs started in channels no longer inherit Trace's crash handler (`CHROME_CRASHPAD_PIPE_NAME` is removed from their environment), so an Electron or Chromium program run there no longer leaves its dumps here. Dumps from before that may belong to such programs, or to the GPU crash smoke test, and can be deleted.

### Drive memory sync reports a conflict, or a project says it exceeds its note limit

A Drive note whose content differs from the copy here (same id) is reported as a conflict and neither copy is overwritten; the project's other notes keep syncing (`DriveMirror.run`). Review it with **Shared memory → Inspect Drive conflicts**.

Notes whose copies differ only in bytes (another program rewrote their line endings, say) are compared once and remembered in `~/.coding-hub/memory/.drive-compared.json`. Deleting that file is safe: Trace compares those notes once more.

A project that says it exceeds its note limit (another computer's notes arrived while it was nearly full) is repaired by saving one new note: the oldest handoffs move to the project's `archive/` folder. Open items and decisions are never moved.

### Today's total (Today in the status bar) looks wrong

Trace reads Claude Code's and Codex's own logs for the last 60 days and keeps how far it read each one in `~/.coding-hub/day-usage.json` (`DayUsage`, `electron/services/hub/day-usage.ts`). If a CLI rewrote or removed its logs, the saved positions can be off. Quit Trace, delete `day-usage.json`, and start it again: the next start reads the 60 days again, in the background, so the total fills in over the first minute or so. Agents that a Claude Code workflow starts are counted too, and can appear up to 5 seconds after they start.

### A computer linked itself, or a removed one keeps coming back

With **Link my computers automatically** on, another computer signed in to your Tailscale account links without a code, and each time Trace says so in its window ("A computer linked to Trace here: …"), shows a desktop notification unless notifications are off, and records `computer-auto-linked` in host health. If it isn't yours, remove it under **Settings → Other computers**, and turn the switch off if you want every link to need a code. Trace on a removed computer is kept out by `remote-unlinked.json` (in Trace's data folder) until it is linked with a code; delete that file to forget the list. The list matches the id Trace on that computer sends, so a program that sends a new id is not stopped by it; the notification is what shows that.

### A channel's memory tools fail with "coding-hub-memory: Connection closed"

**Cause:** the project's own `.mcp.json` (or `.codex/config.toml`) has a `coding-hub-memory` entry whose `command` or script path no longer exists. This happened to installs made before the 1.11 rename, because the Windows app moved from `…\Programs\AI Coding Hub\AI Coding Hub.exe` to `…\Programs\AI Coding Hub\Trace\Trace.exe`.

**Fix:** from 1.11.2, starting a channel in that folder rewrites the entry to the current install and shows a notice (`AutoMemory.configured()` in `electron/services/hub/auto-memory.ts`). On older versions, either delete the entry, so automatic memory injects a working server, or correct both paths by hand. Restart the CLI afterwards, because MCP servers connect only at launch.

### `read_memory` returns `[]` even though notes exist

**Cause:** the memory server was started with a different project key from the one Trace uses for the folder. Notes live in `~/.coding-hub/memory/<key>/`. Automatic memory uses `projectMemoryKey(cwd)`, which is `<repo-name>-<hash of the origin URL>` for Git clones and `<folder-name>-<hash of the path>` otherwise. A manual install before 1.11.2 used whatever the memory panel's key field said, and its default was `coding-hub`.

**Check:** compare the last argument of the `coding-hub-memory` entry with the key shown in **Shared memory** ("Automatic memory key for this project"), and list `~/.coding-hub/memory/`.

**Fix:** from 1.11.2, Trace warns about the mismatch at launch. Remove the entry, or reinstall it from the memory panel, which now uses the automatic key. To move notes between keys, copy the JSON file into the other key's folder and change its `"project"` field to match. `MemoryService.list` drops notes whose `project` doesn't match their folder.

### `write_handoff` fails with "Verify the project key, field lengths, and local file permissions"

**Cause:** before 1.11.5 the memory server answered every failed call with this one message, including calls it rejected for bad arguments. The usual one is a missing `author`: `write_handoff` needs `title`, `content` and `author` (`"claude"` or `"codex"`). A session that saw the message went looking for a permissions problem in `~/.coding-hub/memory`, while reads kept working.

**Fix:** from 1.11.5 the server says what was wrong ("Handoff rejected: author must be "claude" or "codex"", "Handoff rejected: title: Too small…"); the generic message is only for unexpected failures such as a disk error (`failure()` in `electron/services/hub/memory-server.ts`). On older versions, check the call's arguments before the folder.

### A memory note you deleted comes back

Sync is additive (`electron/services/hub/drive.ts`, and device sync). A note that still exists in the Drive mirror or on another computer is copied back. Remove it everywhere, or leave it.

### Session output looks unsaved (0-byte or stale logs in Explorer)

**Cause:** on Windows, folder listings (Explorer, `Get-ChildItem`, `dir`) can show the size and modified time from when a file was opened, while Trace still has it open. Run logs stay open for the whole run (`WorkspaceStorage.beginRun`, `electron/services/storage/workspace-storage.ts`).

**Check:** open the file and read its real length, or compare it with `runs.recordedBytes` in `~/.coding-hub/storage.db`:

```powershell
$fs = [IO.File]::Open("$HOME\.coding-hub\logs\<run-id>.log", 'Open', 'Read', 'ReadWrite'); $fs.Length; $fs.Close()
```

A real failure shows the notice "Session output could not be saved. Live terminal output remains available." Logs are capped at 5 MiB per run (`maxLogBytes`), and `runs.logTruncated` is set when the cap is hit.

### A Claude channel stays on Needs you ("needs approval") after you answered

**Before 1.11.3:** Needs you (then shown as HOLD) was set by Claude Code's `Notification` hook (`permission_prompt`) and cleared only by a keystroke typed after the alert arrived (`clearAttention` in `src/state/workspace-store.ts`). If you answered before the alert reached Trace, it stayed. Typing any key in that channel clears it.

**From 1.11.3:** Claude launches also send `PostToolUse` and `Stop` hooks to `<hook url>/resolved` (`claudeAttentionSettings` in `electron/services/cli/attention.ts`), so Needs you clears when the tool finishes or the turn ends.

### `ctx` shows "—" on Claude channels

Before 1.11.3, Trace recorded no context for Claude, because Claude Code's transcript has no window size. From 1.11.3 the tile shows the tokens in context, for example `ctx 241K`, with no percentage. Codex reports its window, so Codex tiles show a percentage and can enter the limit state. Don't add a guessed Claude window: default-model sessions have been seen above 240K tokens, so a 200K guess would put tiles into the limit state for no reason.

### Channels did not come back after Trace opened again, or a runner keeps running

With **Keep channels running after Trace quits** on (1.36.0), terminal channels run in Trace's background runner. If they did not come back, `~/.coding-hub/runner/runner.log` says when the runner started (with its process ID) and any fault it had. A channel that ended while Trace was closed comes back stopped, as after any quit. The runner shows in Task Manager as **Trace Runner** (on Windows), and its programs run under it. Ending it ends every channel it holds; it also ends by itself a minute after its last channel stops with Trace closed. If Trace cannot start the runner, channels run inside Trace instead, as before 1.36.0, and stop when it quits.

### Windows terminals: trying the ConPTY that ships with node-pty (experimental)

`CODING_HUB_CONPTY_DLL=1` makes Windows terminal channels use the ConPTY node-pty ships (`conpty.dll` and `OpenConsole.exe`, version 1.23) instead of the one built into Windows, in case it handles input or emoji widths better. It is untested and off by default: an earlier quick try hung. To try it, quit Trace with **Stop all channels and quit** (a runner already running keeps the setting it started with), set the variable for your user (`setx CODING_HUB_CONPTY_DLL 1`, then sign out and in, or start Trace from a terminal where it is set), and open Trace. Check that a channel starts, takes typing and Ctrl+C, resizes, and ends both by itself and with **Stop**. A channel that never shows as ended after its program exits is the hang to report. To undo, `setx CODING_HUB_CONPTY_DLL ""` (any value but `1` is off), sign out and in, and stop all channels and quit again. How it differs: [docs/background-runner.md](background-runner.md), section 4.

### A channel shows Failed with "The terminal process could not start"

The message names the cause. From source, run `npm run rebuild:native`, because node-pty must match Electron's ABI. Also check that the CLI starts in a normal terminal.

## Developing

### Symbolic-link tests are skipped on Windows (or fail with `EPERM: operation not permitted, symlink …`)

Some tests create symbolic links, for example in `pty-manager.test.ts` (worktree detection), `hub.test.ts` (rejecting links) and `rules.test.ts`. Windows allows that only with **Developer Mode** on, or from an elevated shell. Those tests first check whether a link can be made (`canSymlink`, `electron/services/hub/symlink.fixture.ts`) and are skipped where it cannot, so on a standard Windows account `npm test` reports them as skipped and has no `EPERM` failures. They run in CI, both on Linux and on the elevated Windows runner. An `EPERM … symlink` failure now means a new test creates a link without that check: guard it the same way.

### A test times out, or fails with `EBUSY … rmdir` in a temp folder

Heavy tests are close to their limits on slow machines and Windows runners. Examples: the 5,000-note memory limit test in `hub.test.ts`, the workbench verification test, the coaching folder-limit test and the `flow-git-push` step of `scripts/productivity-smoke.cjs`. `EBUSY` follows a timeout, because Windows can't delete a folder that a still-running child process uses. The smoke scripts now remove their folder through `removeFolder` (`scripts/lib/cleanup.cjs`), which retries for about 5 s and then only warns ("Could not remove the test folder …"), so the error printed is the test's own; delete a folder it names by hand.

**Check:** rerun the single file (`npx vitest run <file>`). If it passes alone, or a CI rerun of the failed job passes, it's timing. If it keeps failing, investigate.

### Release's publish job fails: "No successful Windows release candidate run on <sha>"

Publish checks that **Windows release candidate** passed on the exact commit being released (`release.yml`, step "Check the Windows release candidate passed on this commit"), because Release itself never starts the Windows installer. A candidate run on a pull request's branch commit does not count for the merge commit. Start it on main (`gh workflow run windows-release.yml --ref main`), wait for it to pass on that commit, then rerun only the failed job: `gh run rerun <release run id> --failed`. If main has moved on since the tag, the candidate must be run on the tagged commit itself, for example from a branch that points at it.

### GitHub Actions jobs fail in about 2 seconds with no logs

The run's annotations say why. "The job was not started because recent account payments have failed or your spending limit needs to be increased" is a billing problem on the account that owns the repository, not the code. Fix it under **Settings → Billing and plans**, then rerun.

```sh
gh api repos/<owner>/<repo>/check-runs/<check-run-id>/annotations --jq '.[].message'
```

### Testing the memory MCP server by hand

It is a newline-delimited JSON-RPC server on stdio (`electron/services/hub/memory-server.ts`). It takes the memory root and a project key as arguments, and runs with `ELECTRON_RUN_AS_NODE=1`:

```sh
D="$LOCALAPPDATA/Programs/AI Coding Hub/Trace"   # installed app; or use `npx electron` with dist-electron/... from source
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_memory","arguments":{"limit":5}}}' |
  ELECTRON_RUN_AS_NODE=1 "$D/Trace.exe" "$D/resources/app/dist-electron/electron/services/hub/memory-server.js" "$HOME/.coding-hub/memory" <key>
```

Pipe from Bash, not Windows PowerShell 5.1. PowerShell's redirected stdin adds a byte-order mark, and the server answers `Invalid JSON`. `npm run test:memory` runs the full smoke test.

### `gh` / `git push` say "Repository not found" for a private repository

The active `gh` account can't see the repository. With several accounts signed in, either `gh auth switch --user <owner>` or set `GH_TOKEN` for the one command. The Git credential helper `gh auth git-credential` respects it:

```powershell
$env:GH_TOKEN = (gh auth token --user <owner>); git push; Remove-Item Env:GH_TOKEN
```

### `git push` is refused: "refusing to allow an OAuth App to create or update workflow … without `workflow` scope"

A push that changes `.github/workflows/` needs a token with the `workflow` scope. `gh auth refresh` has **no `--user` flag**; it refreshes the active account. So switch to the right account, refresh, then switch back:

```sh
gh auth switch -h github.com --user <owner>
gh auth refresh -h github.com -s workflow    # browser sign-in: authorize as <owner>
gh auth switch -h github.com --user <your usual account>
gh auth status                                # <owner>'s scopes now include 'workflow'
```

The refresh waits for the browser, so run it in your own terminal. If that terminal says `gh` isn't recognized, it was opened before the GitHub CLI was installed: open a new one, or run `& "C:\Program Files\GitHub CLI\gh.exe" …`.

### `gh issue create --body "…"` or `git commit -m "…"` fails with "unknown argument" or "pathspec … did not match" in PowerShell

Windows PowerShell 5.1 splits arguments to native programs at embedded double quotes, even inside a here-string. Write the text to a file and use `gh … --body-file <file>` or `git commit -F <file>`.

### Claude Code rejects `--settings` JSON from a script

Passing JSON through a shell (`shell: true`, `cmd /c`) breaks the quoting ("Invalid JSON provided to --settings"). Pass an argument array without a shell, or write the JSON to a file and pass its path. Trace's own launch passes an argument array (`electron/main.ts`).
