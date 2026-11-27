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

Status (1.47.0): the first two are done; the third is a switch, off by default and untested.

- **Stopping a channel: job objects.** Each program goes in its own job object (`native/trace-jobs.c`, through `electron/services/runner/jobs.ts`). Stop still ends the process tree first (`taskkill /T /F`, `stop-process.ts`), then ends the job (`TerminateJobObject`), then closes the pseudoconsole, so a child that left the tree (started detached, or whose parent ended) ends too. Jobs are not kill-on-close, so a fault in the helper never stops every channel; without the helper (a source run without C++ build tools) Stop is the tree stop alone, as before.
  - **In the runner** (1.36.0): `runner-main.ts` adds each terminal when it starts and ends its job when Trace's `stop` arrives (after Trace's own tree stop).
  - **In Trace itself** (1.47.0): the channels Trace runs itself (chat channels always, and terminals with the runner off or when it could not start) used to rely on the tree stop alone. `main.ts` now gives `PtyManager` a `Jobs` of its own (`jobs`), started on Windows the first time a channel starts, from `dist-electron/native/trace-jobs.exe` in the app (asar is off, so it is a real file). Each run started there is added when it starts; Stop ends its job between the tree and the pseudoconsole (`StopDependencies.endJob`), and the job is let go of when the run ends, or after Stop for a run being stopped, so the exit Windows reports during Stop cannot let go of it before it is ended. Runs the runner holds are left to the runner's jobs. Unit tests: `jobs.test.ts` (the helper's protocol, with a stand-in under Node), `stop-process.test.ts` and `pty-manager.test.ts` (the order: tree, job, pseudoconsole, let go).
  - **Not checked on a Windows PC yet:** the helper in the installed app's own folder for Trace's runs (the runner's copy runs from its kit, checked by `npm run test:runner` on Windows). What a program starts after its `add` is answered is in its job; what it started before then is not, as in the runner. The installer's update stops this helper with the rest of the install folder, which is harmless: Trace is quitting then, and its jobs do not end their programs when the helper does.
- **Ctrl+C as the byte 0x03.** Trace already sends it so everywhere, and nothing turns it into a signal or a process stop: a key in the tile goes from xterm to `writeTerminal` to `pty.write` (in the runner, an INPUT frame to its `pty.write`); the tile's interrupt button, a linked computer's tile and the phone's **Ctrl C** key send `\x03` the same way, and the runner's own `interrupt` signal writes `\x03` too. ConPTY turns it into Ctrl+C for the console's programs. (With text selected, Ctrl+C in a Windows tile copies instead, on purpose: `terminals.ts`.) Chat channels have no console: their interrupt is a protocol message (`claude-stream.ts`).
  - **The inherited "ignore Ctrl+C" needs nothing of Trace's:** node-pty 1.1 calls `SetConsoleCtrlHandler(NULL, FALSE)` itself in the process that starts the terminal, in `startProcess`, before `connect` calls `CreateProcessW` (`node_modules/node-pty/src/win/conpty.cc`), and the setting is inherited by the program it starts. That covers both places terminals start: Trace's main process and the runner. The runner needs it: Node starts a detached process with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (libuv; read from its source, not from this repository), and a new process group starts with Ctrl+C ignored. Checked on Windows 2026-11-24: 0x03 written to a program the detached runner started ended it with STATUS_CONTROL_C_EXIT. `native-pty.test.ts` fails if a node-pty update drops that call. Not checked by running: a terminal Trace starts itself with the runner off (the same node-pty call covers it).
  - Hence no flag in `trace-jobs.c` and no node-pty option: there is nothing to clear that node-pty does not already clear.
- **ConPTY from node-pty (`useConptyDll`).** node-pty 1.1 has the option (marked experimental in its typings) and ships Microsoft's ConPTY 1.23.251008001 for it in `prebuilds/win32-<arch>/conpty/` (`conpty.dll`, `OpenConsole.exe`); `conpty.node` loads `conpty\conpty.dll` from its own folder, so the packaged app (`verify-windows-package.cjs` checks both files) and the runner kit (which copies the whole prebuilds folder) have it. **`CODING_HUB_CONPTY_DLL=1`** turns it on for both places terminals start (`conptyOptions()` in `native-pty.ts`); off by default. A quick try before the runner hung, cause not found. What differs in node-pty with it on, from its source: the exit is reported only when OpenConsole closes the output pipe (it is released right after the program starts, so it should leave with the last program on the console; a program that leaves a child on the console may keep the channel from ending), and `kill()` closes the input, calls `ConptyClosePseudoConsole` and ends the program itself, without the console-list lookup `skipConsoleProcessLookup` replaces. Whether it fixes input or emoji width, and whether it hangs, is untested: try it on a Windows PC (docs/troubleshooting.md).

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
   - Ctrl+C needed nothing: written as 0x03, it reached a program started by the detached runner (it exited with STATUS_CONTROL_C_EXIT, checked 2026-11-24), so no inherited "ignore Ctrl+C" reaches agents (node-pty clears it; section 4).
   - 1.47.0: the channels Trace runs itself get job objects too (section 4).
6. Updates with DRAIN; the tray's **Quit and stop**; Settings. **Partly built (1.36.0):**
   - On Windows, channels in the runner no longer hold an update back (`PtyManager.hasLocalSessions`). The update quits Trace, which lets go of them, and the new Trace takes them up.
   - A Mac update still waits, because its runner runs from the app bundle the update replaces.
   - The tray has **Stop all channels and quit**, and Settings has the switch.
   - Not built yet: DRAIN of a runner on an older protocol. There is only protocol 1 so far, and each protocol has its own address, so a later protocol must drain protocol 1's runner at its address.
   - Not tried: a real update of an installed Trace while channels run.

Each step is its own release.

## 8. Questions for the owner

1. **Quitting.** Answered 2026-11-24: Quit leaves channels running in the background until the owner stops them; Trace reattaches next time. Stopping is a channel's own Stop, or **Stop all channels** in the tray menu.
2. **The native helper.** Answered 2026-11-24: shipping a small compiled helper for Windows job objects is acceptable.

## 9. Trial: herdr-core itself instead of the runner (`CODING_HUB_HERDR`, 2026-11-27)

At the owner's request, Trace can hold its terminal channels in herdr-core (`hc`, github.com/herdrdev/herdr-core, Apache-2.0) instead of its own runner. With herdr-core's own server holding them, `hc attach` from any terminal, or over SSH, can reach a channel, and herdr's phone app may too (not tried).

- **On:** the environment Trace starts with names an absolute path to `hc` as `CODING_HUB_HERDR`. For an installed Mac app, run `launchctl setenv CODING_HUB_HERDR ~/.local/bin/herdr-core`, then reopen Trace; `launchctl unsetenv CODING_HUB_HERDR` turns it off. The window can never set it. It is off unless set, and nothing changes then.
- **How:** `electron/services/runner/herdr.ts`. `HerdrTerminals` is PtyManager's `HeldTerminals`, as `BackgroundRunner` is, talking to hc over `hc connect` (framed JSON-RPC, herdr-core's `schema/README.md`).
  - Each terminal carries labels for its channel, its run and its size. Its HeldMeta is an hc document, `trace-<run id>`.
  - `HerdrPty` is the IPty Trace uses. Pause and resume work through hc's flow-control credit.
  - A stream that closes while its program runs (a lost line, an hc restart) is attached again. Only an exit hc reports is an exit.
- **Environment:** hc lays a terminal's environment over its own. A variable Trace leaves out (an agent session's, `withoutAgentSession`) is therefore removed: on Mac and Linux the program starts through `env -u` for each such name (names only). On Windows they are given empty, and Trace says once to run `hc server restart --fresh` from a clean terminal. Whether Claude Code reads an empty `CLAUDECODE` as unset on Windows has not been checked.
- **Checked:**
  - `herdr.test.ts` runs against a real hc with `CODING_HUB_TEST_HC=<hc>`: start, type, resize, take up again after Trace closes, exit codes, a fast exit, a lost line, a restart of hc, close during recovery, and sizes. It passes on a Mac and on GitHub's Windows runner.
  - `scripts/runner-desktop-smoke.cjs` (after `npm run build:host`) passes with `CODING_HUB_HERDR` set: a crash, then reopening, takes the channel up.
  - Codex reviewed it twice. Every finding was fixed, and the last pass found nothing.
- **Not tried:** herdr's phone app (it needs Remote Login, SSH, on the Mac), a reboot, daily use, and which app macOS names for an agent's file access.
