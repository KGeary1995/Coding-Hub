# Fixes after the audit of Trace 1.22.0 (17 and 18 November 2026)

This records what was changed on the branch `fix/audit-2026-11-17` (from `main` at `6b0e9b9`) after the audit in [audit-2026-11-17.md](audit-2026-11-17.md). The findings themselves are in [audit-2026-11-17-findings.md](audit-2026-11-17-findings.md). No dependency was changed. The fixes were released as 1.23.0: the version and `docs/RELEASE_NOTES.md` were changed in a separate commit after this record was written, so "Before merging" below describes the state before that.

## How it was done

- **Three fix steps.** Each step gave separate agents separate files, so no two edited the same file. Step one: ten packages by subsystem. Step two: the wiring in `electron/main.ts`, the stall record, the second-round findings, and build, tests and docs. Step three: the last changes where one side was written and the other was missing.
- **Every package was reviewed by a second, independent reader** who read the diff against the code it is wired to, ran its tests and reported problems; a correction pass then fixed what the review found. The reviews found real defects, including one that could have frozen the app (a review-line pattern in `shared/findings.ts` that took 115 seconds on a line of 34 `#` characters; fixed before it was ever committed).
- **Nothing was run on a Mac, on a real phone or in the installed app.** See "Not verified" below.

## Checks on the final state

| Check | Result |
|---|---|
| `npm run typecheck` (window, host, and now the host tests) | passes |
| `npm test` | 1,040 passed, 7 skipped, 0 failed (at `6b0e9b9`: 769 passed, 3 skipped, 4 failed) |
| `npm run build` | passes |
| `npm run test:release` | 11 of 11 |
| `npm run test:memory` | passes |
| `npm run test:pty` | passes |
| `npm run test:desktop` | passes (it failed on this computer at `6b0e9b9`, at line 277) |
| `npm run test:workbench` | passes, after one fix it led to (below) |
| `test:remote`, `test:paste`, `test:profiles`, `test:design`, `test:enterprise`, `test:productivity`, `test:models-stability` | each passes |

The four symbolic-link tests that failed on Windows without Developer Mode are now skipped there instead of failing.

**The workbench smoke caught a defect that the unit tests and both reviews had passed.** The tile's detail row, given its own height in this work, stayed shown while the header held the focus (after a click on Start, say) and lay over the notice under the header, so "Send coaching request" could not be clicked. Now, when anything but the terminal follows the header, the row takes its own space and stays shown (`src/tile.css`). This is why the smokes listed under "Not verified" matter before a release.

## The freezes

The cause the audit found is removed: nothing reads or lists the Google Drive memory folder synchronously on the main process any more.

- **Drive memory sync** (`electron/services/hub/drive.ts`, `memory.ts`, `service.ts`): asynchronous throughout. Notes whose sizes match on both sides are not read. Pairs that differ only in line endings are read once and then remembered in `.drive-compared.json` beside the local notes, across restarts. Notes are copied a few at a time, and the folder is listed once per sync instead of once per note. A real conflict no longer stops the project's other notes from syncing.
- **Channel start** (`electron/main.ts`, `electron/services/hub/auto-memory.ts`): the launch waits at most 1.5 seconds for other computers' notes, without holding the window. Quitting waits up to 5 seconds so a session's last summary reaches Drive.
- **Measured on this computer's real folders, read-only** (the new read path only, not a full sync inside the app): across the nine projects the longest hold of the process was 7.8 ms. The two projects that froze the window for 1.0 to 2.2 seconds take 351 ms (AI Scribe, 250 pairs read) and 198 ms (home folder) in the background, and the 250 pairs are not read again after the first sync.
- **Shorter hitches:** day usage keeps its progress between starts instead of reading 1.4 GB of logs again; this computer's usage is published to Drive at most every 5 minutes instead of on every tick; the registry `PATH` is read in the background; output flushes no longer commit to the database each time; chat replies are applied once per frame instead of once per token; a lost WebGL context falls back at once and is retried.
- **A stall is now recorded** (`electron/services/storage/host-health.ts`, `src/runtime/window-health.ts`): when the main process is blocked 250 ms or more, or the window has a long task or a late timer, `host-health.json` gets an entry with the side, the length and the job that was running. Settings → Running application → Application stability & crash diagnostics shows the list. The job is named for the main process only, and only when Trace knows it. `docs/troubleshooting.md` has the entry "Trace stops responding for a moment".

