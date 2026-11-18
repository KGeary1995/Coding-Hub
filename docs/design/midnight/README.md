# Midnight: the look of Trace (November 2026)

Midnight replaces Flight Deck Lite (`docs/design/trace/DECISIONS.md`). The owner asked for it on 2026-11-18 after comparing Trace with a dashboard that read as more finished: rounded cards on deep navy, clear layers, colour that carries meaning, short labels instead of paragraphs.

**What stays:** the structure (top bar, channels in tiles, status bar, the views and where they live), the state model, every behaviour, the amber keycap icon, the engine colours.

**What changes:** the palette, type, shape and depth; every screen is built from one set of shared parts; on-screen instructions shrink to labels, hints and tooltips.

This file is the source of truth for the look. `src/tokens.css` holds the values. Where this file and the code differ, fix the code or change this file in the same commit.

---

## 1. Principles

1. **One part, drawn once.** A button, card, field, badge or empty state has one definition in `src/ui.css`. A screen never restyles a shared part; it composes them.
2. **Three layers of depth.** Background, card, well. A card sits on the background; rows, fields and terminals are wells inside a card. Each step is visibly different.
3. **Colour means something.** Blue is the interface's accent (active, primary, focus). Amber is Claude, cyan is Codex. Green, amber, red and magenta are states. Nothing else is coloured.
4. **Labels, not paragraphs.** A screen is titles, labels, values and controls. Explanation lives in a hint, a tooltip or Help.
5. **No empty voids.** A screen with no data shows its real layout with an empty state inside it.
6. **Sentence case.** No uppercase transforms. The only capitals are the ones typed (`CH1`, `Ctrl`).

---

## 2. Tokens

Names keep the `--tr-` prefix so existing rules keep working. Colours are defined only in `src/tokens.css`; no other stylesheet contains a hex, `rgb()` or `oklch()` value.

### Surfaces
| Token | Value | Use |
|---|---|---|
| `--tr-bg` | `#060a14` | window background |
| `--tr-panel` | `#0a1120` | top bar, status bar, side navigation, side panels |
| `--tr-surface` | `#0d1628` | cards, menus, tile headers |
| `--tr-surface-2` | `#0b1322` | the lower end of a card's gradient |
| `--tr-well` | `#080e1b` | rows, fields and code blocks inside a card |
| `--tr-term` | `#050912` | terminal, diff and chart wells |
| `--tr-hover` | `#14213b` | hover fill |
| `--tr-raised` | `#182a4a` | selected row, active item |
| `--tr-control-on` | `#1b3260` | pressed segment |

The window background carries one soft light from the top: `radial-gradient(1200px 480px at 50% -220px, rgba(46,110,255,.10), transparent 70%)` over `--tr-bg`. No grid.

### Lines
| Token | Value | Use |
|---|---|---|
| `--tr-line-faint` | `#131e36` | row dividers |
| `--tr-line` | `#1a2947` | card borders, dividers |
| `--tr-line-control` | `#344c7d` | control borders |
| `--tr-line-strong` | `#4a67a3` | overlay borders, hovered control |
| `--tr-tile-border` | `#1c2d4f` | channel tile frame |

### Text
| Token | Value | Use |
|---|---|---|
| `--tr-fg-strong` | `#f4f7ff` | titles, values |
| `--tr-fg` | `#dbe4f5` | body |
| `--tr-fg-muted` | `#b9c6de` | secondary body |
| `--tr-fg-dim` | `#94a5c4` | labels, descriptions |
| `--tr-fg-faint` | `#7f91b3` | hints, placeholders (4.5:1 on card and hover) |
| `--tr-fg-off` | `#3a4d73` | marks that are not text (idle trace, drag handle) |
| `--tr-on-light` | `#06101f` | text on a light or engine-coloured fill |
| `--tr-on-accent` | `#ffffff` | text on `--tr-accent-solid` |

