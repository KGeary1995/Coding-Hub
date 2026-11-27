import { describe, expect, it } from 'vitest';
import { ScreenReader } from './screen-reader';

describe('ScreenReader', () => {
  it('survives resizes between scrolling, wide characters and the alternate screen (xterm threw with no scrollback)', async () => {
    const errors: unknown[] = []; const caught = (error: unknown) => { errors.push(error); };
    process.on('uncaughtException', caught);
    const reader = new ScreenReader('codex', 183, 30, () => '', () => {});
    try {
      // The fuzz sequence (seed 2) that made xterm 6.0.0 throw in lineFeed with scrollback 0.
      let seed = 2; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      const pieces = ['✅', '❌', '你好', 'abc', '\x1b[2J', '\x1b[H', '\x1b[3J', '\x1b[?1049h', '\x1b[?1049l', '\x1b[5;20r', '\x1b[r', '\x1bM', '\x1b[10S', '\x1b[10T', '\x1b[L', '\x1b[M', '\r\n', '\n', '\x1b[999B', '\x1b[2K'];
      for (let i = 0; i < 20000; i++) {
        const kind = rnd(6);
        if (kind === 0) reader.resize(20 + rnd(170), 5 + rnd(45));
        else if (kind === 1) reader.write(`\x1b[${1 + rnd(60)};${1 + rnd(200)}H`);
        else reader.write(Array.from({ length: 1 + rnd(8) }, () => pieces[rnd(pieces.length)].repeat(1 + rnd(30))).join(''));
      }
      const terminal = (reader as unknown as { terminal: { write(data: string, callback: () => void): void } }).terminal;
      await new Promise<void>((resolve) => terminal.write('', resolve));
      expect(errors).toEqual([]);
    } finally { reader.dispose(); process.off('uncaughtException', caught); }
  }, 30_000);
  it('knows when the program asks for bracketed paste, so a typed request goes in as one (pty-manager submitRemote)', async () => {
    const reader = new ScreenReader('codex', 80, 24, () => '', () => {}); const terminal = (reader as unknown as { terminal: { write(data: string, callback: () => void): void } }).terminal;
    const settled = () => new Promise<void>((resolve) => terminal.write('', resolve));
    try {
      expect(reader.bracketedPaste).toBe(false);
      reader.write('\x1b[?2004h'); await settled(); expect(reader.bracketedPaste).toBe(true);
      reader.write('\x1b[?2004l'); await settled(); expect(reader.bracketedPaste).toBe(false);
    } finally { reader.dispose(); }
  });
});
