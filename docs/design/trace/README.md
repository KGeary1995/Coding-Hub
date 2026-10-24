# Handoff: Coding Hub → "Trace" redesign

## Overview
This is a full visual and structural redesign of Coding Hub, the Electron + React 18 desktop app (repo `KGeary1995/Coding-Hub`) that runs Claude Code and Codex in terminal tiles. The chosen direction is **Trace**, which works like a lab oscilloscope. Each agent session is a *channel*. Its tile header carries a **scope strip** that plots the session's token throughput over the last 120 s, and the shape of that trace encodes the session's state. Navigation is reorganised by how often each area is used, and one bottom status bar becomes the only global status layer.

## About the design files
The files in `design/` are **design references built in HTML**. They are prototypes that show the intended look and behaviour; they are not code to paste in. The task is to **recreate them in the existing codebase**: React 18 + TypeScript, plain CSS with custom properties, xterm.js for terminals, and `lucide-react` where icons are still needed. Follow the repo's existing state (`src/state/*`), runtime (`src/runtime/*`) and IPC patterns.

To view the references, open `design/Trace Screens.dc.html` and `design/Trace System.dc.html` in a browser, with `support.js` next to them. Tiles in the screens are interactive: hover a tile to show its expanded header, and click the state chip to cycle through the states.

## Fidelity
**High fidelity.** Colours, type, spacing, sizes and copy are final. Match them exactly using `tokens.css`. Dark is the only theme specified; the tokens are named so a light theme can be added later by overriding the variables.

---

## Design tokens
Everything is in **`tokens.css`**. Copy it to `src/tokens.css` and import it first in `src/main.tsx`. Then replace the navy-slate values in `src/styles.css` and `src/workbench.css` with these variables.

Key values:
- **Surfaces:** bg `#0b1010`, terminal `#070a0a`, panel `#0d1312`, surface `#131a19`, hover `#18211f`, raised `#1f2a28`.
- **Lines:** `#1a2422` faint, `#22302d` default, `#2a3835` control, `#3b4d49` strong.
- **Text:** strong `#eef4f1`, fg `#d8e3df`, muted `#b6c4c0`, dim `#879692`, faint `#6f807b`.
- **Engine channel colours:** Claude `oklch(0.87 0.14 95)` (yellow, like CH1 on a bench scope); Codex `oklch(0.80 0.11 215)` (cyan, CH2).
- **States:** waiting `oklch(0.78 0.14 330)`, failed `oklch(0.68 0.19 25)`, limit `oklch(0.80 0.15 60)`, finished/starting `#d8e3df`, idle `#879692`, working = engine colour.
- **Fonts:** IBM Plex Sans Condensed (UI) and IBM Plex Mono (terminals and **every number**, with `font-variant-numeric: tabular-nums`). Load 400/500/600 from Google Fonts, or bundle them locally. Electron should ship them offline, e.g. via `@fontsource/ibm-plex-sans-condensed` and `@fontsource/ibm-plex-mono`.
- **Spacing:** 4/8 grid (4, 8, 12, 16, 24, 32, 48, 64).
- **Radii:** chip 2, control 3, panel/tile 4, overlay 6.
- **Elevation:** expressed with tone and lines. Only overlays get a shadow (`0 24px 64px rgba(0,0,0,.6)`), and they sit over a solid scrim `rgba(4,7,7,.78)`. **No blur, glass or gradients anywhere behind text.**
- **Motion:** 80 / 160 / 240 / 400 ms; ease `cubic-bezier(.2,.7,.2,1)`, exit `cubic-bezier(.4,0,1,1)`.

---

## Agent state model (core logic)
Derive one `ChannelState` per session from the existing `Session` and `UsageTelemetry` types (`shared/types.ts`):

```ts
type ChannelState = 'idle'|'starting'|'working'|'waiting'|'finished'|'failed'|'limit';

function channelState(s: Session, latest?: UsageTelemetry): ChannelState {
  if (s.status === 'error') return 'failed';
  if (s.status === 'exited') return s.exitCode === 0 ? 'finished' : 'failed';
  if (s.status === 'idle') return 'idle';
  if (s.status === 'starting') return 'starting';
  if (s.status === 'waiting') return 'waiting';
  const ctx = latest?.context ? latest.context.usedTokens / latest.context.limitTokens : 0;
  const budget = /* SessionBudget usage ratio from shared/productivity, if set */ 0;
  return Math.max(ctx, budget) >= 0.8 ? 'limit' : 'working';
}
```