### Accent and states
| Token | Value | Use |
|---|---|---|
| `--tr-accent` | `#4c9aff` | accent text, icons, active borders, focus ring |
| `--tr-accent-solid` | `#2a6fe8` | primary button fill (white text, 4.6:1) |
| `--tr-accent-solid-hover` | `#235fd0` | primary button hover |
| `--tr-accent-soft` | `rgba(76,154,255,.14)` | tinted fill (active tab, icon tile) |
| `--tr-accent-line` | `rgba(76,154,255,.45)` | tinted border |
| `--tr-success` | `#3ddc97` | finished, connected, passed |
| `--tr-warning` | `#f7b84b` | needs attention, near a limit |
| `--tr-danger` | `#ff6b6b` | failed, destructive |
| `--tr-st-waiting` | `#ff6ad5` | a channel needs the person |
| `--tr-st-limit` | `#ff9548` | context or budget at 80% or more |
| `--tr-ch-claude` | `#ffb547` | Claude |
| `--tr-ch-codex` | `#5fe1ff` | Codex |
| `--tr-ch-shell` | `#9fc3b8` | Terminal channels |
| `--tr-ch-planner` | `#c6f26b` | a hierarchy Round Table's planner |
| `--tr-you` | `#b9a7ff` | the person, in a Round Table |

State colours: idle `--tr-fg-dim`, starting `--tr-fg`, working = the engine colour, waiting `--tr-st-waiting`, finished `--tr-success`, failed `--tr-danger`, limit `--tr-st-limit`.

A tinted fill is always `color-mix(in srgb, <colour> 14%, transparent)` with a border of the same colour at 40%. Codex cyan is never used to mean "active"; that is the accent's job.

### Type
- **Interface:** Inter (`--tr-font-ui`), 400 / 500 / 600 / 700.
- **Titles:** Plus Jakarta Sans (`--tr-font-display`), 700 / 800. Page titles, card titles on the start screen, metrics.
- **Code:** IBM Plex Mono (`--tr-font-mono`). Terminals, diffs, paths, commands, IDs, key hints. Numbers in the interface use Inter with `font-variant-numeric: tabular-nums`, not mono.
- Chakra Petch and IBM Plex Sans Condensed are no longer used.

| Token | Value | Use |
|---|---|---|
| `--tr-t-display` | `800 32px/38px` display | start screen heading |
| `--tr-t-title` | `700 22px/28px` display | page title |
| `--tr-t-section` | `600 18px/24px` ui | dialog title, section title |
| `--tr-t-heading` | `600 15px/20px` ui | card title |
| `--tr-t-body` | `400 14px/20px` ui | body |
| `--tr-t-control` | `500 13px/16px` ui | controls, dense rows |
| `--tr-t-small` | `400 12px/16px` ui | hints, meta |
| `--tr-t-micro` | `600 11px/14px` ui | badges |
| `--tr-t-metric` | `700 28px/32px` display | a headline number |
| `--tr-t-term` | `400 13px/20px` mono | terminal |
| `--tr-t-meta` | `400 12px/16px` mono | paths, IDs |

Only these sizes exist: **11, 12, 13, 14, 15, 18, 22, 28, 32**. Titles of 22 px and larger take `letter-spacing: -0.01em`; nothing else is tracked.

### Space, shape, depth, motion
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 (`--tr-s-1` … `--tr-s-16`). Padding, gap and margin use only these. 2 and 6 are allowed inside controls 28 px tall or less.
- **Radii:** `--tr-r-small` 6 (controls 24 px tall or less, key hints), `--tr-r-control` 8, `--tr-r-inset` 8 (rows in a card), `--tr-r-tile` 10, `--tr-r-panel` 12 (cards), `--tr-r-overlay` 14, `--tr-r-chip` 999 (badges).
- **Card:** `background: linear-gradient(180deg, var(--tr-surface), var(--tr-surface-2))`, `1px solid var(--tr-line)`, `--tr-shadow-card: inset 0 1px 0 rgba(120,160,255,.06), 0 1px 2px rgba(0,0,0,.4)`.
- **Highlighted card or tile:** border `--tr-accent-line` and `--tr-glow-accent: 0 0 0 1px rgba(76,154,255,.12), 0 0 28px rgba(46,110,255,.14)`.
- **Overlay:** `--tr-shadow-overlay: 0 24px 64px rgba(0,0,0,.6), 0 0 0 1px rgba(76,154,255,.16)` over the scrim `--tr-scrim: rgba(3,6,14,.72)`. No blur (it is costly over terminals).
- **Focus:** `outline: 2px solid var(--tr-accent); outline-offset: 2px` on every control and tile.
- **Motion:** unchanged (80 / 160 / 240 / 400 ms, `--tr-ease`). Hover and focus changes take 160 ms. Reduced motion turns every transition off.
- **Layout:** top bar 44 px, status bar 28 px, tile header 34 px, page padding 24 px, grid gap 16 px, tile gap 8 px.
- **Higher contrast** (`:root[data-contrast="high"]`, Settings → Display) must keep working: it raises control and tile borders and the dimmest marks, as today.

---

