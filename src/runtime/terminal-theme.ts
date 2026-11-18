import type { ITheme } from '@xterm/xterm';

/**
 * Trace terminal colours ("Midnight", docs/design/midnight/README.md). xterm takes literal values, not CSS variables, so
 * each one repeats a token of src/tokens.css, named beside it; terminal-theme.test.ts fails when the two drift apart.
 */
export const TERMINAL_FONT = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
/** The cursor is the engine's colour: --tr-ch-claude, --tr-ch-codex, --tr-ch-shell. */
export const ENGINE_CURSOR = { claude: '#ffb547', codex: '#5fe1ff', shell: '#9fc3b8' } as const;
export const TERMINAL_THEME: ITheme = {
  // --tr-term under --tr-fg; a selection is --tr-control-on.
  background: '#050912', foreground: '#dbe4f5', cursor: '#dbe4f5', cursorAccent: '#050912', selectionBackground: '#1b3260',
  // xterm draws its own scroll slider, coloured like the window's scrollbars: --tr-line, --tr-line-strong when pointed at,
  // and --tr-accent while dragged.
  scrollbarSliderBackground: '#22355c', scrollbarSliderHoverBackground: '#6584c8', scrollbarSliderActiveBackground: '#4c9aff',
  // --tr-surface, --tr-danger, --tr-success, --tr-warning, --tr-accent, --tr-st-waiting, --tr-ch-codex, --tr-fg.
  black: '#0d1628', red: '#ff6b6b', green: '#3ddc97', yellow: '#f7b84b', blue: '#4c9aff', magenta: '#ff6ad5', cyan: '#5fe1ff', white: '#dbe4f5',
  // --tr-fg-faint (dim text), --tr-del, --tr-add, then lighter tints of the four above with no token of their own, and --tr-fg-strong.
  brightBlack: '#8192b4', brightRed: '#ff8c8c', brightGreen: '#7fe89c', brightYellow: '#ffd27f', brightBlue: '#8dbdff', brightMagenta: '#ff9be3', brightCyan: '#9cecff', brightWhite: '#f4f7ff',
};