Every state is shown in **four redundant ways**, so colour is never the only signal:

| State | Glyph | Chip word | Trace shape | Colour | Chip style |
|---|---|---|---|---|---|
| idle | ○ | IDLE | flat line at baseline | `--tr-fg-off` trace, dim chip | outlined |
| starting | ◌ | ARMING | flat, then ramps up at the right edge | `#d8e3df` | outlined, pulses 1.2 s |
| working | ● | RUN | busy, noisy throughput | engine colour | outlined |
| waiting | ◆ | HOLD | noise, then held flat high | waiting magenta | **solid**, blinks 3× |
| finished | ✓ | STOP | decays to flat | `#d8e3df` | outlined |
| failed | ✕ | FAULT | stops abruptly (cut off) | failed red | **solid**, blinks 3× |
| limit | ▲ | CLIP | clipped flat against the dashed limit rail | limit orange | outlined |

The tile **frame** (1 px border) takes the state colour when the state is waiting or failed. Otherwise it is `#1f2b29`, or `#3b4d49` when the tile is focused or selected.

---

## The scope strip (signature element)
- It is a 40 px band under the tile's header row (30 px in the 4-tile grid), with background `--tr-surface` and a 1 px top border `#1a2422`.
- **Graticule:** vertical lines every 10% of the width (`repeating-linear-gradient(90deg, #1a2422 0 1px, transparent 1px 10%)`). There are no horizontal lines and no glow.
- **Limit rail:** a dashed horizontal line at 15% from the top, stroke `#3b4d49`, dash `3 4`.
- **Trace:** an SVG `<path>`, stroke 1.6 px using `vector-effect: non-scaling-stroke`, drawn in a `viewBox="0 0 400 40"` with `preserveAspectRatio="none"`. The data is a **ring buffer of tokens per second for the last 120 s**, filled from the session's `UsageTelemetry` events: (input + output) deltas bucketed per second. Normalise against a per-session rolling max, with a floor so the trace isn't noise at low rates. A busy session produces visible variation; a waiting one is held at a high flat level; and so on, per the table above. If the CLI reports usage only rarely, interpolate between events; never fabricate activity.
- **Labels:** `−120 s` (mono 10 px, `#6f807b`) bottom-left. A `rate 41 tok/s` readout sits top-right on a `--tr-surface` chip, mono 11 px.
- **Context bar:** 3 px along the bottom edge, filled to context %. The fill is `#4f625d`, or limit orange once ≥ 80%. There is a 1 × 6 px orange tick at 80%.
- **Update cadence:** shift one sample per second, and transition the context bar width over 400 ms. Under `prefers-reduced-motion`, redraw in place with no transitions.

---

## Navigation structure
`src/components/Navigation.tsx` (the 17-item sidebar) is **removed**. In its place:

1. **Top bar** (`TraceTopbar`, 40 px, bg `--tr-surface`, bottom border `--tr-line`, padding 0 12 px, gap 4). From left to right:
   - Wordmark: four bars of 3 px each (heights 6/14 in Claude yellow, 9/4 in Codex cyan) plus "trace" in Plex Mono 600 16 px. The product name is open; keep "Coding Hub" if preferred.
   - Project switcher button showing `orbit-web ▾` (28 px tall, 1 px `#2a3835` border, radius 3). It reads "No project" when none is open.
   - **Primary tabs:** Workspace · Changes (with a count of changed files) · Projects. Each is 28 px tall with padding 0 14; the active tab has bg `#1f2a28`, text `#eef4f1` and weight 600.
   - A 1 × 18 px divider.
   - **Insight ▾** menu containing Usage, History, Tasks, Verification, Design and Coaching. When one of these views is open, its name replaces "Insight" on the button (e.g. "Usage ▾").
   - Spacer.
   - Workspace view only: the layout segmented control (single ▢, columns ▥, rows ▤, grid ▦).
   - Command field, 300 px wide: placeholder "Search or run a command" and the shortcut `Ctrl ⇧ P`. It opens the command menu.
   - **Agent setup** button (outlined), which opens one area containing Accounts, Shared memory, Shared rules, MCP servers, Skills & plugins and Settings.
   - **+ Channel**, the primary button (bg `#d8e3df`, text `#0b1010`, weight 600).