## 3. Shared parts (`src/ui.css`)

Existing class names are kept where they exist; new parts take the `ui-` prefix.

| Part | Class | Form |
|---|---|---|
| Button | `.button.primary` | 32 px tall, padding 0 12, radius 8, 13/600. Solid `--tr-accent-solid`, white text. One per card or page region. |
| | `.button.secondary` | fill `--tr-hover`, border `--tr-line-control`, text `--tr-fg`. Hover: border `--tr-line-strong`, fill `--tr-raised`. |
| | `.quiet-button` | no fill or border, text `--tr-fg-dim`; hover fill `--tr-hover`, text `--tr-fg`. |
| | `.button.danger` | text and border `--tr-danger` on a 14% tint; solid red only for the confirming step. |
| | `.icon-button` | 28 × 28, radius 8, icon 16; hover fill `--tr-hover`. |
| | sizes | `.small` 24 px tall (radius 6, 12/600); `.large` 40 px. Icons are 16 px with an 8 px gap. Disabled: `opacity: .45`, no other change. |
| Page | `.ui-page` | padding 24 24 32. Reading and form pages are at most 1200 px wide, left-aligned; data pages add `.wide`. |
| Page heading | `.ui-page-head` | icon tile (36 px, radius 10, `--tr-accent-soft`, icon 18 in `--tr-accent`), `h1` in `--tr-t-title`, one line of description (13 px, `--tr-fg-dim`), actions at the right (`.ui-page-actions`). 20 px below it. |
| Card | `.ui-card` | the card surface, radius 12, padding 16. `.ui-card-head`: icon 16 in `--tr-accent`, `h2` in `--tr-t-heading`, an optional badge, actions at the right; 12 px below it. `.ui-card.accent` is the highlighted form. |
| Row | `.ui-row` in `.ui-list` | a well: `--tr-well`, border `--tr-line-faint`, radius 8, padding 8 12, at least 40 px tall, 8 px apart. Hover `--tr-hover`; selected `--tr-raised` with an accent left edge. |
| Badge | `.ui-badge` | 20 px tall pill, padding 0 8, 11/600, tinted fill and border. Variants: `.neutral`, `.accent`, `.success`, `.warning`, `.danger`, `.waiting`, `.claude`, `.codex`. A leading 6 px dot is `.dot`. |
| Count | `.ui-count` | a round count at the end of a row: at least 24 × 20, tinted like a badge, tabular numbers. |
| Avatar | `.ui-avatar` | an engine or person mark: rounded square (radius 8) tinted with its colour, glyph or icon inside. 20, 28 or 40 px. |
| Field | `.ui-field` | label above (12/500, `--tr-fg-dim`), control, optional `.ui-hint` below (12 px, `--tr-fg-faint`, one line). |
| Inputs | `input`, `select`, `textarea` | `--tr-well`, border `--tr-line-control`, radius 8, 32 px tall, padding 0 12, 13 px. Focus: border `--tr-accent` and a 3 px `--tr-accent-soft` ring. Selects draw their own chevron; text areas hide the browser's grip. |
| Checkbox, radio | `input[type=checkbox]`, `[type=radio]` | drawn, not native: 16 px, radius 4 (radio round), `--tr-well` and `--tr-line-control`; checked is `--tr-accent-solid` with a white mark. |
| Disclosure | `details > summary` | a 16 px chevron that turns; no browser triangle. |
| Segments | `.tr-seg` | a well with 2 px padding, radius 8; the chosen segment is `--tr-raised` with `--tr-fg-strong`. |
| Tabs | `[role=tablist]` | 32 px items; the chosen one has `--tr-accent-soft` fill, `--tr-accent-line` border, radius 8. |
| Stat | `.ui-stat` | label (12 px, dim), value (`--tr-t-metric`, tabular), sub-line (12 px). |
| Meter | `.ui-meter` | 6 px track (`--tr-well`), radius 999, fill in the state's colour. |
| Table | `.ui-table` | header 12/600 `--tr-fg-dim`, rows 40 px with a faint divider, hover `--tr-hover`; numbers right-aligned and tabular. |
| Empty state | `.ui-empty` | centred in its card: icon in a 44 px tinted circle, title 15/600, one line (13 px, dim), one action. Never a dashed box. |
| Banner | `.ui-banner` | an inline notice with an icon: `.info`, `.success`, `.warning`, `.danger`; tinted fill, radius 8, padding 8 12. |
| Key hint | `.ui-kbd` | mono 11, `--tr-well`, border `--tr-line-control`, radius 6, padding 0 6, 20 px tall. |
| Help | `.ui-help` | a 20 px `?` button whose `title` holds up to 200 characters. |
| Scrollbars | global | 10 px, thumb `--tr-line` (radius 999), `--tr-line-strong` on hover, no track. |