**No freeze was caught live before the fixes, and the fixed build has not been used day to day.** If a freeze still happens on this branch, the stall list will name what was running.

## Other fixes, by area

- **Usage:** agents started by a workflow are counted (their transcripts are under `subagents/workflows/<run id>/`); price rates match a model by its name or its ID.
- **Window:** Ctrl+R, Ctrl+Shift+R and Ctrl+W no longer reload or close the window; Close on a running channel asks first; closing a Round Table's channel keeps its findings; a linked computer's chat thread is no longer emptied; images sent with plan feedback reach the builder; a paste over 4,096 characters to a linked computer is sent in pieces; the tile's hover controls have their own row; error boundaries around each tile, the main view and the window.
- **Phone and linked computers:** turning phone access off and on keeps the `/api/screen` path (and a computer that already lost it gets it back); a computer removed under Other computers no longer links itself again without a code, and every automatic link is shown; an invalid `linked-computers.json` no longer stops the window from opening.
- **Git:** a submodule's own filter no longer runs when Trace only reads a repository.
- **Backups:** `usage.db` may use the whole backup limit; a restore keeps this computer's identity, pairings and links; a backup can be deleted (the host asks first).
- **Channels started from Trace** no longer inherit Trace's crash-handler pipe, so another Electron app's crashes are not written to Trace's crash-dump folder; old dumps are pruned.
- **Release and tests:** the Release workflow refuses to publish a commit the Windows release candidate has not passed on; every workflow job has a time limit and every action is pinned; the memory-server and real-PTY smokes run in CI; host tests are type-checked; `scripts/desktop-smoke.cjs` picks its extension row by name and redirects `HOME` as well as `USERPROFILE` (the cause of the failure at its line 277).
- **Help and docs:** the Help text and `docs/` were brought in line with the code.

## Choices made that can be reversed

Each was the least disruptive option; say so and it is changed back.

- **Close** asks only when the channel is running (`closeAsks()` in `src/components/ConfirmStep.tsx`).
- **Auto-link stays on, with no blocking prompt.** Each automatic link shows a banner, a desktop notification and a host-health entry, and a removed computer needs a code.
- **Shared rules stay as blocks in `CLAUDE.md` and `AGENTS.md`.** Passing them at launch instead is a redesign; only the line-ending and removal defects were fixed.
- **A session token limit now counts workflow agents' tokens**, so it can stop a run sooner than before.
- **On a Mac the channel shortcut is Cmd+1 to 8** (Option+digit types its character again). Windows and Linux keep Alt+1 to 8.
- **Clipboard writes from a channel (OSC 52) are accepted only from Claude Code and Codex channels.** A copy that vim or tmux sends to the terminal as that escape sequence in a plain terminal channel no longer reaches the clipboard. Reverse in `attachCopy` (`src/runtime/terminals.ts`).
- **Review lines:** verbs must be in capitals (`FIXED`, `REJECTED`, …); a lower-case verb is ignored, without a notice. A line that starts with a keyword in capitals but cannot be read raises a notice. A dash with spaces starts the note; a range is written without spaces.
- **Read-only Git views** report new submodule commits but not edits inside a submodule.
- **A channel started without a named Claude profile** no longer runs the two sign-in checks first.
- **Other computers see this computer's usage up to 5 minutes later** (at once on Sync now and at quit).
- **Handoffs saved from one phone or linked computer** are limited to one per 5 seconds.
- **The approval banner on a terminal channel** lies over the top of the terminal instead of pushing it down.
- **The memory project key** is applied 800 ms after typing stops, or on Enter.
- **The window keeps running at full speed while minimized or covered** (`backgroundThrottling: false`), so terminals and tasks keep moving.
- **Templates** keep a Round Table's seats and drop its work.
- **Tiles 400 px wide or narrower** hide a failed channel's Open log button and the topic.
- **Experiments:** a trial's minutes, rework and outcome must be typed; experiments and trials can be deleted after a question.
- **Shared rules:** a registered project whose folder is gone can be removed from the list.