2. **Status bar** (`TraceStatusbar`, 32 px, bg `--tr-surface`, top border, mono 12 px `#879692`, cells separated by 1 px borders). It replaces the current footer and the page-level stats bands:
   - One cell per channel: an 8 px engine square, `CH1`, then glyph + state word (`run`, `hold`, `fault`…) in the state colour, then the rate.
   - The project name and `⎇ branch ↑ahead`.
   - Spacer.
   - `Σ today 79.9k tok $0.63`.
   - Alerts: `◆ CH2 needs approval · …` in the waiting colour, or the failed colour if anything has failed. It shows "no alerts" otherwise.
   - A host indicator: a 6 px green dot and "host · local".
3. **Workflow center is dissolved.** Recovery becomes the failed tile's Retry / Open log actions. Search and Templates move into the command menu. Support / Releases move into Help.
4. Keyboard: `Alt+1…4` focuses a channel; `G` then a letter opens a view (U Usage, H History, T Tasks, V Verification, D Design, O Coaching, C Changes). Every destination is also reachable from the command menu.

Map `NavigationView` in `src/state/workspace-store.ts` onto these groups. The existing view keys (`workspace`, `diff`, `projects`, `usage`…) can stay; only the chrome changes.

---

## Screens

The canvas is 1600 × 1000. Every screen is: top bar 40 + content + status bar 32.

### 01 Workspace · 2 channels (hero)
- **Content area:** CSS grid of `minmax(0,1fr) minmax(0,1fr)`, gap 8, padding 8. Tiles fill the full height. There is **no** page header, stats band, accounts strip or sessions toolbar; that information now lives in the top bar, the status bar and the tile headers. The terminal body takes about 81% of the window height.
- **Tile** (`TraceTile`): background `--tr-term`, 1 px frame, radius 4. From top to bottom:
  - **Header row**, 30 px, bg `--tr-surface`, padding 0 6 0 8, gap 10, in this order:
    - drag handle `⋮⋮` (`#4f625d`);
    - channel badge `CH1` (engine colour bg, `#0b1010` text, mono 600 11 px, padding 1 6, radius 2);
    - name (Plex Cond 600 15 px `#eef4f1`);
    - model (mono 12 `#879692`);
    - optional profile chip (mono 11, 1 px `#2a3835` border) for named Claude profiles;
    - flex spacer;
    - `ctx 38%` and `tok 48.2k` (mono 12; the value turns orange at ≥ 80%);
    - the **contextual action**, if any (see below);
    - the **state chip** (22 px, mono 600 11 px, letter-spacing .06em, 1 px border in the state colour, radius 2; filled solid for waiting and failed).
  - The name and model shrink with an ellipsis; the action and chip are `flex: none` and never clip.
  - **Scope strip** (see above).
  - **Expanded detail row** (30 px, bg `#0f1514`), shown on hover or focus-within:
    - mono 11: `pid 623 · cwd ~/orbit-web · cost $0.41 · ctx 76k / 200k`;
    - buttons: Stop (1 px failed-red border, text `oklch(0.82 0.11 25)`), Settings, Duplicate, Maximize, Close (22 px tall, 1 px `#2a3835`, Plex Cond 13 px).
  - **Terminal:** xterm.js on a solid `#070a0a` background, Plex Mono 13/20, padding 12 14.
- **Contextual actions**, one per state, each shown with its key hint (mono 10):
  - waiting: **Approve `Y`** (magenta bg, `#120b10` text) and **Deny**;
  - failed: **Retry `R`** (`#d8e3df` bg) and **Open log**;
  - limit: **Write handoff `H`** (orange bg);
  - finished: **Review changes `G C`**;
  - idle: **▶ Start `⏎`** (engine colour bg).
  - Approve and Deny send `y` or `n` into the PTY. Write handoff opens Shared memory, prefilled for that session.
- **xterm theme:** background `#070a0a`, foreground `#d8e3df`, cursor = engine colour, selection `#2a3835`. ANSI green `oklch(0.82 0.13 155)`, red `oklch(0.72 0.16 25)`, yellow `oklch(0.80 0.15 60)`, magenta `oklch(0.78 0.14 330)`, cyan `oklch(0.80 0.11 215)`. Convert these to hex for xterm.

