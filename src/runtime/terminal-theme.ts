import type { ITheme } from '@xterm/xterm';

/** Trace terminal colours (docs/design/trace, Flight Deck Lite), as hex because xterm needs it. */
export const TERMINAL_FONT = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
export const ENGINE_CURSOR = { claude: '#ffb547', codex: '#5fe1ff', shell: '#a9c6bd' } as const;
export const TERMINAL_THEME: ITheme = {
  background: '#080b0e', foreground: '#dce7ee', cursor: '#dce7ee', cursorAccent: '#080b0e', selectionBackground: '#1d3340',
  // xterm draws its own scroll slider; a slate one, not its default grey block.
  scrollbarSliderBackground: 'rgba(61,98,116,.35)', scrollbarSliderHoverBackground: 'rgba(61,98,116,.6)', scrollbarSliderActiveBackground: 'rgba(95,225,255,.45)',
  black: '#0d151b', red: '#ff6b6b', green: '#7fe89c', yellow: '#ffb547', blue: '#7fb2ff', magenta: '#ff8fdd', cyan: '#5fe1ff', white: '#dce7ee',
  brightBlack: '#8aa0ad', brightRed: '#ff8c8c', brightGreen: '#9ff0b5', brightYellow: '#ffc876', brightBlue: '#a3c8ff', brightMagenta: '#ffb0e8', brightCyan: '#9cecff', brightWhite: '#f0f6fa',
};