## Not fixed, and why

- **Shared rules written into tracked files** (the redesign above).
- **Auto-link without a prompt** (kept by choice, above). A program already running on one of the person's own devices can still link itself; it is now shown each time.
- **The administrator screen service trusts files the person's own account can write:** needs an installer change. The option is off here.
- **Builds are unsigned:** needs a certificate.
- **Dependencies** (Electron 44.9.3 to the current 44.x, `electron-updater`): not changed by instruction; best done as its own step followed by the smokes and the release candidate.
- **A reloaded or crashed window still stops every channel:** keeping them needs a design for the new window to adopt running channels. Removing Ctrl+R and Ctrl+W takes away the usual way to trigger it.
- **Device sync still runs synchronously** on the 30-second tick (now labelled `hub-tick` in the stall record), and backups still compact, hash and encode on the main process. Moving them needs asynchronous rewrites or a worker.
- **A hierarchy task's images** (up to 6 MB) are written with each workspace save, about 15 ms. Repeated reads were removed; storing images outside the snapshot would remove the rest.
- **`scripts/gpu-crash-smoke.cjs`** was not touched: another session has uncommitted work on it. It should delete `CHROME_CRASHPAD_PIPE_NAME` from the environment it gives its test app.
- **Product choices left as they are:** `hub-add-server` without a confirmation; where "Install memory" writes; tile layout resetting when a channel is added; read-only seats at Full access running shell and MCP requests without an approval card (documented behaviour); a notice each time a CLI copies to the clipboard; the host accepting a chat send during a turn; the screen mirror running while no phone is connected; Trace's status line for Claude terminals.
- **Not established or not measured, so left:** a Codex conversation switching rollouts; the cost of the screen capture read-back; the cost of sending every channel's snapshot when a linked computer connects.
- **Release:** the packaged Windows smoke is not part of the gate; the screen-service and remote smokes are not in CI.
- **Small leads** that are visual only and could not be seen here (corner brackets clipped, a width transition, a focus outline).

## Not verified

- **The window.** Nothing visual was looked at: the tile detail row, the narrow-tile header, the close question, the dismissible banners, the stall list, the Delete and Remove buttons, the higher-contrast values, the phone styles. `test:desktop` exercises the main paths but does not judge appearance.
- **macOS and Linux.** The menu, the Dock reopen while quitting, the install-script update, Cmd+1 to 8 and `HOME` redirection in the smokes were written from the code and Electron's documentation, not run.
- **A real phone, Tailscale and a second computer.** Auto-link, the removed-computers list, `/api/screen` restoring and linked typing are covered by unit tests against the server only.
- **GitHub.** The release gate, the pinned actions and the two new CI steps have not run there.
- **Smokes not run:** `test:screen` and `test:screen-service` (they read the real screen), `test:packaged`, `test:install` and the GPU smoke.
- **A full Drive sync inside the app** on the real folders (only its read path was timed).

## Before merging

1. Use the branch for a day (`npm run dev` from the worktree, or a local build) and look at the items under "The window" above.
2. Open a pull request, wait for CI, start the Windows release candidate by hand and wait for it on the merge commit, as `AGENTS.md` describes.
3. Decide the version and write `docs/RELEASE_NOTES.md` from "Other fixes" and "Choices made" above.
