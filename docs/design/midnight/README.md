# Midnight: the look of Trace (November 2026)

Midnight replaces Flight Deck Lite (`docs/design/trace/DECISIONS.md`). The owner asked for it on 2026-11-18 after comparing Trace with a dashboard that read as more finished: rounded cards on deep navy, clear layers, colour that carries meaning, short labels instead of paragraphs.

**What stays:** the structure (top bar, channels in tiles, status bar, the views and where they live), the state model, every behaviour, the amber keycap icon, the engine colours.

**What changes:** the palette, type, shape and depth; every screen is built from one set of shared parts; on-screen instructions shrink to labels, hints and tooltips.

**Refined on 2026-11-22**, after the owner found the channel tiles still read as bare terminals and the usage figures at the foot of the window as dated: a channel tile is now a card with the terminal as a well set into it (section 5), and the status bar draws what can be pressed as chips and each plan limit with a meter (section 4). A tile's footer shows what the channel used as marks, labels and values (section 5).

This file is the source of truth for the look. `src/tokens.css` holds the values. Where this file and the code differ, fix the code or change this file in the same commit.

---

## 1. Principles

1. **One part, drawn once.** A button, card, field, badge or empty state has one definition in `src/ui.css`. A screen never restyles a shared part; it composes them.
2. **Three layers of depth.** Background, card, well. A card sits on the background; rows, fields and terminals are wells inside a card. Each step is visibly different.
3. **Colour means something.** Blue is the interface's accent (active, primary, focus). Amber is Claude, cyan is Codex, periwinkle is Gemini CLI. Green, amber, red and magenta are states. Nothing else is coloured.
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
| `--tr-control-on` | `#1b3260` | a terminal's selection (`src/runtime/terminal-theme.ts`); no stylesheet reads it (a chosen segment is `--tr-raised`) |

The window background carries one soft light from the top: `radial-gradient(1200px 480px at 50% -220px, rgba(46,110,255,.10), transparent 70%)` over `--tr-bg`. No grid.

### Lines
| Token | Value | Use |
|---|---|---|
| `--tr-line-faint` | `#131e36` | row dividers |
| `--tr-line` | `#2c4474` | card borders, dividers, the scrollbar thumb (2.1:1 on the window) |
| `--tr-line-control` | `#4e6ba9` | control borders (3:1 against every surface up to `--tr-hover`) |
| `--tr-line-strong` | `#6584c8` | overlay borders, hovered control (3:1 against `--tr-raised`) |
| `--tr-tile-border` | `#314c80` | channel tile frame and the dividers inside a tile (2.3:1 on the window) |

Corrected on 2026-11-18, when the contrast of every token was measured: `--tr-line-control` was `#344c7d`, which is 2.1:1 on a card and 2.3:1 on a well, below the 3:1 a control's outline needs. `--tr-line-strong` was `#4a67a3`, which the new control line nearly equals, so it moved up to stay the visibly stronger of the two.

Raised later the same day, toward the reference's card edges (about 1.8:1 to 3:1 against a card's inside): `--tr-line` was `#22355c` (1.6:1 on the window) and `--tr-tile-border` `#263b66` (1.8:1). The hue is the same. The order holds, each measured on `--tr-bg`: `--tr-line-faint` 1.2 < `--tr-line` 2.1 < `--tr-tile-border` 2.3 < `--tr-line-control` 3.8 < `--tr-line-strong` 5.4. A divider between the rows of a list or a table stays `--tr-line-faint`.

### Text
| Token | Value | Use |
|---|---|---|
| `--tr-fg-strong` | `#f4f7ff` | titles, values |
| `--tr-fg` | `#dbe4f5` | body |
| `--tr-fg-muted` | `#b9c6de` | secondary body |
| `--tr-fg-dim` | `#94a5c4` | labels, descriptions |
| `--tr-fg-faint` | `#8192b4` | hints, placeholders (4.5:1 on card, hover and a selected row; was `#7f91b3`, 4.49:1 on `--tr-raised`) |
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
| `--tr-ch-gemini` | `#8c9cff` | Gemini CLI: its channels, its seat at a Round Table (`.seat-gemini`, `.table-gemini`, `.seat-text-gemini`), its share of Usage's bars and its badge (`.ui-badge.gemini`) |
| `--tr-ch-shell` | `#9fc3b8` | Terminal channels |
| `--tr-ch-planner` | `#c6f26b` | a hierarchy Round Table's planner |
| `--tr-you` | `#b9a7ff` | the person, in a Round Table |

