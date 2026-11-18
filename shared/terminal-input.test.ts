import { describe, expect, it } from 'vitest';
import { isPersonInput, withoutTerminalReplies } from './terminal-input';

describe('terminal input', () => {
  it('takes F3 with Shift, Alt or Ctrl as typing, though it looks like a cursor report', () => {
    for (const key of ['\x1b[1;2R', '\x1b[1;3R', '\x1b[1;5R', '\x1b[1;6R', '\x1b[1;8R']) { expect(isPersonInput(key)).toBe(true); expect(withoutTerminalReplies(key)).toBe(key); }
    expect(isPersonInput('\x1bOR')).toBe(true);
  });
  it('still leaves out the replies a terminal sends on its own', () => {
    for (const reply of ['\x1b[24;80R', '\x1b[1;1R', '\x1b[1;12R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[I']) expect(isPersonInput(reply)).toBe(false);
    expect(withoutTerminalReplies('a\x1b[24;80Rb')).toBe('ab');
  });
});
