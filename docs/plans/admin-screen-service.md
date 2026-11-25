# Close the administrator screen-service gap (Windows)

Status: **draft for the owner to review** (2026-11-25). Nothing here is built. Open item: "Administrator screen service runs user-writable app files (resources\app)".

## Problem

**What runs as administrator.** With **Also control apps running as administrator** on (Settings → Other computers → Share this screen):
- `ScreenShare.set` (`electron/services/remote/screen-share.ts`) runs `registerTaskScript` once through `elevatedScript` (`Start-Process powershell.exe -Verb RunAs`). Windows asks permission this once.
- The task **Trace screen sharing (administrator)** (`TASK_NAME`) runs `process.execPath` with `--screen-service --storage=<root> --name=<computer> --elevated` (`args(true)`), at sign-in, `-RunLevel Highest`.
- After that Trace starts it with `schtasks /Run` (`startInput`) and ends it with `schtasks /End`, with no prompt.
- That process is Trace.exe itself. `electron/entry.ts` sees `--screen-service` and loads `screen-service.ts`. With `--elevated` it runs only `InputRelay` (`electron/services/remote/input-relay.ts`), which spawns `powershell.exe` with a C# `SendInput` loop compiled by `Add-Type` (`HELPER`, `localHelper` in `screen-input.ts`).