State colours: idle `--tr-fg-dim`, starting `--tr-fg`, working = the engine colour, waiting `--tr-st-waiting`, finished `--tr-success`, failed `--tr-danger`, limit `--tr-st-limit`.

A tinted fill is always `color-mix(in srgb, <colour> 14%, transparent)` with a border of the same colour at 40%. Codex cyan is never used to mean "active"; that is the accent's job.

On these navy surfaces the accent's tint says little by itself: `--tr-accent-soft` on the top bar is `#13243f`, all but `--tr-hover` (`#14213b`, a secondary button's fill), and `--tr-accent-line` over it is 2.7:1 (2.2:1 as a tile's frame), dimmer than a control's border and than a tile's own frame. So what must read as chosen beside buttons or frames takes the solid `--tr-accent`: a chosen tab's border and words, a selected tile's frame.

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
- **Spacing:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 (`--tr-s-1` … `--tr-s-16`). Padding, gap and margin use only these. 2 and 6 are allowed inside controls 28 px tall or less; 6 is also the card's edge around a tile's well (`--tr-tile-inset`), and the space between two chips in the status bar.
- **Radii:** `--tr-r-small` 6 (controls 24 px tall or less, key hints), `--tr-r-control` 8, `--tr-r-inset` 8 (rows in a card), `--tr-r-tile` 12 (a channel tile, a page's icon tile, a 40 px avatar; a tile's well and the strips beside it are `--tr-r-small`, the tile's radius less `--tr-tile-inset`), `--tr-r-panel` 12 (cards), `--tr-r-overlay` 14, `--tr-r-chip` 999 (badges).
- **Card:** `background: linear-gradient(180deg, var(--tr-surface), var(--tr-surface-2))`, `1px solid var(--tr-line)`, `--tr-shadow-card: inset 0 1px 0 rgba(120,160,255,.06), 0 1px 2px rgba(0,0,0,.4)`.
- **A tile's well:** `--tr-term`, a 1 px frame in `--tr-line-faint` (`--tr-tile-border` with Higher contrast) and `--tr-shadow-well: inset 0 1px 3px rgba(0,0,0,.5)`, so it sits under the card.
- **Selected tile:** border `--tr-accent` and `--tr-glow-accent: 0 0 0 1px rgba(76,154,255,.12), 0 0 28px rgba(46,110,255,.14)`.
- **Overlay:** `--tr-shadow-overlay: 0 24px 64px rgba(0,0,0,.6), 0 0 0 1px rgba(76,154,255,.16)` over the scrim `--tr-scrim: rgba(3,6,14,.72)`. No blur (it is costly over terminals).
- **Focus:** `outline: 2px solid var(--tr-accent); outline-offset: 2px` on every control. A channel tile draws the same ring on its own edge (`outline-offset: -2px`): 2 px outside it, the grid's scroll box cut the ring off on the tile's outer sides.
- **Motion:** unchanged (80 / 160 / 240 / 400 ms, `--tr-ease`). Hover and focus changes take 160 ms. Reduced motion turns every transition off.
- **Layout:** top bar 44 px, status bar 28 px (it stays 28: at 32 px a four-tile grid no longer fitted a 1100 × 800 window at 125%, which `scripts/design-smoke.cjs` checks), tile header 36 px, a tile's detail row 30 px, a tile's footer 28 px (`--tr-tile-foot-h`), the card's edge around a tile's well 6 px (`--tr-tile-inset`), page padding 24 px, grid gap 16 px, tile gap 8 px.
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
| | `.tr-detail-button` | the 24 px quiet button with a 14 px icon and a 12/500 label, radius 6: a tile's controls row, a linked computer's bar, a conversation's bar. Pressed or selected is `--tr-raised`; `.stop` is the danger form; `.icon` is 24 × 24. A button whose icon is `.tr-detail-icon` keeps only that icon (its label stays its accessible name) in a box of 560 px or less, and in a tile's detail row or header of 680 px or less. |
| Page | `.ui-page` | 24 px above, 32 below; the 24 px at each side come from `.main-shell`, which holds every page. Reading and form pages are at most 1200 px wide, left-aligned; data pages add `.wide`. |
| Page heading | `.ui-page-head` | icon tile (36 px, radius 12, `--tr-accent-soft`, icon 18 in `--tr-accent`), `h1` in `--tr-t-title`, one line of description (13 px, `--tr-fg-dim`), actions at the right (`.ui-page-actions`). 20 px below it. |
| Section title | `.ui-section-title` | a plain heading over a group of cards on a long form page (Settings), in `--tr-t-section`. It takes the focus when "On this page" jumps to it and shows the ring only to the keyboard. |
| Card | `.ui-card` | the card surface, radius 12, padding 16. `.ui-card-head`: icon 16 in `--tr-accent`, the title in `--tr-t-heading`, an optional badge, actions at the right; 12 px below it. The title is an `h2`, or an `h3` on a page with section titles (Settings), with the same look; a heading inside such a card is one level lower (`h4`). |
| Caption | `.ui-caption` | one small dim line (12 px, `--tr-fg-dim`) beside a card's title or after a value: what the card counts, where its numbers come from, when a limit resets. It shortens with an ellipsis. |
| Row | `.ui-row` in `.ui-list` | a well: `--tr-well`, border `--tr-line-faint`, radius 8, padding 8 12, at least 40 px tall, 8 px apart. Hover `--tr-hover`; selected `--tr-raised` with an accent left edge. |
| Badge | `.ui-badge` | 20 px tall pill, padding 0 8, 11/600, tinted fill and border. Variants: `.neutral`, `.accent`, `.success`, `.warning`, `.danger`, `.waiting`, `.limit`, `.claude`, `.codex`, `.gemini`, `.shell`, `.planner`, `.you`. A leading 6 px dot is `.dot`. |
| Count | `.ui-count` | a round count at the end of a row: at least 24 × 20, tinted like a badge, tabular numbers. |
| Avatar | `.ui-avatar` | an engine or person mark: rounded square (radius 8) tinted with its colour, glyph or icon inside. 20, 28 or 40 px. |
| Field | `.ui-field` | label above (12/500, `--tr-fg-dim`), control, optional `.ui-hint` below (12 px, `--tr-fg-faint`, one line). |
| Inputs | `input`, `select`, `textarea` | `--tr-well`, border `--tr-line-control`, radius 8, 32 px tall, padding 0 12, 13 px. Focus: border `--tr-accent` and a 3 px `--tr-accent-soft` ring. Selects draw their own chevron; text areas hide the browser's grip. |
| Checkbox, radio | `input[type=checkbox]`, `[type=radio]` | drawn, not native: 16 px, radius 4 (radio round), `--tr-well` and `--tr-line-control`; checked is `--tr-accent-solid` with a white mark. |
| Disclosure | `details > summary` | a 16 px chevron that turns; no browser triangle. |
| Segments | `.tr-seg` | a well with 2 px padding, radius 8; the chosen segment is `--tr-raised` with `--tr-fg-strong`. |
| Tabs | `[role=tablist]` | 32 px items, radius 8; the chosen one has `--tr-accent-soft` fill and `--tr-accent` border and words (section 2 says why not the tint's own line and strong words). |
| Stat | `.ui-stat` | label (12 px, dim), value (`--tr-t-metric`, tabular), sub-line (12 px). |
| Meter | `.ui-meter` | 6 px track in `--tr-raised` (it shows on a card, a well and the bars alike; as a well with a faint line it was all but invisible on a card), radius 999, fill in the state's colour. 4 px tall in a tile's footer (56 px wide) and in the status bar (24 px wide). |
| Table | `.ui-table` | header 12/600 `--tr-fg-dim`, rows 40 px with a faint divider, hover `--tr-hover`; numbers right-aligned and tabular. |
| Empty state | `.ui-empty` | centred in its card: icon in a 44 px tinted circle, title 15/600 (the heading one level under its card's title, or a `strong`), one line (13 px, dim), one action. Never a dashed box. `.ui-empty.danger` reports a failure: the circle takes the danger tint and the icon is `CircleAlert`, the line is body colour. |
| Banner | `.ui-banner` | an inline notice with an icon: `.info`, `.success`, `.warning`, `.danger`; tinted fill, radius 8, padding 8 12. One icon per tone, from `lucide-react`: info `Info`, success `CircleCheck`, warning `TriangleAlert`, danger `CircleAlert` (use these names; `AlertTriangle`, `AlertCircle` and `CheckCircle2` are the old names). The words go in a `span` after the icon. |
| Key hint | `kbd` | the element itself, with no class: mono 11, `--tr-well`, border `--tr-line-control`, radius 6, padding 0 6, 20 px tall. |
| Help | `.ui-help` | a 20 px `?` button whose `title` holds up to 200 characters. |
| Help line | `.ui-help-line` | a hint or a sub-heading that ends in the help button: the two on one line, 8 px apart, the button level with the words. |
| How this works | `details.ui-how` | a closed disclosure (summary 12 px, dim) holding what would otherwise be a paragraph of instructions in a card; 12 px above it. |
| Scrollbars | global | 10 px, thumb `--tr-line` (radius 999, drawn 6 px wide), `--tr-line-strong` on hover, no track. A raised stack of notices that is cut short draws its own 8 px wide (the same thumb), in the 12 px beside the notices (section 4). |

---

## 4. The frame

- **Top bar** (44 px, `--tr-panel`, bottom border `--tr-line`): the keycap and "Trace" (display 700, 15 px), the project switcher (a secondary button with a folder mark and a chevron), the tabs Workspace · Changes · Tasks · Projects, Insight, then at the right the layout segments, the command field, Help, Agent setup and **+ Channel** (the one primary button). The chosen tab is the shared tab's pill: `--tr-accent-soft` fill, `--tr-accent` border and words, so it reads as chosen beside the project switcher, whose fill is nearly the same. Insight and Agent setup take the same form while one of their views is shown. With Higher contrast every tab's words are `--tr-fg-strong`, and the chosen one keeps its accent border.
- **Status bar** (28 px, `--tr-panel`, top border): one item per channel (engine dot, `CH1`, state word in its colour) and the project at the left; at the right the saved state, today's tokens and cost, plan limits, Needs you and alerts. Two forms, by what an item does. What can be pressed is a **chip** (a channel, today's total, a plan's limits, Needs you, an alert): 20 px tall, radius 6, `--tr-surface` with a faint frame, 6 px from the next chip; a chip that asks for the person (a channel that waits, failed or is near its limit, Needs you, an alert) takes its state's tint, fill 14% and frame 40%. What only informs is a 12 px mark and its words with no frame: the project (`Folder`), the saved state (`Check` in `--tr-success` and "Saved", a spinner while saving or loading, `CircleAlert` and the whole sentence for a failure; the sentence is its tooltip throughout). Today's total is a chip that opens Usage, as the plan limits beside it do: `Coins`, "Today", the tokens in `--tr-fg` 600, the cost; from the warning share of a daily budget it takes the limit colour's tint, and the danger colour's once the budget is used up. It is still the last thing to leave a short bar, whole: the chip is drawn inside the box that leaves (`tr-sb-drop`), its focus ring inside its own edge since that box clips, and while it is out of the bar it is out of the tab order and of what is read out (`todayGone` in `src/components/shell/StatusBar.tsx`). A plan's chip holds the engine's mark (the 12 px icon its tiles carry, in its colour) and name and each limit as its short name, a 24 × 4 px meter and its percentage; the meter is the engine's colour, `--tr-st-limit` from 75% and `--tr-danger` from 90%, as its number turns. The chip counts the default login; a named account that a channel here runs on is added to it, by name with its fullest limit in that limit's colour, once it is at 75% or more (`accountWarnings` in `src/components/shell/StatusBar.tsx`), so no account in use reaches its cap unseen. When the last check failed, the readings are an earlier check's: the numbers dim, the meters fade and a `TriangleAlert` in `--tr-warning` ends the chip; the tooltip says so first and gives each reading's time. Items are 16 px apart. There is no host item (Trace's host is always this computer; a browser preview says so where the saved state stands) and no standing "No alerts": with nothing to report the bar says nothing. Nothing is cut off at 1100 px. What gives way, in order: the plan limits' meters, the saved state, each channel's tokens, the lesser plan limit (plan limits collapse to their fullest limit, which keeps its short name, as in "wk 29%": a bare percentage did not say which limit it was; the engine is the chip's mark, a shape as well as a colour, and its name the tooltip's first words), the project, the state words (their glyphs stay), then today's total, and last of all (`--sb-tight`: eight channels in the narrowest window with Needs you, an alert and a storage failure at once) each channel's "CH" and half its chip's padding, the alert's words down to 40 px, and a storage failure's words, whose mark stays. A storage failure never leaves the bar, and Needs you and the alert are always in view (`scripts/design-smoke.cjs` checks this with eight channels at 900 × 700 and at 1100 × 800 / 125%); the items that leave sit beside the gap, so none shows where one was. The branch is not shown: no renderer state holds it, and section 8 keeps this work in the renderer. An engine's plan-limits item shows only what there is to show: an engine with no limit and no error in any account's reading has no item; one whose reading holds only an error (a check that failed, or a fact such as an account billed by API usage) reads "no data", and its tooltip says why.
- **Menus and the command menu:** card surface, radius 14, overlay shadow; rows 36 px, radius 8, 4 px inside the menu's padding; the chosen row is `--tr-raised`.
- **Notices (toasts):** card surface, radius 12, a 3 px left edge in the state's colour, overlay shadow. They stand at the bottom right, 12 px above the status bar. A channel's notice (it needs the person, or has failed) is drawn only while that channel's tile is not on screen, because on screen the tile says the same with its badge, its Answer or Retry button and its request or error strip. A tile is off screen when another page or another computer's tab is shown, when another channel is maximised over it, or when it is scrolled out of its grid's view: its top edge, its header row or its request or error strip is cut by the grid's edge by more than one pixel. The notice leaves when the tile comes on screen, and comes back when it goes off screen again while the channel still waits or is failed, unless the person dismissed it (a dismissal lasts until the channel moves on). The status bar's alert and the Needs you count show throughout, and what a restart or loading changed is always drawn. Only this computer's channels raise a notice; a Round Table's hidden partner follows its lead's tile, where its request is the approval card in the conversation and its failure the table bar's line. **Answer** on a notice, the status bar's alert, the Needs you list and Alt+1–8 show the workspace and scroll its grid to the tile (`jumpToChannel` in `src/components/shell/StatusBar.tsx`). A notice tells a screen reader of a request or failure only where no tile is drawn for it (another page, behind a maximised channel) and only the first time it is drawn; where the tile is drawn its strip is the alert, so a notice over a scrolled-out tile, and one that comes back, is silent (`tileShows` and `noticeSpeaks` in `src/components/shell/Toasts.tsx`). A notice never lies over a chat's message row (the message box, its level picker, Send, attachments and the error line), whoever has the focus, nor over a tile the keyboard focus is in (a terminal's prompt): when its place at the bottom would, the notices take a raised place at the top right instead, starting under the header and detail rows of the first row of tiles on that side and, where one of those is a conversation, under its bars, so Restore, Stop both, Approve plan and Close stay in reach. A raised stack that would reach the next message row down, or a chat that starts under it, ends above it (12 px above a message row, 6 px above the chat) and scrolls in itself, by wheel, by keyboard and by its scrollbar, which stands in the 12 px beside the notices (8 px wide after 4 px of padding), so the notices are as wide and stand where they do in a stack that is not cut short. With less than 72 px of room (a long message in a short chat) the notices step aside until there is room; the status bar still shows who needs the person. The place, and with it whether each channel's tile is on screen, is measured again on focus changes, window and tile resizes, workspace changes and when a grid of tiles scrolls (`noticePlace` in `src/components/shell/Toasts.tsx`).
- **Dialogs and confirm steps:** card surface, radius 14, title in `--tr-t-section`, actions right-aligned with the primary last.

## 5. A channel tile

- A card: the card's fill (`--tr-card`), radius 12 and frame `--tr-tile-border`. Its header, its footer and the strips under either are drawn on the card itself, with no lines between them. Only the terminal, or a chat channel's conversation, is the well: `--tr-term`, 6 px in from the card's sides (`--tr-tile-inset`), radius 6, with a faint frame of its own (section 2). So a channel reads as a window of the app that holds a terminal, not as a bare terminal pane. A linked computer's tile, which has no footer, ends its well 6 px above the card's lower edge.
- **In the grid arrangement** the tiles keep two rows, and a second row with fewer channels than the first shares the whole width: three channels are two above and one wide below, five are three above and two halves below, seven are four above and three thirds below (`arrangeChannels` in `shared/workspace-migration.ts`). Columns and rows give every tile one width. Trace arranges the tiles when the person picks an arrangement and when a channel is added or closed; a tile the person dragged or resized stays as they left it until then. A saved layout opens as saved, with one exception: the first time a workspace is opened under this rule, a grid that still stands exactly as the older rule arranged it (the short row at the upper row's width, no tile moved or resized) is laid out by it, once (`widenShortRow`). A linked computer's tab puts new channels two to a row, and a last one alone in its row takes the whole width.
- **Header** (36 px, on the card, with no line under it): drag handle, the engine avatar (20 px, in the engine's colour), `CH1`, the channel's name (13/600, takes the spare width and is the last thing to shorten), what it is working on (12 px, dim; the first thing to shorten), the model (12 px, dim), the account badge, the action for the state, the state badge. The action is a small button (24 px): Start tinted with the engine's colour, Answer in the solid waiting colour, Retry in the primary form, Write handoff tinted with the limit colour, Open log and Review changes in the secondary form.
- **State badge:** a `.ui-badge` with a dot, in plain words: Idle, Starting, Working, Needs you, Finished, Failed, Near limit. In a tile of 260 px or less (eight channels in four columns on the narrowest window) it keeps only its dot; the word stays its text for a screen reader.
- **Controls button** (`.tr-tile-more`, before the state badge): a 24 px icon button (`Ellipsis`) that opens and closes the controls row, with `aria-expanded`; it reads as pressed while the row is open. It is drawn at every width.
- **Selected or focused:** border `--tr-accent` and `--tr-glow-accent`. **Needs you:** border and glow in `--tr-st-waiting`. **Failed:** border `--tr-danger`. Each frame is the solid colour; the accent's tinted line would be dimmer than a tile's own frame. No corner brackets, no reticle.
- **Controls row** (30 px, `.tr-tile-detail`): the channel's facts, then `.tr-detail-button`s: Interrupt (icon only, while running), Stop (the danger form) or Restart, Conversation (a Claude Code or Codex terminal with a saved conversation), Settings, Task, Duplicate, Maximize (Restore while maximised), Close. It is a toolbar on the card, in the flow under the header: a `--tr-well` row of the well's width with radius 6, 4 px over what follows. It is closed until the header's controls button opens it, and stands open while what it opened is in use: the channel's settings, a conversation, the question Close asks. It is never laid over the terminal. Until 2026-11-22 it floated over the terminal's first lines for as long as the header was pointed at, with a cover that masked the line it cut (`--term-cover`); it hid output, and nothing on the tile said it was there. Opening it now takes its 34 px from the terminal once, when the person asks. The facts are plain words, each after the first behind " · ": what the channel is doing ("Running", "Checking the CLI…", "Ended normally", "Ended with exit code 1", "Ready to start"), "Folder …", "Cost …" and "Context … of …"; the process ID and the folder's whole path are the facts' tooltip. A fact with no room leaves whole, the last one first; nothing is cut mid-word. On a tile of 680 px or less the buttons keep only their icons. A waiting terminal channel's request strip still lies over the top of the terminal (so the CLI is not resized as each request comes and goes) and ends where a terminal line ends: it reads `--term-cover` (`src/tile.css`), which rounds up by one terminal line's height, measured by `useTerminalRow` (`src/components/tile/terminal-row.ts`) since it follows the terminal font size. A channel that needs the person while its conversation is open keeps what it asks in view as a strip of the row's height at the top of the well, and the conversation starts under it.
- **Error strip** (under the header and the controls row, a channel whose launch failed or whose CLI exited with an error): a strip of the well's width, framed and rounded as a banner is (radius 6, 4 px over the well), in the danger tint with `CircleAlert` and the message, its blank lines left out; three lines at most, and it never scrolls. An error of up to three lines is shown whole; of a longer one (an exit diagnostic holds up to 2,000 characters of the CLI's last output), the first line, then the two most recent output lines that read as an error (`errorLines` in `src/components/tile/error-strip.ts`), or the last two when none does: the last lines are not reliably the cause. An output line too wide ends in an ellipsis and its title holds it whole; a one-line error wraps to three lines. When anything is left out or cut, a quiet **Show all** button with a chevron that turns (**Show less** when open, `aria-expanded`, named with the channel's number) opens the whole text, up to 40% of the tile; only then do its words scroll, and the buttons stand under them so **Show less** stays in view. Closed, in a narrow tile, the buttons take a row of their own under the words. It ends in a quiet button to a setup page only when the error names one (`setupTarget` in `src/components/tile/error-strip.ts`): **Choose project** for a missing folder, **Apply shared rules** for the launch check of the rules, **Account setup** for a sign-in problem. A folder or rules problem is read only from Trace's own launch errors; what follows "CLI exited with code …" is the CLI's last output, in which only a sign-in problem is looked for. A plain exit code has no such button: Retry and Open log are in the header. In a tile of 400 px or less the header's Open log gives way, and the strip carries it as its last quiet button.
- **Footer** (28 px, on the card): in 12 px with tabular numbers. At the left what the channel used, each a 12 px mark, a label and a value in `--tr-fg` 600: its context (`Gauge`, "Context", a 56 × 4 px meter in the engine's colour and its share; the channel's budget where the CLI reports no window; and where it reports only an amount, as Claude Code does, the amount with no meter, since an empty track read as 0%) and its tokens today (`Coins`, the count, "tok today"). A Gemini CLI channel has the tokens and no context (it reports no window); until its first request is read the count is "—", and 0 is a counted zero, as in a Round Table's bar. The meter's label names what it measures: "Context", or "Budget" when it falls back to the channel's budget. At the right the output trace, a fixed 96 × 14 px, and its rate in `--tr-fg-faint`, which keeps its width so the trace does not move; neither is drawn for a channel that is not running, and a chat channel has neither (it has no terminal output, so the trace read "0 chars/s" through every reply). The task, live coaching and pasted images follow as strips on the card, each under a `--tr-line-faint` line.
- **Before a channel starts:** the engine avatar (40 px), the engine's name (`--tr-t-section`), one line, the folder as a secondary button, a primary **Start**. They stand on `--tr-surface-2` inside the well's frame, not on the terminal's colour: a channel is not a terminal until it runs, and the well turns dark when it does.
- **A chat tile:** a conversation is read, not a terminal: it stands on `--tr-surface-2` inside the well's frame (as a channel that has not started does), and `--tr-term` is kept for real terminals, diffs and charts. A reply being written ends in a 6 px accent dot that pulses, not a block cursor. The message box's hint has shorter forms; the longest that fits the box's width is shown (`useHint`), so a hint shortens to a form that fits instead of being cut. In a tile of 420 px or less the message box and Send take a row of their own under the other buttons.
- **A Round Table's bar** takes two lines, not three, in a four-tile grid on a small window. In a tile of 560 px or less the token counts leave it (a hierarchy seat's tokens too) and Swap keeps only its icon; at 460 px or less who drives leaves as well. While the driver makes the changes after a discussion (from 1.29) the status reads "Claude Code making the changes": at 560 px or less the driver's name leaves it too ("Making the changes"), or the bar took a third line in a four-tile grid at 1100 × 800. What leaves stays in the first group's or the seat's tooltip and is still read out; Swap's name stays "Swap". At 400 px or less Rounds, Stop both and Show keep only their field or icon (a hierarchy bar's Stop too; Show's icon stands only there, where its words have left), and at 300 px or less the title leaves as well (the dots stay), so the bar takes two lines in four columns, idle and busy; their words stay their accessible names, and each has a tooltip, as every control that shows only an icon has. A hierarchy bar that would leave its conversation less than half the tile folds to one line (`foldChainBar` in `src/components/chat/ChatParts.tsx`): the dots, what is running and who sits at each level, the step's buttons (Reopen, Approve plan, Continue, Continue without the challenge, Stop) and Close, and a chevron named "Round Table steps and controls" that opens the whole bar under that line. A message that waits to go stays in view on a line of its own under the folded line, with its **Send now** and **Drop it** (`span.table-waiting` in `src/styles/chat.css`). The bar unfolds by itself when the tile has room, and never folds on the phone.

## 6. Pages

- **Heading:** every page starts with `.ui-page-head`. The same icon is used for the page in the menus.
- **Data pages** (Usage, Session history, Changes, Files, Tasks): cards on a 12-column grid, 16 px apart, filling the width.
- **Form pages** (Projects, Settings and the Agent setup areas): cards in one or two columns; a line of text is never longer than 72 characters.
- **Agent setup:** a 240 px list of areas at the left (icon, name; where the area's state is known, a status dot on the icon whose words are the row's tooltip and are read out after its name), every row one height; the area's page at the right.
- **Empty:** the page keeps its columns and cards. Each empty card holds a `.ui-empty`; a page shows the action once.
- **Changes, the delivery card:** a card holding a vertical stepper (numbered 24 px circles joined by a line; a finished step's circle is green with a tick). The head, an error banner, the last step's output and the closing note ("Each step shows a native confirmation first. No force push or discard.") stay put; only the steps scroll, between a faint line above and below them, so a half-shown step reads as scrolled, not cut off. When the folder is not a Git repository the card is not shown and the review card, which then reads "Git review unavailable", takes the whole width; **Refresh changes** checks again, and a folder that has become a repository gets the card back.
- **Usage, plan limits:** a check that failed (the CLI did not answer or could not be started, or reported limits in a form Trace does not read) is a `.ui-banner.danger` with `CircleAlert`; a fact about the account (billed by API usage, no limits to show) is a `.ui-banner.info` with `Info`. The host marks which is which with `PlanLimits.failed` (`shared/plan-limits.ts`); a reading without it is a fact. The phone app shows the same two as one line under the engine's name: a failed check in `--tr-danger` (`.limit-failed`), a fact dim.
- **The phone app** (`phone/phone.css`) does not load `src/ui.css`: it redraws the shared parts at touch size from the same tokens. Buttons and fields are at least 44 px tall (a 36 px button in a Round Table bar reaches 44 with an invisible margin above and below), a key under a terminal or a shared screen is at least 44 px wide as well (the keys stand in rows short enough for a 320 px phone), the side gutters are 16 px inside the safe-area insets, and field text is 16 px, as is the chat's message box: below 16 px, iPhone Safari zooms the page into a field when it is tapped. A terminal channel opens at the phone's size with its text at the chosen size; the button beside A− / A+ then reads **Desktop size**, and **Fit to phone** while the channel is at the desktop's size (its text shrunk to fit, never below 6 px). The phone remembers Desktop size for the next channel (`phone/size.ts`).

## 7. Words

1. One sentence under a page title, 90 characters at most.
2. A card holds no paragraph of instructions. A field may have one line of hint. Anything longer goes behind `.ui-help`, a "How this works" disclosure that starts closed, or a link to its Help topic.
3. **Never drop a sentence that protects the person:** what is unencrypted, what leaves the computer, what cannot be undone, what needs administrator rights, what a check does not prove, a limit. Keep it as a `.ui-banner.warning` or a hint.
4. The same action has the same label and the same button form on every screen. The button that opens the native folder picker is **Choose folder** everywhere; where two pickers share a card, each `aria-label` names its field ("Choose parent folder"). The action that opens a linked computer's screen is **Screen**, on its tab and on the phone.
5. Plain sentences, sentence case, "Trace" and "channels" (`AGENTS.md`, rule 10).
6. **Channel, not session.** In visible text and accessible names, the thing in a tile is a channel. "Session" stays only where it names something else: the page Session history and a saved record of a past run in it ("Session output"); the count and table of CLI sessions on Usage; a CLI's or provider's own session (`--session-id`, the session token limit, "Allow for this session", a plan's session and weekly limits, session-summary notes in shared memory); and every identifier in code (`AGENTS.md`, rule 5).
7. **Folder, not directory.** A place on disk is a folder ("Working folder", "Current folder", "Loading folder…", "the channel's own folder"). "Directory" stays only where the text quotes a command, a flag, an environment variable or a CLI's own output.
8. A badge that says something is being checked reads **Checking**, with no ellipsis. Running text beside a spinner keeps it ("Checking sync…").

## 8. Rules for whoever changes a screen

- Renderer only. No change to `electron/`, IPC or behaviour, apart from a defect this work names.
- Keep every accessible name, role and `aria-` attribute. Search `scripts/` and the `*.test.*` files for a class or label before changing it; if it must change, change the test with it and say so.
- No inline colours or sizes in TSX; no colour values outside `src/tokens.css`. The one accepted exception is the phone-pairing QR code in `src/components/PhoneAccess.tsx`, drawn with a literal `#fff` and `#000`: a QR code must be black on white to scan, whatever the theme. Places that cannot read a CSS variable repeat a token's value, and must change with it: the terminal theme (`src/runtime/terminal-theme.ts`, which `terminal-theme.test.ts` checks against `src/tokens.css`), the window's first-paint background in `electron/main.ts` and the `theme-color` of `index.html` (`--tr-bg`), the `theme-color` of `phone/index.html` (`--tr-panel`), and the `background_color` and `theme_color` of `phone/public/manifest.webmanifest` (`--tr-bg` and `--tr-panel`). `docs/design/trace/tokens.css` is the replaced design's file, kept as history: it is not loaded and the colour rule does not apply to it.
- A `lucide-react` icon's numeric `size` prop is allowed: it is how the code has always sized an icon (about 150 uses), and it is neither a colour nor a font size. In a shared part the part's rule draws the icon whatever the prop says (16 px in a button, a card's head, a banner and a tab; 14 in a detail button; 12 in a tile's action; 18 in a page's icon tile; 20 inside an empty state's 44 px circle); elsewhere the prop is the size. The values in use are 11, 12, 13, 14, 15, 16, 18 and 20, and 34 or 36 on an empty state's icon, which its circle redraws. A new icon takes 16, or its part's size.
- Some spacing values are layout arithmetic, not chosen gaps, and are exempt from the scale: the bottom padding that keeps the phone app's pages clear of its tab bar (`#app:has(> .tabbar)` in `phone/phone.css`, the bar's height plus the safe-area inset); the three margins by which a status-bar part's gap closes with it (`.tr-sb-plan-name`, `.tr-sb-tokens` and `.tr-sb-meter` in `src/shell.css`, a `calc()` that is 0 or -6 px, or -4 for the meter); and the -10 px by which two chips side by side stand 6 px apart in the status bar's 16 px gap.
- Font sizes are only those of section 2. The phone app's field text is 16 px (section 6), the one size outside that list.
- Check the result by eye: `node scripts/design-tour.cjs <outDir> --dev --only=<words>` against a running `CODING_HUB_NO_HMR=1 npx vite --host 127.0.0.1`, at 1440 × 900 and at `--size=1100x800`.
