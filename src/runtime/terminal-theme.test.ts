import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_CURSOR, SMALL_SCREEN_WIDTH, TERMINAL_THEME, terminalFontSize } from './terminal-theme';

/** The hex value a token has in src/tokens.css (the first definition, which is the one on :root). */
const sheet = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8');
const token = (name: string) => new RegExp(`--tr-${name}:\\s*(#[0-9a-f]{6})\\b`, 'i').exec(sheet)?.[1].toLowerCase();

describe('the terminal theme', () => {
  it('repeats the Midnight tokens it mirrors, since xterm cannot read CSS variables', () => {
    const mirrored = { background: 'term', cursorAccent: 'term', foreground: 'fg', cursor: 'fg', selectionBackground: 'control-on', black: 'surface', red: 'danger', green: 'success', yellow: 'warning',
      blue: 'accent', magenta: 'st-waiting', cyan: 'ch-codex', white: 'fg', brightBlack: 'fg-faint', brightRed: 'del', brightGreen: 'add', brightWhite: 'fg-strong',
      scrollbarSliderBackground: 'line', scrollbarSliderHoverBackground: 'line-strong', scrollbarSliderActiveBackground: 'accent' } as const;
    for (const [key, name] of Object.entries(mirrored)) expect(`${key} ${TERMINAL_THEME[key as keyof typeof mirrored]}`).toBe(`${key} ${token(name)}`);
  });
  it('gives each engine its own colour as the cursor', () => {
    expect(ENGINE_CURSOR).toEqual({ claude: token('ch-claude'), codex: token('ch-codex'), gemini: token('ch-gemini'), custom: token('ch-custom'), shell: token('ch-shell') });
  });
});

describe('the terminals’ font size', () => {
  it('shows a size left at the default one smaller on a laptop’s screen, and keeps a size the person set', () => {
    expect(terminalFontSize(13, true, 1470)).toBe(12); expect(terminalFontSize(13, true, SMALL_SCREEN_WIDTH)).toBe(13); expect(terminalFontSize(13, true, 2560)).toBe(13);
    expect(terminalFontSize(14, true, 1470)).toBe(14); expect(terminalFontSize(11, true, 1470)).toBe(11);
    // Turned off in Settings: 13 on a laptop too.
    expect(terminalFontSize(13, false, 1470)).toBe(13);
    // No screen to measure (a test window): as set.
    expect(terminalFontSize(13, true, Infinity)).toBe(13);
  });
});
