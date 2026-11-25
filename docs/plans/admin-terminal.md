# A terminal channel that runs as administrator (Windows)

Status: plan for the owner's review (2026-11-25). Nothing here is built. The owner asked for a way to "run terminal in
administrator mode when needed", separately from screen sharing's administrator helper (admin-screen-service.md).

## Problem

Every Trace channel runs with the person's own rights. On Windows some work needs administrator rights: installing a
service, editing `Program Files` or `HKLM`, `winget` for all users, some build tools. Today the person leaves Trace for
an elevated Windows Terminal.

**How channels run today (from the code):**
- A terminal channel is a PTY that `PtyManager` (`electron/services/cli/pty-manager.ts`) starts with node-pty, as a child
  of Trace's main process, or of the background runner when that is on (`docs/background-runner.md`; the runner is a
  separate process that owns the PTYs and talks to Trace over `\\.\pipe\trace-runner-<user>`).
- Both run with the person's ordinary (filtered) token, so everything they start does too.

**What Windows allows (to confirm on Windows before building; not tried here, this is a Mac):**
- A process cannot start an elevated child with `CreateProcess`: elevation needs `ShellExecuteEx` with `runas`, which
  shows the UAC prompt and starts the program in a new console of its own, not in Trace's ConPTY. So an elevated
  program cannot simply be a child of Trace's PTY.
- What can work is an elevated process that owns the PTY itself and passes its input and output to Trace, as the
  background runner does for ordinary channels.
- Windows 11 24H2 has `sudo` (Settings → System → For developers → Enable sudo). In its "inline" mode the elevated
  program runs in the same console. It is off by default, and some organisations' policies turn it off.

## Goals and non-goals

Goals:
- A shell channel on Windows that runs as administrator, after Windows' own UAC prompt each time it starts.
- Clearly marked as administrator on its tile and in the status bar, so it is never mistaken for an ordinary one.
- Nothing elevated keeps running after the channel stops.

Non-goals:
- Agent channels (Claude Code, Codex, Gemini) running as administrator. An agent with administrator rights that runs
  commands without asking can change the whole computer. See Open questions.
- A Mac version: `sudo` in an ordinary terminal channel already works there.
- Skipping the UAC prompt (for example with a scheduled task, as screen sharing does). For a terminal that can do
  anything, the prompt is the safeguard.

## Options

### A. An elevated runner for administrator channels (recommended)
- Starting an administrator channel starts a second background runner with `ShellExecuteEx runas` (one UAC prompt).
  It owns that channel's PTY.
- Trace talks to it over the runner protocol, on a pipe of its own (`\\.\pipe\trace-runner-admin-<user>`) whose DACL
  admits only the user, SYSTEM and Administrators.
- When its last channel stops, it exits.
- Pros: the runner's protocol, tail and stop code already exist. Input, resize, colours and the screen reader all work
  as for any channel. It does not depend on Windows' `sudo`.
- Cons: the runner must be ready for a second, elevated instance. It must start from a folder only administrators can
  change (the runner already never runs from the install folder: see background-runner.md, "Where it runs from"),
  otherwise a program running as the person could swap its files and gain administrator rights. That is the same
  problem screen sharing had.

### B. Windows' own `sudo`, inline
- An administrator shell channel runs `sudo --inline <shell>` inside an ordinary channel.
- Pros: very little code; Windows owns the elevation and its prompt.
- Cons: Windows 11 24H2 or later only, and only where the person (or their organisation) has turned on sudo in inline
  mode. Microsoft notes that inline mode lets other processes running as the person send input into the elevated
  console, which is the same exposure as the screen helper.

### C. An elevated `conhost`/Windows Terminal window, outside Trace
- An "Open an administrator terminal here" button that starts Windows Terminal elevated in the channel's folder.
- Pros: trivial and safe; nothing elevated is inside Trace.
- Cons: not a Trace channel. There is no tile, history, phone view or agent tools.

## Recommendation

- **First C**, as a button on a Windows channel's menu: one small release, so the need is met at once.
- **Then A** for a real administrator shell channel, built on the runner once runner step 4 (chats) has settled.
- **B only** as an alternative where `sudo` is available, if A proves too heavy.

## Step-by-step plan

1. **"Open an administrator terminal here" (C).** A channel menu item on Windows starts
   `wt.exe -d <folder>` (or `powershell.exe -NoExit -Command Set-Location`) with `ShellExecute runas`. Trace's only part
   is the prompt and the folder.
   - Tests: the arguments (pure function); the button only on Windows.
2. **Confirm on Windows.** Check that a non-elevated ConPTY cannot host an elevated child, how `ShellExecuteEx` reports a
   refused prompt, and that a runner started with `runas` can open its pipe with the planned DACL.
   - Write the results into this document.
3. **Admin runner (A).** `runner-main.ts` takes `--admin`, uses `\\.\pipe\trace-runner-admin-<user>`, and exits when its
   last run ends. It is copied to and started from a protected folder (`Program Files\Trace Admin Runner`), with the
   SHA-256 check that screen sharing's helper uses.
   - Tests: the protocol over the admin pipe with a fake elevation; the start script's text.
4. **The channel.** A shell channel's settings get **Run as administrator** (Windows only). Starting it asks for the admin
   runner, which shows the UAC prompt. A refusal leaves the channel stopped with Windows' reason. The tile and the
   status bar chip show "Admin".
   - Tests: `PtyManager` routes an admin channel to the admin runner; a refused prompt; the badge.
5. **Stopping.** Stop, Close, quitting Trace and a crash of Trace all end the elevated shell. The admin runner never
   keeps channels after Trace closes, unlike the ordinary runner (an elevated shell left running unseen is a risk).
   - Tests: runner-side cleanup when Trace's connection drops.
6. **Docs.** `docs/reference.md` (channels), `docs/background-runner.md` (the admin instance).

## Risks

- **Elevation with files the person can change.** Whatever runs elevated must come from a folder only administrators can
  change. Step 3 copies the runner there with a hash check, as for the screen helper. Doing this wrong gives any program
  running as the person administrator rights.
- **Input from other programs.** The elevated runner takes input from Trace over a pipe open to the person's account. As
  with the screen helper, any program running as the person could send keystrokes to the elevated shell. The UAC prompt
  at each start limits this to the time the channel runs.
- **The phone and linked computers.** Typing into an administrator channel from the phone would make the phone an
  administrator console. The default should be read-only there (see Open questions).

## Open questions for the owner

1. Is step 1 (a button that opens an elevated Windows Terminal outside Trace) enough for now, or is a real administrator
   channel (A) needed?
2. Shells only, or agents too? An agent at Full access as administrator can change anything on the computer without
   asking. The recommendation is shells only.
3. From the phone or another computer: see only, or type too?
4. Is Windows' `sudo` turned on on your PC? (Settings → System → For developers → Enable sudo.) If so, option B is
   available as a fallback.
5. A UAC prompt every time an administrator channel starts. Is that acceptable? (The alternative, a scheduled task with
   no prompt, is not recommended for a terminal.)
