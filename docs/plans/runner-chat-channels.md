# Runner step 4: chat channels in the background runner

Status: **steps 1 to 4 built** (1.46.0 and 1.47.0). Steps 5 and later are not: chats still start in Trace's main process. The owner chose to go ahead (2026-11-25). Follows [background-runner.md](../background-runner.md), whose step 4 says it needs its own design.

## Problem

Terminal channels outlive Trace today. Chat channels do not.

**How terminal channels survive (built in 1.36.0):**
- `PtyManager.start` (`electron/services/cli/pty-manager.ts`) sends a terminal run to the runner through `HeldTerminals.spawn`. The runner side is `BackgroundRunner` (`electron/services/runner/background.ts`) and `Runner` (`electron/services/runner/runner.ts`).
- The runner keeps each terminal's last 1 MB (`Tail`, `electron/services/runner/tail.ts`) and a `meta` blob it never reads (`RunnerTerminal.meta`, `protocol.ts`).
- When Trace opens again, `PtyManager.start` calls `held.take(sessionId)` and `adopt()` replays the tail into the tile. A terminal needs nothing more: xterm redraws from bytes.

**Why chat channels are left out:**
- `PtyManager.start` explicitly skips the runner for chats: `const kept = !isChatRun(request.config) ? await this.dependencies.held?.take(...)` and `const held = !chat && this.dependencies.held ? ...spawn(...)`.
- A chat run is a plain child process with pipes (`spawnChatProcess`, `electron/services/chat/chat-process.ts`), started in Trace's main process.
- The runner only spawns PTYs: `runner-main.ts` calls `nodePty().spawn(...)` for every spawn. Its protocol has no pipe kind (`SpawnRequest` in `protocol.ts`).
- The meaning of a chat lives in a `ChatStream` object inside the main process (`attachChat` in `pty-manager.ts`). Each kind keeps live protocol state:
  - `ClaudeStream` (`electron/services/chat/claude-stream.ts`): pending approvals (`pending`), mode change requests keyed by ids Trace makes with `randomUUID()` (`modeRequests`), the held-done timer (`HELD_DONE_MS`), the model from `init`.
  - `CodexStream` (`codex-stream.ts`): JSON-RPC counter `nextId`, in-flight callbacks (`calls`, functions), `threadId`, `turnId`, `approvals`, the `initialize` handshake already done in `start()`.
  - `AcpStream` / `GeminiStream` (`acp-stream.ts`, `gemini-stream.ts`): `sessionId`, `calls`, `approvals`, turn state (`turn`), `confirmTimer`.
- Round Tables and review chains watch every chat event (`this.tables.observe`, `this.chains.observe` in `attachChat`; `round-table.ts`, `review-chain.ts`).
- On quit, `dispose()` stops every run that is not `held`, so chats always stop.

**What a chat loses today:** only the turn in progress. `saveResume` / `takeResume` (`electron/services/storage/resume-list.ts`, used in `main.ts`) start the chat again on its conversation. The renderer saves the conversation id from the `ready` event as `resumeId` (`use-native-host.ts`). For Claude and Codex the earlier messages come back from the CLI's own transcript (`chatHistory` dependency in `main.ts`, `electron/services/chat/transcript.ts`). Gemini gets no history this way (`chatHistory` returns null for it in `main.ts`).

## Goals and non-goals

Goals:
- A Claude Code, Codex or Gemini/custom ACP chat keeps running while Trace is closed, crashes or updates.
- When Trace opens, the chat's tile shows the conversation, a turn still running keeps streaming, and a pending approval can be answered.
- Keep the runner small and protocol-agnostic, as section 1 of background-runner.md requires.

Non-goals (first version):
- Answering approvals while Trace is closed. The agent waits, as it would for a person.
- Round Table and review-chain seats. They stop on quit as today and reopen through the saved table (`SavedRoundTable`, `shared/types.ts`).
- Surviving a computer restart (nothing does).

## Options

