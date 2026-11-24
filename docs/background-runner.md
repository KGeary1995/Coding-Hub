# Background runner: plan for review

Status: **reviewed by the owner** (2026-11-24); both questions answered (section 8). Nothing here is built yet.

**Goal:** channels keep running when Trace quits, crashes or updates, and Trace finds them again when it opens. 1.34.0
covers closing the window (Trace stays in the tray); this covers the rest.

**Model:** herdr-core's holder (`herdrdev/herdr-core`, `crates/herdr-core/src/holder.rs`, `holder_proto.rs`,
`platform/windows.rs`; Apache-2.0). herdr reached it after a Unix-only design that passed live terminals from one server to
the next, which does not work on Windows.

## 1. The split

**Runner (new):** a small Node process, started detached, that owns every terminal and nothing else. It:
- starts programs in a PTY (node-pty), with the environment, folder and arguments Trace prepared;
- always reads their output, so a program never stalls because Trace is gone or slow;
- keeps the last 1 MB of each terminal's output (the "tail");
- passes input, resizes and stops on;
- reports exits.

It has no agent logic, no settings, no usage counting and no phone server. This keeps it small enough that it rarely needs
to change, which matters because an update must not stop it.

**Trace (as now, minus the PTYs):** everything else stays in the Electron main process:
- preparing launches (flags, hooks, memory, channel tools);
- usage, Done, alerts, the phone, linked computers, plugins and Round Tables.

`PtyManager` keeps its interface, but its terminal runs talk to the runner instead of node-pty directly. Chat channels
(Claude and Codex in structured mode, over pipes) move too, as pipe runs, so they also survive. They carry the same tail.

## 2. Wire protocol

**Channel:**
- Windows: a named pipe `\\.\pipe\trace-runner-<user>`, open only to the user and SYSTEM (DACL `D:P(A;;GA;;;SY)(A;;GA;;;OW)`), with 64 KB buffers (herdr found the default 512 bytes serialises busy output).
- Mac and Linux: a Unix socket in Trace's storage folder, mode 0600.
- A secret in a file only the user can read is checked on HELLO.

**Frames** (herdr's shape): a fixed header (kind, terminal id, length) and a payload. Control messages carry JSON; output
and input carry raw bytes.

| Message | From | Meaning |
|---|---|---|
| HELLO | Trace | protocol version and secret; the newest HELLO takes over (an older connection is closed) |
| SPAWN | Trace | id, program, args, env, folder, size, PTY or pipe |
| INPUT / RESIZE / SIGNAL | Trace | to one terminal (SIGNAL: interrupt, stop) |
| TAIL | Trace → runner → Trace | ask for a terminal's tail; the answer is the bytes |
| LIST | Trace → runner → Trace | the terminals running, with their sizes and spawn ids |
| OUTPUT | runner | bytes from a terminal |
| EXITED | runner | exit code |
| DRAIN | Trace | take no new terminals; exit once the last one ends (used when updating) |

**Back-pressure:** the runner queues at most 8 MB per terminal for Trace (herdr's figure). Beyond that it keeps reading
the program, into the tail only, and tells Trace it skipped output, so Trace rebuilds that screen from the tail. Phones and
linked tiles keep getting the latest screen from Trace's mirrors, as now.

## 3. Lifecycle

- **Trace opens:** it connects to the runner, or starts one if none answers.
  - Windows: the runner is launched with `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`, so it outlives Trace and its job. This needs a check (below) that Electron does not put Trace in a kill-on-close job; herdr falls back to starting through WMI when it does.
  - Mac and Linux: the runner is spawned detached, in its own session.
- **Trace reattaches:** LIST, then TAIL for each terminal. The tail is replayed into each tile's xterm and into the mirrors, as herdr-core's `adopt` does. The saved workspace matches each terminal to its channel by the spawn id Trace gave it (its runId).
- **Trace quits:** the runner keeps going. Quit Trace and stop channels (the tray menu) stops them first, as now. A plain quit leaves them running; this choice goes to the owner (question 1).
- **Trace crashes:** the runner notices the connection drop and keeps running. Trace reattaches when it is opened again.
- **Updating:** the new Trace sends HELLO; if the protocol version matches it simply takes over. If not, it sends DRAIN to the old runner and starts a new one for new channels. Running channels stay on the old runner until they end, so an update no longer waits for every channel to stop.
- **The computer restarts:** nothing survives a restart. 1.32.0's "start channels again" brings agents back on their conversations, as now.

## 4. Windows details that come with it (the rest of herdr item 4)

- **Stopping a channel:** the runner puts each program in its own job object (`KILL_ON_JOB_CLOSE`) and stops it with `TerminateJobObject`, so children can never be left behind. That replaces `taskkill /T /F`. It needs a small native helper, a few lines of C or a prebuilt addon.
- **Ctrl+C:** written as the byte `0x03` to the console input, with `SetConsoleCtrlHandler(NULL, FALSE)` cleared before spawning, so an inherited "ignore Ctrl+C" does not reach agents.
- **ConPTY:** node-pty can use Microsoft's bundled ConPTY (`useConptyDll`), which ships in our build. It is untested here (a quick try hung). Test it in the runner, where it is one switch.

## 5. What changes for the person

- Closing, crashing or updating Trace no longer stops channels. Opening Trace again shows them as they were, with their screens.
- Updates install while channels run.
- The tray menu gets **Quit Trace and stop channels**, and Settings says how many channels the runner holds.

## 6. Risks, and how each is checked

- **Electron's job.** If the packaged app runs in a kill-on-close job, detaching fails. Checked first, with a spike before anything else is built.
- **Two Traces against one runner** (a second install, or tests). The newest HELLO takes over. Tests use their own pipe name (from the storage folder).
- **Protocol drift.** A version in HELLO, and DRAIN for changes, so a mismatch never stops channels.
- **Security.** The pipe or socket is open only to the user, plus the secret. The runner never runs anything Trace did not SPAWN.
- **Tests.**
  - The PTY smoke and the desktop smoke run against the runner.
  - A new smoke kills Trace's main process mid-run, opens it again, and checks the channel kept running and its screen came back.
  - An update test: DRAIN, then a new runner beside the old.

## 7. Order of work

1. **Spike:** start a detached runner from the packaged app on Windows and Mac; check it survives quitting and killing Trace.
2. **Runner and protocol,** with unit tests (frames, tail ring, DRAIN).
3. `PtyManager` on the runner for terminal channels; reattach on open; the kill-and-reopen smoke.
4. Chat channels on the runner (pipe runs).
5. Windows job objects and Ctrl+C (the native helper).
6. Updates with DRAIN; the tray's **Quit and stop**; Settings.

Each step is its own release.

## 8. Questions for the owner

1. **Quitting.** Answered 2026-11-24: Quit leaves channels running in the background until the owner stops them; Trace reattaches next time. Stopping is a channel's own Stop, or **Stop all channels** in the tray menu.
2. **The native helper.** Answered 2026-11-24: shipping a small compiled helper for Windows job objects is acceptable.
