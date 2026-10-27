# Troubleshooting

Symptoms, causes and fixes for Trace, both when it runs on someone's computer and when you develop it. Each entry names the code involved, so you can check the current behaviour before relying on this page.

User-facing basics (CLI not found, Codex exits at once, Tailscale) are in the [README](../README.md#troubleshooting).

## Running Trace

### A channel's memory tools fail with "coding-hub-memory: Connection closed"

**Cause:** the project's own `.mcp.json` (or `.codex/config.toml`) has a `coding-hub-memory` entry whose `command` or script path no longer exists. This happened to installs made before the 1.11 rename, because the Windows app moved from `…\Programs\AI Coding Hub\AI Coding Hub.exe` to `…\Programs\AI Coding Hub\Trace\Trace.exe`.

**Fix:** from 1.11.2, starting a channel in that folder rewrites the entry to the current install and shows a notice (`AutoMemory.configured()` in `electron/services/hub/auto-memory.ts`). On older versions, either delete the entry, so automatic memory injects a working server, or correct both paths by hand. Restart the CLI afterwards, because MCP servers connect only at launch.

### `read_memory` returns `[]` even though notes exist

**Cause:** the memory server was started with a different project key from the one Trace uses for the folder. Notes live in `~/.coding-hub/memory/<key>/`. Automatic memory uses `projectMemoryKey(cwd)`, which is `<repo-name>-<hash of the origin URL>` for Git clones and `<folder-name>-<hash of the path>` otherwise. A manual install before 1.11.2 used whatever the memory panel's key field said, and its default was `coding-hub`.

**Check:** compare the last argument of the `coding-hub-memory` entry with the key shown in **Shared memory** ("Automatic memory key for this project"), and list `~/.coding-hub/memory/`.

**Fix:** from 1.11.2, Trace warns about the mismatch at launch. Remove the entry, or reinstall it from the memory panel, which now uses the automatic key. To move notes between keys, copy the JSON file into the other key's folder and change its `"project"` field to match. `MemoryService.list` drops notes whose `project` doesn't match their folder.

### A memory note you deleted comes back

Sync is additive (`electron/services/hub/drive.ts`, and device sync). A note that still exists in the Drive mirror or on another computer is copied back. Remove it everywhere, or leave it.

### Session output looks unsaved (0-byte or stale logs in Explorer)

**Cause:** on Windows, folder listings (Explorer, `Get-ChildItem`, `dir`) can show the size and modified time from when a file was opened, while Trace still has it open. Run logs stay open for the whole run (`WorkspaceStorage.beginRun`, `electron/services/storage/workspace-storage.ts`).

**Check:** open the file and read its real length, or compare it with `runs.recordedBytes` in `~/.coding-hub/storage.db`:

```powershell
$fs = [IO.File]::Open("$HOME\.coding-hub\logs\<run-id>.log", 'Open', 'Read', 'ReadWrite'); $fs.Length; $fs.Close()
```

A real failure shows the notice "Session output could not be saved. Live terminal output remains available." Logs are capped at 5 MiB per run (`maxLogBytes`), and `runs.logTruncated` is set when the cap is hit.

### A Claude channel stays on HOLD ("needs approval") after you answered

**Before 1.11.3:** HOLD was set by Claude Code's `Notification` hook (`permission_prompt`) and cleared only by a keystroke typed after the alert arrived (`clearAttention` in `src/state/workspace-store.ts`). If you answered before the alert reached Trace, it stayed. Typing any key in that channel clears it.

**From 1.11.3:** Claude launches also send `PostToolUse` and `Stop` hooks to `<hook url>/resolved` (`claudeAttentionSettings` in `electron/services/cli/attention.ts`), so HOLD clears when the tool finishes or the turn ends.

### `ctx` shows "—" on Claude channels

Before 1.11.3, Trace recorded no context for Claude, because Claude Code's transcript has no window size. From 1.11.3 the tile shows the tokens in context, for example `ctx 241K`, with no percentage. Codex reports its window, so Codex tiles show a percentage and can enter the limit state. Don't add a guessed Claude window: default-model sessions have been seen above 240K tokens, so a 200K guess would put tiles into the limit state for no reason.

### A channel shows "FAULT: The terminal process could not start"

The message names the cause. From source, run `npm run rebuild:native`, because node-pty must match Electron's ABI. Also check that the CLI starts in a normal terminal.

## Developing

### `npm test` fails with `EPERM: operation not permitted, symlink …` on Windows

Several tests create symbolic links without a Windows guard, for example in `pty-manager.test.ts` (worktree detection), `hub.test.ts` (rejecting links) and `rules.test.ts`. Windows allows that only with **Developer Mode** on, or from an elevated shell. On a standard Windows account, expect about four of these to fail. These failures don't indicate a regression. They pass in CI, both on Linux and on the elevated Windows runner.

### A test times out, or fails with `EBUSY … rmdir` in a temp folder

Heavy tests are close to their limits on slow machines and Windows runners. Examples: the 5,000-note memory limit test in `hub.test.ts`, the workbench verification test, the coaching folder-limit test and the `flow-git-push` step of `scripts/productivity-smoke.cjs`. `EBUSY` follows a timeout, because Windows can't delete a folder that a still-running child process uses.

**Check:** rerun the single file (`npx vitest run <file>`). If it passes alone, or a CI rerun of the failed job passes, it's timing. If it keeps failing, investigate.

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

### `gh issue create --body "…"` fails with "unknown argument" in PowerShell

Windows PowerShell 5.1 splits arguments that contain quotes and backticks. Write the body to a file and use `--body-file`.

### Claude Code rejects `--settings` JSON from a script

Passing JSON through a shell (`shell: true`, `cmd /c`) breaks the quoting ("Invalid JSON provided to --settings"). Pass an argument array without a shell, or write the JSON to a file and pass its path. Trace's own launch passes an argument array (`electron/main.ts`).
