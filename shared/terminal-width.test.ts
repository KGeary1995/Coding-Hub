import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { measureLikeTheCLIs } from './terminal-width';

const draw = (terminal: Terminal, data: string) => new Promise<string>((done) => terminal.write(data, () => done(terminal.buffer.active.getLine(0)!.translateToString(true))));

describe('terminal widths', () => {
  it('gives emoji the two columns a CLI draws them in, so its cursor moves land where it meant', async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true }); measureLikeTheCLIs(terminal);
    for (const emoji of ['✅', '❌', '🤖', '中']) { await draw(terminal, '\x1b[H\x1b[2J' + emoji); expect(terminal.buffer.active.cursorX).toBe(2); }
    // An emoji made wide by a variation selector counts as two columns, as the CLIs draw it (1.43.0, the graphemes
    // add-on; Unicode 11 counted one).
    expect(terminal.unicode.activeVersion).toBe('15-graphemes');
    for (const selected of ['⚠️', '✔️']) { await draw(terminal, '\x1b[H\x1b[2J' + selected); expect(terminal.buffer.active.cursorX).toBe(2); }
    // So a CLI's "⚠️x✔️y✅z" ends where it meant: nine columns.
    await draw(terminal, '\x1b[H\x1b[2J⚠️x✔️y✅z'); expect(terminal.buffer.active.cursorX).toBe(9);
    for (const narrow of ['✔', '●', '─', '←', 'a']) { await draw(terminal, '\x1b[H\x1b[2J' + narrow); expect(terminal.buffer.active.cursorX).toBe(1); }
    // A CLI draws "✅ab" in four columns, steps back four and writes "zz" over the emoji: "ab" must stay whole.
    expect(await draw(terminal, '\x1b[H\x1b[2J✅ab\x1b[4Dzz')).toBe('zzab');
  });
  it('was a column short without it (the stray letters in a table of ✅ rows)', async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    expect(await draw(terminal, '✅ab\x1b[4Dzz')).toBe('zzb');
  });
});
