# Background runner: plan for review

Status: **reviewed by the owner** (2026-11-24); both questions answered (section 8). Steps 1 to 3 are built (1.36.0): terminal channels run in the runner and are taken up again when Trace opens. Steps 4 to 6 are still to do.

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
  - **Where it runs from (found in the step 1 spike, 2026-11-24):** never from the install folder. Trace's Windows installer (electron-builder's NSIS `allowOnlyOneInstallerInstance.nsh`) stops every process whose path starts with the install folder, with `taskkill /IM Trace.exe` as its fallback, and an update cannot replace a file a running process holds. So Trace copies a runner kit into its storage folder (`~/.coding-hub/runner/<protocol version>/`): Electron's executable renamed `Trace Runner.exe`, with `ffmpeg.dll`, `icudtl.dat`, `snapshot_blob.bin` and `v8_context_snapshot.bin`, plus the runner script and node-pty. The spike ran node-pty from exactly that kit with `ELECTRON_RUN_AS_NODE=1`. It takes about 265 MB on disk, copied once per protocol version, and adds nothing to the download (bundling Node instead would add about 93 MB). A kit no runner uses is deleted on the next start. The Mac equivalent is still to be checked.
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

- **Electron's job.** If the packaged app runs in a kill-on-close job, detaching fails. Checked first, with a spike before anything else is built. Development build: a detached child survived `taskkill /F` of Electron's main process (2026-11-24). Never stop Trace with a process-tree kill or by image name, because either one also takes down the runner.
- **The installer.** Stops anything running from the install folder; hence the runner kit above.
- **Two Traces against one runner** (a second install, or tests). The newest HELLO takes over. Tests use their own pipe name (from the storage folder).
- **Protocol drift.** A version in HELLO, and DRAIN for changes, so a mismatch never stops channels.
- **Security.** The pipe or socket is open only to the user, plus the secret. The runner never runs anything Trace did not SPAWN.
- **Tests.**
  - The PTY smoke and the desktop smoke run against the runner.
  - A new smoke kills Trace's main process mid-run, opens it again, and checks the channel kept running and its screen came back.
  - An update test: DRAIN, then a new runner beside the old.

## 7. Order of work

1. **Spike:** start a detached runner from the packaged app on Windows and Mac; check it survives quitting and killing Trace.
2. **Runner and protocol,** with unit tests (frames, tail ring, DRAIN). Built: `electron/services/runner/` (`protocol.ts`, `tail.ts`, `runner.ts`, the process `runner-main.ts`), `runner.test.ts`, and `npm run test:runner` with real processes. Beyond the table: `spawned` answers a spawn with the terminal number, `forget` drops an ended terminal from the list, and `error` names a failed spawn by its id. A Trace on another protocol may only `drain`. The runner leaves by itself after 60 s with nothing running and no Trace connected.
3. `PtyManager` on the runner for terminal channels; reattach on open; the kill-and-reopen smoke. Found while planning it (2026-11-24):
   - **Same interface.** PtyManager talks to node-pty through one `spawn` returning an `IPty`. A runner-backed `IPty` keeps PtyManager as it is.
   - **Pause and resume.** Its flow control pauses a CLI the window cannot keep up with (`pty.pause()`), so the protocol gains `pause` and `resume`. The runner resumes every terminal when Trace disconnects, so it never leaves a program paused with nobody to resume it.
   - **The channel's identity.** A spawn carries the channel's details (`meta`: its session, configuration and hook token), which the runner keeps without reading and gives back in `list`. Trace adopts a terminal when the reopened tile starts: the surviving terminals join 1.32.0's resume list, and `start` finds the one with that channel's id instead of launching.
   - **Hooks after a restart.** An adopted agent's hooks still post to the attention server address it was started with, but that server listens on a random port with tokens kept in memory (`attention.ts`). So it listens on the port it had last time when that port is free, and adopted runs get their tokens back from `meta`. The same goes for the channel tools server. If the port was taken, the screen check (1.35.3) still catches approvals, and the notice says hooks are off for those channels.
4. Chat channels on the runner (pipe runs). **Not built; needs its own design (2026-11-24).** A chat channel is more than its process: Trace holds its live protocol state in the main process (Claude's message stream, a Codex chat's app-server thread and handshake, Gemini seats' session, pending approvals, and a Round Table's orchestration). A Trace that opens again cannot rebuild that state from 1 MB of output. What a chat loses on quit today is only a turn in progress: 1.32.0 already starts chats again on their conversations. The options are to move each chat protocol's state into the runner, or to make the protocols resumable mid-turn. Either is much larger than steps 1 to 3.
5. Windows job objects and Ctrl+C (the native helper). **Built (1.36.0):**
   - `native/trace-jobs.c` is built by `scripts/build-jobs-helper.cjs` (part of `build:host` on Windows, with Visual Studio's C++ build tools) into `dist-electron/native/trace-jobs.exe`, which the kit copies.
   - The runner puts each program in a job when it starts. Stopping the channel ends the job after Trace's own process-tree stop, so a child that left the tree ends too.
   - Jobs are deliberately not set to kill on close, so a fault in the helper never stops every channel.
   - A source run without the build tools works without it. `build-windows.cjs` refuses to package without it.
   - Ctrl+C needed nothing: written as 0x03, it reached a program started by the detached runner (it exited with STATUS_CONTROL_C_EXIT, checked 2026-11-24), so no inherited "ignore Ctrl+C" reaches agents.
6. Updates with DRAIN; the tray's **Quit and stop**; Settings.

Each step is its own release.

## 8. Questions for the owner

1. **Quitting.** Answered 2026-11-24: Quit leaves channels running in the background until the owner stops them; Trace reattaches next time. Stopping is a channel's own Stop, or **Stop all channels** in the tray menu.
2. **The native helper.** Answered 2026-11-24: shipping a small compiled helper for Windows job objects is acceptable.
