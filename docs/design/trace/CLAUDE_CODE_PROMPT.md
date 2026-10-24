# Prompt for Claude Code

Copy the `design_handoff_trace_redesign/` folder into the root of the Coding-Hub repo, then paste the text below into Claude Code.

---

Implement the "Trace" redesign described in `design_handoff_trace_redesign/README.md`. The HTML files in `design_handoff_trace_redesign/design/` are visual references only: open them to check details, but do not copy them. Rebuild everything in the existing stack: React 18, TypeScript, plain CSS custom properties and xterm.js. Do not add Tailwind or a UI library.

Do the work in phases. Commit after each phase and run `npm test` and the typecheck before every commit.

**Phase 1 — Tokens and fonts**
1. Copy `tokens.css` to `src/tokens.css` and import it first in `src/main.tsx`.
2. Bundle IBM Plex Sans Condensed (400/500/600) and IBM Plex Mono (400/500/600) locally so the Electron app works offline, e.g. with @fontsource.
3. Replace the colour, font, radius and spacing literals in `src/styles.css` and `src/workbench.css` with the `--tr-*` variables. Delete the navy-slate palette.

**Phase 2 — State model**
1. Add `channelState()` to `src/state/workspace-store.ts` exactly as specified in the README's "Agent state model" section, with unit tests for all 7 states, including the 80% context/budget threshold for `limit`.
2. Add a 120-sample tokens-per-second ring buffer per session, fed from the usage events received in `src/runtime/use-native-host.ts`. Also add `alerts` and `todayTotals` selectors.
3. Never fabricate trace data. If no usage is reported, the trace stays flat.

**Phase 3 — Shell**
1. Remove the sidebar (`Navigation.tsx`) and the page-level stats band and accounts strip in `WorkspaceHeader.tsx`.
2. Build `Topbar.tsx` and `StatusBar.tsx` to match the README's "Navigation structure" section: primary tabs, the Insight menu, Agent setup, + Channel, and the layout control on Workspace.
3. Wire the `G`+letter and `Alt+1…4` shortcuts.
4. Replace the footer in `App.tsx` with `StatusBar`.
5. Dissolve `WorkflowCenter.tsx`: recovery moves to the tile actions, search and templates to the command menu, and support to Help.

**Phase 4 — Channel tile (most important)**
1. Rebuild `SessionTile.tsx` per the README's tile spec and `design/TraceTile.dc.html`. It needs:
   - a 30 px header row;
   - a 40 px `ScopeStrip` component (an SVG trace from the ring buffer, the limit rail, the context bar with its 80% tick, and the rate readout);
   - the detail row on hover or focus-within;
   - the contextual action per state (Approve/Deny write `y`/`n` to the PTY; Retry; Write handoff; Review changes; Start);
   - the state chip with glyph + word.
2. Use `dense` (a 30 px strip) in grid layout.
3. Set the xterm theme from the README.
4. Make sure name and model ellipsize while the action and chip never clip.
5. Check that with 2 tiles at 1600×1000 the terminal is at least 75% of the window height.
6. Add the blink-3 and starting-pulse animations, and honour `prefers-reduced-motion`.

**Phase 5 — Screens**
1. Empty workspace: screen 03.
2. Changes: screen 04. Update `RepositoryPanel`, `DiffViewer` (with a split/unified toggle) and `GitDeliveryPanel` (as the stepper).
3. Usage: screen 05, with a KPI strip, a stacked daily chart with hover readout, and the per-session table with sparklines. Respect `reasoningIncludedInOutput`.
4. Command menu: screen 06, with scope prefixes `> @ / #`, match highlighting and the grouped results.
5. Agent setup: screen 07. A single route with a sub-nav that hosts the existing Accounts, Memory, Rules, MCP, Skills and Settings panels. Strip the explanatory paragraphs from those panels and use labels and tooltips instead.
6. Toasts for waiting, failed and success, as specified.

**Phase 6 — Remaining views and QA**
1. Restyle Projects, History, Tasks, Verification, Design and Coaching using the same vocabulary: a 48 px sub-header, list rows and bordered strips instead of card grids, and mono tabular numbers.
2. QA:
   - WCAG AA contrast;
   - visible focus on everything;
   - every action reachable by keyboard;
   - the layout holds at 125% zoom and at 1280 px width;
   - no blur, glass or gradient behind any text.

At the end of each phase, list anything in the README you couldn't implement exactly and explain why.
