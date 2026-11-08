# Trace redesign: decisions and deviations

The Claude Design handoff in this folder (`README.md`, `design/`, `tokens.css`) is the visual source of truth. These decisions, made after reviewing it against the codebase, take precedence where they differ.

## Decisions (October 2026)

| Topic | Handoff | Decision |
|---|---|---|
| Waiting state and approvals | Approve / Deny type `y` / `n` into the PTY | Detect "waiting" (Claude Code through a `--settings` notification hook, Codex best effort). **Approve focuses that channel's terminal**, so the person answers the CLI's own prompt. Nothing is typed for them. |
| Scope-strip trace | Tokens per second from usage events | **Terminal activity**: PTY output per second. Usage arrives once per message or turn, so a token trace would be flat with rare spikes. Token totals stay in the header and status bar. |
| Product name | "trace" wordmark; name open | **Trace** in the interface. Installer, data folders, app ID and update channel keep their existing names so upgrades keep working. |
| Delivery | Six phases | One pull request per phase, each through CI and review. |

## Deviations found in review

- **Usage table:** shows the session's name, not its first prompt. Conversation text is deliberately kept out of the renderer (`electron/services/hub/telemetry.ts`).
- **Files and Help:** the handoff gives them no place. Files is reachable from Changes and the command menu; Help from the top bar and the command menu.
- **Templates:** has a form, so it moves to Projects rather than into the command menu.
- **Revert hunk / Discard…:** new destructive actions that the app does not have today. They are left out of the redesign.
- **Context percentage:** only Codex reports its context window. Claude tiles show `ctx —`, and "limit" for Claude comes from session budgets.
- **Price table version:** prices are user-configured, so the Usage cost cell cites "configured rates" instead of a version.
- **Phase 1 type scale:** the existing 13–14 px scale is kept until each view is rebuilt with the Trace type scale in later phases.

## How "waiting" is detected (phase 2)

- **Claude Code 2.1.63 and later** (HTTP hooks were added in 2.1.63): the launch adds `--settings` with an HTTP `Notification` hook that posts to a loopback endpoint in the app (`electron/services/cli/attention.ts`). Each run gets a secret path. Only `permission_prompt` and `elicitation_dialog` count. `NO_PROXY` gains `127.0.0.1,localhost` so a proxy cannot intercept the request. Earlier versions, `--bare`, `disableAllHooks`, or an `allowedHttpHookUrls` list that excludes loopback leave the channel without alerts.
- **Codex:** the launch sets `tui.notifications=["approval-requested"]`, `tui.notification_method="osc9"` and `tui.notification_condition="always"`, and the app reads the resulting OSC 9 notifications from the terminal output. Versions without these keys ignore them.
- **Clearing:** the alert clears on the person's next real keystroke in that terminal. Focus and mouse reports from the terminal do not count, and a request that arrives after the keystroke was sent stays. It also clears when the run exits. It is never saved.

## Channel tile (phase 4)

- **Detail row:** it takes the scope strip's place while the header is pointed at, or while one of its controls has keyboard focus. In the handoff it expands below the strip, which would resize the terminal, and make the CLI redraw, every time the pointer crossed a tile. An overlay on the terminal would cover notices and the buttons in them.
- **Approve / Deny:** a single **Answer** action focuses the terminal, per the waiting decision above. The handoff's Y / N / R / H tile keys are not added; Enter on a focused tile starts it or moves into its terminal.
- **Scope readout:** shows terminal output (`out 1.2k/s`, characters per second), matching the trace, instead of `rate … tok/s`.
- **Context bar:** for Claude, which does not report a context window, the bar shows the session budget used when a budget is set, and is hidden otherwise.
- **Grid spacing:** tiles are 8 px apart, as in the handoff, so a 2 × 2 grid fits a 1100 × 800 window at 125% without scrolling.

## Screens (phase 5)