### 02 Workspace · 4 channels, grid
- A 2 × 2 grid (`grid-template-rows: minmax(0,1fr) minmax(0,1fr)`), gap 8; scope strips are 30 px (`dense`).
- Example states: CH1 Claude working; CH2 Codex failed; CH3 Claude (profile "Work", opus-4.1) at ctx 92% with its trace clipping; CH4 Codex finished.
- The status bar's alert reads `◆ CH2 failed · CH3 ctx 92%` in the failed colour.

### 03 Workspace · empty (no project)
- A centred column 1080 px wide, with padding 64 above.
- **"No signal" scope:** 112 px tall, bg `#070a0a`, 1 px `#1f2b29` border, graticule at 5% vertical and 25% horizontal, and a flat 2 px `#4f625d` line at mid-height. Labels: `CH— · no signal` (top-left) and `open a project to arm a channel` (bottom-right).
- Heading "Open a project" (40/44, 600), with the sub-line "Every channel runs inside a local folder." (18 px `#b6c4c0`).
- **Three action keys** in a 3-column grid, gap 8; each is 96 px tall, padding 14 16, radius 4. A mono 12 row holds the index and shortcut, then the title (20/600) and a 14 px subtitle.
  - **Open folder** (primary: `#d8e3df` bg, Ctrl O);
  - **Clone from GitHub**, showing `▲ GitHub sign-in needed` in orange while GitHub is disconnected;
  - **New project** (Ctrl ⇧ N).
  - The secondary keys have bg `#131a19` and a 1 px `#2a3835` border.
- Two columns, 1.6fr and 1fr, gap 40:
  - **Recent projects:** rows with the name (17/600), `path · ⎇ branch` (mono 12), a 140 × 28 throughput sparkline of the last session, and the last-activity time.
  - **Engines on this machine:** Claude Code / Codex / GitHub, each with its version and status (`✓ signed in` in green, or a **Sign in** button with an orange outline).

### 04 Changes
- Sub-header (48 px): "Changes" (20/600); `~/orbit-web · ⎇ main ↑2`; `3 files · +43 −4`; a "Workspace root ▾" select; and "Refresh R".
- **Three columns: 260 px | 1fr | 320 px.**
  - **File list** (bg `--tr-panel`): groups `unstaged` / `staged` / `untracked` with mono-12 headers and counts.
    - Each row has a 16 px checkbox (which stages the file), a status letter (M orange, ? green, D red), the filename (mono 13), its directory (mono 11 dim) and `+n −n`.
    - The selected row has bg `#18211f` and a 2 px `#eef4f1` left bar.
    - The panel footer holds Stage all and Discard….
  - **Diff:** a 44 px toolbar with the path, `+3 −2`, a Split/Unified segmented control, Revert hunk, and **Stage file S** (primary). Below it, a hunk header `@@ -1,13 +1,14 @@ · fetchStats` (mono 12, bg `#0d1312`).
    - **Split rows:** `40px 1fr 40px 1fr`, mono 12.5/22. Deleted lines have bg `--tr-del-bg` with a `− ` marker in `--tr-del`; added lines have bg `--tr-add-bg` with `+ `. Long lines wrap (`pre-wrap`) with a 2ch hanging indent.
    - **Unified rows:** `44px 44px 1fr` (old line number, new line number, code).
    - Footer: `last touched by CH1 · Claude Code · 3 min ago`, plus the hints `J / K next file · ] next hunk`. Only show the last-touched line if the session's file activity actually reports it; the existing scope checks cannot attribute edits.
  - **Delivery** (bg `--tr-panel`): a vertical 4-step stepper with 22 px numbered circles joined by a 1 px line.
    1. **Stage**: "0 of 3 files staged".
    2. **Commit**: a 34 px subject input, a 72 px body textarea, the latest verification result (`✓ stats suite passed · 2 min ago` in green), then **Stage all & commit** (primary, flex 1) and **Commit & push**.
    3. **Push**: `main → origin/main · 2 ahead`.
    4. **Pull request**: when GitHub is disconnected, shows "Needs GitHub sign-in" and a **Connect GitHub** button outlined in orange.
  - Map this onto `GitDeliveryPanel.tsx` and `DiffViewer.tsx`.

