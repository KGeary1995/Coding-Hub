import { describe, expect, it, vi } from 'vitest';

// The measure itself is pure; the hook beside it reads the live terminal, which needs a window.
vi.mock('../../runtime/terminals', () => ({ terminalDimensions: () => ({ cols: 80, rows: 24 }) }));
import { terminalRow } from './terminal-row';

describe('a terminal line’s height', () => {
  it('is the screen’s height over its lines, to a hundredth of a pixel', () => {
    expect(terminalRow(720, 30)).toBe(24);
    expect(terminalRow(302, 13)).toBe(23.23);
  });
  it('is unknown while the terminal is not drawn', () => {
    expect(terminalRow(0, 30)).toBeNull();
    expect(terminalRow(720, 0)).toBeNull();
  });
});
