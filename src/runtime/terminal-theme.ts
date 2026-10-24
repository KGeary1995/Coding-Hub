import type { ITheme } from '@xterm/xterm';

/** Trace terminal colours (docs/design/trace), converted from OKLCH because xterm needs hex. */
export const TERMINAL_FONT = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
export const ENGINE_CURSOR = { claude: '#f1d35d', codex: '#5cd0ea' } as const;
export const TERMINAL_THEME: ITheme = {
  background: '#070a0a', foreground: '#d8e3df', cursor: '#d8e3df', cursorAccent: '#070a0a', selectionBackground: '#2a3835',
  black: '#131a19', red: '#f97770', green: '#79dd9f', yellow: '#ffa44e', blue: '#8fb4e8', magenta: '#e995e2', cyan: '#5cd0ea', white: '#d8e3df',
  brightBlack: '#6f807b', brightRed: '#f97770', brightGreen: '#79dd9f', brightYellow: '#ffa44e', brightBlue: '#8fb4e8', brightMagenta: '#e995e2', brightCyan: '#5cd0ea', brightWhite: '#eef4f1',
};