### A. Move each ChatStream into the runner
The runner parses the agent's JSON and keeps the stream objects. Trace becomes a client of chat events.
- For: state never leaves one process; reattach is a "send me the events" call.
- Against: the runner kit would need `claude-stream`, `codex-stream`, `acp-stream`, `lines`, `shared/chat` and their imports. `runner-main.ts` says "nothing here may import more of Trace", and `kit.ts` copies only five scripts (`RUNNER_SCRIPTS`).
- Against: every chat parsing fix would change the runner, so most updates would need DRAIN (not built yet) and leave old chats on old code.
- Against: Round Tables call into streams (`setReadOnly`, `setPermissions`) from the main process; that would become remote calls.

### B. Pipe runs plus a journal, replayed into a new ChatStream (recommended, after a spike)
The runner gains a second run kind: a pipe child. It stays byte-only. For pipe runs it keeps a journal: every line the agent wrote, and every line Trace wrote to it, in order. When Trace opens, it builds a new `ChatStream`, feeds it the journal with writes muted and events not sent, and then goes live.
- For: the runner stays generic. Stream code stays in Trace and can change freely.
- For: in-flight `calls` callbacks and the handshake rebuild themselves, because the stream code runs again.
- Against: replay must be deterministic. Today it is not: `ClaudeStream.setMode` uses `randomUUID()`, and `ClaudeStream`/`AcpStream` use timers. Those need an injected id source and clock.
- Against: the journal grows for the whole chat. A cap is needed. Past the cap, Trace falls back to today's behaviour (stop and resume).

### C. Snapshot and restore per stream
Each `ChatStream` gets `snapshot()` / `restore()`. Trace sends the snapshot to the runner as updated `meta` after each change. The runner keeps agent output since the last snapshot.
- For: bounded size; no full replay.
- Against: `CodexStream.calls` and `AcpStream.calls` hold functions, which cannot be saved. Each pending request would need a named kind instead.
- Against: every new field in a stream must also be added to its snapshot, or reattach breaks quietly. That is easy to miss in review.

### D. Do nothing in the runner; finish the turn, then resume
Leave chats in Trace. On quit, ask whether to wait for running turns to end.
- For: very small.
- Against: does not meet the goal for crashes or updates.

## Recommendation

Option B, gated by a spike. It keeps the runner small, which is the main design rule in background-runner.md. It reuses the stream code as it is. It has a safe fallback (today's resume) whenever replay cannot be trusted. Rebuild the thread in the window from the CLI's transcript where one exists (Claude, Codex), and from the journal's replayed events otherwise.

## Spike result (2026-11-25)

Step 1, for Codex, in `electron/services/chat/replay.test.ts`:
- A Codex chat recorded as the runner would keep it (every line both ways, in order) was replayed into a new
  `CodexStream` with its writes muted. The new stream started again, and the person's message was sent again where the
  journal has its `turn/start`. Codex's lines were fed in as they came.
- Result: the same events as the original, an approval still open could be answered with the id Codex asked with, and
  Stop named the right turn.
- Replaying Codex's lines alone is not enough: the stream then does not know the turn (Codex's answer to `turn/start` has
  no request waiting for it), so Stop does nothing. So the replay has to rebuild Trace's own requests from the journal's
  `in` lines. Step 2 should therefore give each stream a way to take an `in` line as already sent (register its id),
  rather than calling `send()` again.
- Codex numbers its requests (1, 2, 3), so this works for Codex today.

From reading the code, not yet tried in a test:
- `ClaudeStream` makes its control request ids with `randomUUID()` (`control()`, `setMode()`), so a replay cannot match
  Claude's answers.
- `AcpStream` numbers its requests, but its message ids carry a random per-run tag (`run`), so a replayed chat would show
  its messages again under new ids.
- Both need step 2's injected ids before they can be replayed.



Each step is its own release, as in background-runner.md.

1. **Spike: can a stream be replayed?** Record real stdin/stdout lines from the existing stream tests' fixtures. Feed them twice through a stream with writes captured. Compare the writes and events.
   - Tests: a new `chat/replay.test.ts` for Claude, Codex and ACP. Expect identical writes after ids and clocks are injected.