---

## 4. The frame

- **Top bar** (44 px, `--tr-panel`, bottom border `--tr-line`): the keycap and "Trace" (display 700, 15 px), the project switcher (a secondary button with a chevron), the tabs Workspace · Changes · Tasks · Projects, Insight, then at the right the layout segments, the command field, Help, Agent setup and **+ Channel** (the one primary button). The chosen tab is a pill: `--tr-accent-soft`, `--tr-accent-line`, `--tr-fg-strong`.
- **Status bar** (28 px, `--tr-panel`, top border): one item per channel (engine dot, `CH1`, state word in its colour), the project and branch, today's tokens and cost, plan limits, alerts, the host. Items are separated by 16 px, not by borders. Nothing is cut off at 1100 px: lower-priority items (saved state, host) leave first, then plan limits collapse to their worst value.
- **Menus and the command menu:** card surface, radius 14, overlay shadow; rows 36 px, radius 8, 4 px inside the menu's padding; the chosen row is `--tr-raised`.
- **Notices (toasts):** card surface, radius 12, a 3 px left edge in the state's colour, overlay shadow.
- **Dialogs and confirm steps:** card surface, radius 14, title in `--tr-t-section`, actions right-aligned with the primary last.

## 5. A channel tile

- A card with radius 10 and frame `--tr-tile-border`; the terminal well is `--tr-term`.
- **Header** (34 px, `--tr-surface`): drag handle, the engine avatar (20 px, in the engine's colour), `CH1`, the channel's name (13/600, takes the spare width and is the last thing to shorten), the model (12 px, dim), the account badge, the action for the state (Start, Answer, Retry …), the state badge.
- **State badge:** a `.ui-badge` with a dot, in plain words: Idle, Starting, Working, Needs you, Finished, Failed, Near limit.
- **Selected or focused:** border `--tr-accent-line` and `--tr-glow-accent`. **Needs you:** border and glow in `--tr-st-waiting`. **Failed:** border `--tr-danger`. No corner brackets, no reticle.
- **Detail row** (pointer on the header, or keyboard focus in it): small buttons (24 px) for Settings, Task, Duplicate, Maximize, Close; Stop is the danger form.
- **Footer** (24 px): the context meter, tokens, the output trace and rate, in 12 px with tabular numbers.
- **Before a channel starts:** the engine avatar (40 px), the engine's name (`--tr-t-section`), one line, the folder as a secondary button, a primary **Start**.

## 6. Pages

- **Heading:** every page starts with `.ui-page-head`. The same icon is used for the page in the menus.
- **Data pages** (Usage, Session history, Changes, Files, Tasks): cards on a 12-column grid, 16 px apart, filling the width.
- **Form pages** (Projects, Settings and the Agent setup areas): cards in one or two columns; a line of text is never longer than 72 characters.
- **Agent setup:** a 240 px list of areas at the left (icon, name, a status badge), the area's page at the right.
- **Empty:** the page keeps its columns and cards. Each empty card holds a `.ui-empty`; a page shows the action once.

## 7. Words

1. One sentence under a page title, 90 characters at most.
2. A card holds no paragraph of instructions. A field may have one line of hint. Anything longer goes behind `.ui-help`, a "How this works" disclosure that starts closed, or a link to its Help topic.
3. **Never drop a sentence that protects the person:** what is unencrypted, what leaves the computer, what cannot be undone, what needs administrator rights. Keep it as a `.ui-banner.warning` or a hint.
4. The same action has the same label and the same button form on every screen.
5. Plain sentences, sentence case, "Trace" and "channels" (`AGENTS.md`, rule 10).

## 8. Rules for whoever changes a screen

- Renderer only. No change to `electron/`, IPC or behaviour, apart from a defect this work names.
- Keep every accessible name, role and `aria-` attribute. Search `scripts/` and the `*.test.*` files for a class or label before changing it; if it must change, change the test with it and say so.
- No inline colours or sizes in TSX; no colour values outside `src/tokens.css`.
- Check the result by eye: `node scripts/design-tour.cjs <outDir> --dev --only=<words>` against a running `CODING_HUB_NO_HMR=1 npx vite --host 127.0.0.1`, at 1440 × 900 and at `--size=1100x800`.