### 05 Usage
- Padding 16 20, gap 16.
- **Header row:** "Usage" (24/600); a window segmented control (Today / 7 d / **14 d** / 30 d); an engine filter (All engines / ■ Claude / ■ Codex); spacer; `CLI-reported · local · updated 03:52`; Refresh.
- **KPI strip:** one bordered strip, **not cards**, split into 5 equal cells by 1 px dividers, bg `--tr-panel`. Each cell has a label (mono 12 dim), a value (mono 500 34/38, tnum) and a sub-line (13 px dim). The cells:
  - input tokens, with a delta vs the prior period;
  - output tokens, with "incl. Xk reasoning". Reasoning is never added twice; respect `reasoningIncludedInOutput`.
  - cache reads;
  - sessions, with "N hit 80% context";
  - estimated cost, citing the local price table version.
- **Daily tokens chart** (bg `--tr-term`, 1 px border, radius 4), then a 300 px side panel:
  - Readout row: the hovered day (default today), its total, the Claude and Codex split, its cost, and the caption "input + output · cache excluded".
  - Plot 220 px tall with a 44 px y-axis (0 / 50k / 100k / 150k, gridlines `#1a2422`) and a `#3b4d49` baseline.
  - Bars are flex 1 with gap 10, **stacked by engine** (Claude at the bottom, Codex on top, 1 px separator). Non-hovered bars are at 0.72 opacity; the hovered one is at 1 with a column highlight `#111817`. X labels are day-of-month (mono 11).
  - Side panel: "By engine · 14 d" with a 10 px proportional split bar and two rows (engine, tokens, cost); then "Context peaks": sessions over 80% (orange), median peak, and handoffs written.
- **Per-session table:** columns `92px 1fr 96px 104px 56px 64px 64px 56px 140px 56px 120px` = channel (engine square + name + state glyph) · session (first prompt, Plex Cond 14, ellipsis) · model · started · time · input · output · cache · context peak (4 px bar with the 80% tick, plus %) · cost · throughput sparkline.
  - Rows are 40 px with hover `#111817`. The header row is 32 px, bg `--tr-surface`, mono 11 dim.
  - All numbers are right-aligned and use tnum.

### 06 Command menu
- It opens over the workspace. The scrim is solid `rgba(4,7,7,.78)`, with **no blur**.
- **Panel:** 760 px wide, 96 px from the top, centred; bg `#131a19`, 1 px `#3b4d49` border, radius 6, overlay shadow.
- **Input row** (56 px): a `›` prompt, the query in Plex Cond 20 px, and a result count on the right.
- **Scope chips:** All · Actions `>` · Channels `@` · Files `/` · Memory `#`. Typing a prefix character filters to that scope.
- **Grouped results** under mono-11 group labels (actions, channels, files, memory). Rows are 38 px:
  - an 18 px icon glyph coloured by type (e.g. channel state glyph in its engine colour);
  - the label, with the match in bold `#eef4f1` and underlined (`#4f625d`, offset 3);
  - meta on the right (e.g. `hold · approval` in magenta, `untracked` in green);
  - the shortcut.
  - The selected row has bg `#1f2a28` and a 2 px `#eef4f1` left bar.
- **Footer** (34 px, mono 11): `↑↓ move · ⏎ run · Tab scope · Ctrl ⏎ open beside · Esc close`.
- Searches across actions, live channels, session history, project files, memory handoffs and rules. Extend `CommandMenu.tsx`.

### 07 Agent setup
- **Two columns: 280 px nav | content.**
  - **Nav** (bg `--tr-panel`): the title "Agent setup" (20/600), then items with a name (16 px) and a live status line (mono 11), e.g. `2 of 3 connected ▲`, `3 handoffs · synced 2m ago ✓`, `applied to 1 project ✓`, `2 enabled · claude + codex`, `5 installed`, `backups, updates, storage`.
    - The active item has bg `#18211f` and a 2 px left bar. At the foot: renderer/host versions and the data path.
  - **Content** for Accounts (padding 24 32):
    - Title row: "Accounts" (28/600), the meta "login status from each local CLI · model access is checked at launch", and Refresh status.
    - Engine list rows, **not cards** (grid `36px 220px 200px 1fr auto`, 16 px vertical padding, row dividers): mark, name + version, status (✓ green or ▲ orange), detail, then actions (Reconnect / **Connect GitHub** primary, plus Install guide ↗).
    - **Claude profiles** table with columns profile / config directory / used by (channel badge + status) / action. The last row is an inline "New profile name" input with Add profile.
    - A collapsed row "Official CLI sign-in terminal ▸" showing `claude login · codex login · gh auth login`.
  - The other sections (Memory, Rules, MCP, Skills, Settings) reuse this content pattern: title row, list rows, then an inline form. Port their existing panels (`AccountsPanel`, `RulesPanel`, `HubPanels`, `RuntimeBackupPanel`, `UpdatesPanel`) into this frame and remove the explanatory paragraphs; use labels and tooltips instead.