2. **Make streams deterministic.** Add an `ids` and `clock` option to `ClaudeStream`, `CodexStream`, `AcpStream` (default `randomUUID` and real timers). No behaviour change.
   - Tests: existing stream tests unchanged; new tests with a fixed id source.
3. **Runner pipe runs. Built (1.47.0).** `SpawnRequest.pipe`; `runner-main.ts` starts it with `spawnChatProcess` itself (`chat/chat-process.js` is now in the kit). Its stdout is sent as output, its stderr as `stderr` frames and kept in its tail. A chat is never sent the Ctrl+C byte (its own protocol interrupts it), and when Trace falls behind it is paused, never skipped (a chat cannot lose a line).
   - **No protocol bump.** The plan was protocol 2, but a new protocol leaves the terminals of a runner on the old one running where the new Trace cannot see them. Instead the additions are optional: a runner that has them says `pipes: true` in its welcome (`RunnerClient.pipes`), and Trace sends chats only to such a runner. An older runner keeps serving its terminals until it leaves when idle; the next one starts from the new kit.
   - Tests: `runner.test.ts`, `client.test.ts`, and `npm run test:runner` with a real child.
4. **Journal in the runner. Built (1.47.0).** `runner/journal.ts`: chunks as they came, both directions in order (a direction's run of pieces is one entry), capped at 8 MB a chat (`JOURNAL_BYTES`; 64 MB with eight channels). Past the cap it is dropped and marked overflowed, since a replay needs the start. The `journal` frame is binary (no second JSON escaping); `RunnerClient.journal(term)` reads it.
   - Tests: `journal.test.ts` (order, joining, cap, bad bytes), the runner and client tests above.
5. **Chats start in the runner.** Remove the `!chat` guard on `held.spawn` behind a preference (off by default). Writes go through the runner and into the journal.
   - Tests: `pty-manager.test.ts` with a fake `HeldTerminals` for chats.
6. **Adopt a chat.** In `PtyManager.start`, `take()` for chats too. Build the stream, replay the journal muted, then attach live. If the journal overflowed, stop the process and start a resume instead.
   - Tests: adopt mid-turn, adopt with a pending approval, adopt after overflow, adopt of an ended chat.
7. **History in the tile.** Send a `history` event from the transcript (Claude, Codex) or from replayed events (ACP).
   - Tests: chat-store gets one history, no doubled messages.
8. **Smoke.** Extend the kill-and-reopen smoke with a chat channel using the fixture CLI.
9. **Turn on by default**, after a release with the preference.

## Risks

- **Replay drift.** A stream change that is not deterministic breaks reattach. Step 1's test runs in CI and catches it.
- **Agent buffers while Trace is gone.** The runner must always read stdout (as it does for PTYs), or the agent blocks on a full pipe.
- **Approvals with nobody there.** The agent waits until Trace returns. The phone cannot answer while Trace is closed, because the phone server lives in Trace.
- **Protocol bump.** Protocol 2 needs DRAIN of protocol 1, which is not built.
- **Mac updates.** A Mac runner runs from the app bundle (background-runner.md, step 6), so a Mac update still stops chats.
- **Windows stop.** Pipe children need the same job objects (`jobs.ts`) as PTYs.

## Open questions for the owner

1. Is option B acceptable, given it needs a spike before any commitment?
2. What journal cap is acceptable (memory per chat in the runner)? 8 chats can be open (`MAX_CHANNELS` in `shared/schemas.ts`). **Set to 8 MB a chat for now** (1.47.0); say if that should change.
3. Should Round Table seats be held in a later step, or never?
4. Should a chat waiting for approval while Trace is closed raise a system notification from the runner? That would add UI code to the runner.

Things I could not determine from the code:
- Whether Claude Code's stream-json mode accepts a second `initialize` on the same process. Option B avoids sending one, but a fallback might need it.
- Whether `codex app-server` refuses a second `initialize` or a `thread/resume` of a thread it already has loaded.
- Whether the fixture CLI in `scripts/` can emit chat protocols for the smoke; I did not read it.