**Why that is a gap.** Everything that elevated process loads can be changed by any program running as the person, without a prompt:
- **The program and its JavaScript.** The installer is per-user (`nsis.perMachine: false`, `allowElevation: false` in `electron-builder.cjs`) and the app is not packed (`asar: false`). The 2026-11-17 audit measured the install at `AppData\Local\Programs\AI Coding Hub\Trace`, with `resources\app\dist-electron\electron\screen-service.js` as a plain file (`docs/audit-2026-11-17-findings.md`, "Administrator screen service runs user-writable code…"). Replace `Trace.exe`, `entry.js`, `screen-service.js`, `input-relay.js` or anything under `resources\app\node_modules`, then run the task: the new code runs as administrator.
- **Its switches.** `screen-service.ts` reads `screen-share.json` under `--storage` (the user's `~/.coding-hub`) to decide whether to run (`wanted()`, `shareElevated`).
- **Its key.** `InputRelay` admits any connection with the token in `screen-service-local.json` (`localScreenToken`, `screen-service-server.ts`), in the same user folder. Any program running as the person can read it and drive administrator windows through `127.0.0.1:47823`. `docs/reference.md` ("What it costs") already says this.
- **Its Electron profile.** `userData` is `%APPDATA%\AI Coding Hub\screen-input` (`screen-service.ts`), also user-writable.
- **Builds are unsigned unless a certificate is set.** `release.yml` warns "No WINDOWS_CERTIFICATE secret: the Windows installer and app are not code-signed". The audit found the installed 1.22.0 `Trace.exe` NotSigned. I do not know whether the secret is set now.

Net effect: with the option on, any program running as the person gets administrator rights with no prompt. The audit rated it low because the option is opt-in and off by default; it said "medium for anyone who turns it on".

**Why the obvious quick fixes do not work:**
- **Check a signature before elevating.** There is no Trace code between Task Scheduler and the elevated process. The check would have to run inside the elevated process, which is already the code an attacker replaced.
- **Turn off Electron's RunAsNode fuse.** Trace depends on `ELECTRON_RUN_AS_NODE=1` for the runner kit (`kit.ts`), the memory and channel tools servers (`main.ts`) and the CLI shim (`main.ts`). It would also not stop file replacement.

## Goals and non-goals

Goals:
- Nothing that runs as administrator is loaded from a place a standard process of the person can write.
- Only Trace's own service can send input to the administrator side.
- Updating Trace does not ask for permission each time, unless the administrator part itself changes.

Non-goals:
- Controlling the lock screen or Windows prompts (not possible today, `docs/reference.md`).
- Changing the ordinary (non-elevated) screen service.

## Options

### A. Install Trace per-machine (Program Files)
Set `perMachine: true`. Program Files is writable only by administrators.
- For: the whole app, including the elevated process, sits in a protected folder. No new binary.
- Against: every install and update needs an administrator prompt. Self-updates on Windows (`latest.yml`) would prompt each time.
- Against: existing per-user installs must move. The app ID must stay `com.codinghub.desktop` (`AGENTS.md` rule 5). The task's path changes, so it must be registered again (one prompt).
- Against: the token and `screen-share.json` stay in the user's folder. The input relay is still drivable by any user program. Needs part of option B too.

### B. A small signed helper in a protected folder (recommended)
Replace the elevated Trace.exe with a tiny native program, `trace-input.exe`, beside `native/trace-jobs.c`. It reads input lines, checks them against the same pattern as `COMMAND` in `input-relay.ts`, and calls `SendInput`. Nothing else.
- When the option is turned on, the one elevated script copies it to an administrator-only folder (for example `%ProgramFiles%\Trace Input\`, ACL: Administrators and SYSTEM write, Users read and run) and registers the task to run that copy.
- The helper keeps its key in a folder only it and administrators can read. It hands the ordinary service a key through a channel the elevated side controls (to design; see open questions).
- For: nothing elevated loads from the user's folders. Trace updates do not touch it, so no prompts.
- For: no Electron, no PowerShell, no `Add-Type` compile in the elevated path.
- For: precedent. `native/trace-jobs.c` is built by `scripts/build-jobs-helper.cjs`, and the owner accepted a small compiled helper on 2026-11-24 (`background-runner.md`, question 2).
- Against: a new native binary to build, sign and test on Windows. A change to it needs a prompt to replace the copy.

### C. Verify a hash before elevating, using a protected launcher
The task runs a protected launcher that checks `Trace.exe` and `resources\app` against a hash list, then starts it.
- For: keeps today's JavaScript relay.
- Against: the checked files can be swapped between the check and the load. A hash list must change with every release, so it must be updated with a prompt every update, or stored where the user can write it. Hard to get right.

### D. Drop the administrator option
Remove the toggle. On upgrade, remove the task (one prompt) or leave it inert.
- For: removes the gap completely. Least code.
- Against: apps running as administrator cannot be controlled from a linked computer.
- Note: a registered task left behind still runs `Trace.exe --elevated` at sign-in. Today `screen-service.ts` quits when `screen-share.json` has no `elevated` (`wanted()`), but that file is user-writable. So D must also unregister the task.

## Recommendation

Short term: nothing new is needed in the interface. The option is off by default, and Settings already warns while it is on: `OtherComputers.tsx` says that Trace is installed in a folder your account can change, so any program running as you could get administrator rights without a Windows prompt.

Then: **option B.** It closes the gap without making every update prompt. It keeps per-user installs. It shrinks the elevated code to a few dozen lines that rarely change. If the owner does not want another native binary, choose D, not A or C.

## Step-by-step plan (option B)

1. **Settings text.** Once the helper ships, rewrite the warning in `src/components/OtherComputers.tsx` to say what is still true (any program running as you can send input through the helper). Tests: a component test for the text.
2. **The helper.** `native/trace-input.c`: read lines from a named pipe, validate (same grammar as `COMMAND`), `SendInput`, release held keys on disconnect (as `trackHeld`). Build in `scripts/build-jobs-helper.cjs` or a sibling. Tests: a Windows-only test that it rejects bad lines; a unit test of the grammar shared with `input-relay.test.ts`.
3. **Pipe and key.** The helper creates `\\.\pipe\trace-input-<user>` with a DACL for SYSTEM, Administrators and the one user (as the runner does in `background-runner.md`, section 2). Decide whether the pipe's DACL alone is enough or a key is also needed. Tests: connect refused for another user (manual on Windows).
4. **Install step.** Extend `registerTaskScript` to copy the helper into the protected folder, set its ACL, and register the task to run it. Extend `removeTaskScript` to delete it. Tests: `screen-share.test.ts` checks the generated script text.
5. **Service side.** `relayHelper` in `screen-input.ts` talks to the pipe instead of port 47823. Fall back to `localHelper` as today. Tests: `screen-input.test.ts` with a fake pipe.
6. **Migration.** When an old task (running `Trace.exe --elevated`) is found, ask once to replace it. Until then, refuse to start it. Tests: `screen-share.test.ts` for detection.
7. **Remove `--elevated` from `screen-service.ts`** and `InputRelay`, one release later.
8. **Docs.** Update `docs/reference.md` ("Sharing a Windows screen") and `docs/windows-releases.md` (the helper must be signed).

## Risks

- **Still a local input channel.** Any process that can open the pipe drives administrator windows. A user-only DACL limits that to the person's own programs, which is the same trust as today's key. That is better (no file-held key, no code swap) but not zero. State it in Settings.
- **Unsigned helper.** If Windows releases stay unsigned, the copy is still protected once installed, but the person approves an unsigned binary. Signing matters more here.
- **Old tasks.** Computers with the 1.28.1-style task keep the gap until migrated.
- **Untested on real Windows.** I could not run anything here (macOS, and the task forbids running the app).

## Open questions for the owner

1. B (new native helper) or D (drop the option)? A and C are not recommended.
2. Is the Windows signing certificate (`WINDOWS_CERTIFICATE`) set for releases now?
3. Where should the protected copy live: `%ProgramFiles%\Trace Input\` or `%ProgramData%\Trace\` with a tightened ACL?
4. Is "any program running as you can drive administrator windows" acceptable if the code itself is protected? If not, the helper needs a stronger caller check (for example the client's signed image), which is more work.
5. How many people have the option on? If none, D is cheap.

Things I could not determine:
- Whether a scheduled task started with `-RunLevel Highest` takes the user's `HKCU\Environment` variables (such as `NODE_OPTIONS` or `ELECTRON_RUN_AS_NODE`). If it does, that is a second way into today's elevated Trace.exe.
- Whether `Add-Type` in the elevated PowerShell compiles into the user's `%TEMP%`, which would be another user-writable load path.
- How `spawn('powershell.exe')` resolves the program in the elevated process (search order and the task's working folder, which `New-ScheduledTaskAction` does not set).