### 08 Channel tile anatomy
This is a reference sheet. It shows the expanded and collapsed headers and all 7 states. Use it as the spec for `SessionTile.tsx`.

### Not yet designed
Projects, History, Tasks, Verification, Design and Coaching. Build them with the same vocabulary:
- a 48 px sub-header row (title + meta + actions);
- bordered strips and list rows instead of card grids;
- mono tabular numbers;
- scope-strip sparklines wherever a session's activity is shown.

---

## Interactions & motion
- **Hover / focus a tile** → the detail row expands (height 0 → 30 over 240 ms, `--tr-ease`). The tile also shows it while it's the focused or selected channel.
- **State enters waiting or failed** → the chip and frame blink 3 times (`tr-blink3 .4s steps(1) 3`), then stay solid. A toast slides in from the bottom-right over 240 ms.
- **Starting** → the chip pulses (`tr-start-pulse 1.2s ease-in-out infinite`) until the first output arrives.
- **Finished** → the trace decays to flat over 400 ms; nothing flashes.
- **Working** → only the trace scrolls. Nothing else is animated, and there are no idle animations anywhere.
- **Toasts** (bottom-right, 420 px, bg `#131a19`, 1 px border in the state colour, radius 4, toast shadow):
  - needs-you: `◆ CH2 needs approval` / `edit src/hooks/useStats.ts (+6 −2)` with **Approve Y** and **Jump Alt 2**. It persists until handled.
  - failed: **Retry**. It persists.
  - success (e.g. a commit): auto-dismisses after 6 s.
- **Reduced motion:** every animation and transition becomes an instant change, and the trace updates in place.
- **Focus:** a 2 px `#eef4f1` outline with a 2 px offset on every control and tile. Tiles are focus targets: Enter moves focus into the xterm, Esc returns it to the tile. Y / N / R / H act on the focused tile.
- **Zoom at 125%:** below 1440 px effective width the top-bar command field collapses to an icon button, and the grid layout drops to columns.

## State management
- `src/state/workspace-store.ts` holds the sessions, tiles, `layoutMode` and `focusedSessionId`, all of which already exist. Add:
  - `channelState(sessionId)`, a selector using the function above;
  - `throughput: Record<sessionId, number[120]>`, the ring buffer fed by the usage events in `src/runtime/use-native-host.ts`;
  - `alerts`, derived as sessions in waiting, failed or limit, in that order;
  - `todayTotals`, holding tokens and cost.
- Channel numbers (`CH1…CH4`) follow the tile order in the grid.
- Command menu sources: the static action registry, sessions, `SessionHistoryRun[]`, file search through the existing IPC, and memory handoffs.

## Assets
There are no images. The wordmark is four CSS bars plus text. Glyphs are Unicode (○ ◌ ● ◆ ✓ ✕ ▲ ⎇ ▾ ▸), rendered in Plex Mono. Keep `lucide-react` only for a few utility icons if needed (e.g. external-link); state and channel identity must stay glyph- and colour-based as specified. The fonts are IBM Plex Sans Condensed and IBM Plex Mono (OFL).

## Files in this bundle
- `tokens.css`: all tokens as CSS custom properties, ready to import.
- `design/Trace Screens.dc.html`: screens 01–08 (the reference).
- `design/Trace System.dc.html`: colour, type, spacing, radii, elevation, motion, the component sheet, and the reasoning behind the design.
- `design/TraceTile.dc.html`, `TraceTopbar.dc.html`, `TraceStatusbar.dc.html`: the three shared components. Their logic class shows the exact state-to-style mapping and the trace-shape generator. In the mock the trace data is generated; in the app it must come from real usage events.
- `design/support.js`: needed only to open the `.dc.html` files in a browser.
- `CLAUDE_CODE_PROMPT.md`: a step-by-step implementation brief to paste into Claude Code.