- **Empty workspace:** recent projects come from session history, so they list folders channels have run in. They show the folder and last activity, without the handoff's branch and throughput sparkline, which are not recorded per project. Engines come from the account status the Accounts screen uses. **Use channels without a project** keeps the old way to give channels their own folders before choosing a project.
- **Command menu:** files and memory come from the existing local search (`flow-search`), which reads file contents, so it waits 300 ms after typing and, in All, for three characters. Ctrl ⏎ "open beside" is left out; nothing opens side by side yet.
- **Notices:** needs-you and failed notices are built; success notices (for example after a commit) are left for when delivery reports back through the renderer.
- **Usage:** the session table has no time or throughput sparkline columns, because usage records hold one timestamp and no activity history. "Handoffs written" is not shown, since memory notes are not linked to runs. Usage records keep each run's latest context report, and Codex can compact its context, so the screen labels context as "at last report" rather than as a peak.
- **Changes:** the diff stays unified; the split view and Revert hunk (see above) are not built. The "last touched by" footer is left out because file edits are not attributed to channels.
- **Agent setup:** status lines are live for Accounts (signed-in count) and Shared memory (automatic or off); the others describe what the area holds rather than counting it.

## Remaining views and QA (phase 6)

- **Remaining views** (Projects, History, Tasks, Verification, Design, Coaching, Help, Files and the Agent setup areas) take the Trace type scale and surfaces from one stylesheet (`src/views.css`): page headings drop the eyebrow label and use 24 px titles with one line of description, text and controls use the 13–16 px scale, and cards become bordered panels. Their layouts are otherwise unchanged; the handoff did not design them.
- **Type scale:** the old 8–13 px sizes in `styles.css` and `workbench.css` are mapped to 11–14 px (8→11, 9 and 10→12, 11→13, 12 and 13→14), ending the phase 1 exception.
- **Faint text:** `--tr-fg-faint` is `#7b8c87` instead of `#6f807b`, so faint labels reach 4.5:1 on the surface and hover colours (5.0 and 4.7) as well as on the background. `--tr-fg-off` stays as designed; it is used only for icons, borders and traces, which need 3:1.
- **Removed CSS:** rules for elements the redesign removed (the sidebar, old tile header, run toolbar and footer, workspace header and summary strip) are deleted. Rendered screens are unchanged by the removal (pixel comparison of every view).

## Flight Deck Lite (November 2026)

The owner chose direction **11 · Flight Deck Lite** from the redesign canvas (Mission Control with a little of Flight Deck, intensity 35 of 100). It replaces the bench-scope look above; the structure (top bar, tiles, status bar, state model) stays.

| Topic | Before | Now |
|---|---|---|
| Palette | Dark teal, Claude yellow, Codex cyan | Dark slate `#0a0e12`, Claude amber `#ffb547`, Codex cyan `#5fe1ff`, needs-you magenta `#ff5fcf`, the person lavender `#d0c4ff` (Round Table) |
| Type | IBM Plex Sans Condensed | **Chakra Petch** for the interface (uppercase, tracked, for navigation and labels), IBM Plex Mono for terminals and every number |
| Shape | 2–6 px radii | Square frames (overlays 2 px) |
| Background | Flat | A faint cyan 32 px grid behind everything; panels and tiles are solid, so text never sits on it |
| Emphasis | Frame colour only | **Corner brackets** on the focused channel (its engine colour) and on one that needs you or failed; a soft glow only on a channel waiting for you. "No glow" no longer holds for that one state |
| Intensity | — | `--tr-grid`, `--tr-bracket-alpha`, `--tr-glow-*` in `src/tokens.css` carry the canvas's intensity 35; change them together |

Tile anatomy (1.16.1): the header reads `⌖ CH1 CLAUDE CODE <name> <MODEL> <ACCOUNT> … START ○ IDLE`, the channel number and engine as text in the engine's colour, account and action outlined. The old scope strip under the header is gone; the tile's footer carries the segmented CTX gauge, its share, the tokens today and a small output trace with its rate. Round Table messages carry a hexagon seat and `CLAUDE · DRIVER` / `CODEX · REVIEW` / `YOU`.

Every screen (1.16.1): `src/flight-deck.css`, loaded last, gives the shared pieces the direction's form: uppercase tracked page titles, mono section labels, outlined uppercase buttons, cyan for whatever is active (tabs, open menus, segments, the default choice), uppercase status bar, and the idle channel readout. `scripts/design-tour.cjs` screenshots every view for checking a change page by page. The app icon is the reticle (`scripts/make-icon.cjs`). Since 1.16.3 it is one mark at every size, the same as the top bar's and the phone's: one bold cyan ring, the crosshair outside it and the amber centre (the inner ring is gone, as it blurred at title-bar sizes and the two drawings had drifted apart).
