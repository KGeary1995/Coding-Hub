import { describe, expect, it } from 'vitest';
import { fitPaste } from './screen';

/** The size the screen service counts: line ends as CRLF, UTF-8, a closing NUL. */
const size = (value: string) => new TextEncoder().encode(value.replace(/\r\n|\r|\n/g, '\r\n')).length + 1;

describe('a paste for the screen service', () => {
  it('is cut to the longest start that fits, between characters, counting line ends as CRLF', () => {
    const pieces = ['a', 'é', '€', '😀', '\n', '\r', '\r\n', ' '];
    for (let seed = 1; seed <= 200; seed++) {
      let state = seed; const next = () => { state = (state * 1103515245 + 12345) % 2147483648; return state; };
      const text = Array.from({ length: 40 }, () => pieces[next() % pieces.length]).join(''); const limit = 10 + (next() % 60);
      const cut = fitPaste(text, limit);
      expect(text.startsWith(cut)).toBe(true); expect(size(cut)).toBeLessThanOrEqual(limit);
      // One more character would not fit (or there is none).
      const more = Array.from(text.slice(cut.length))[0]; if (more !== undefined) expect(size(cut + more)).toBeGreaterThan(limit);
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(fitPaste('short')).toBe('short');
  });
  it('cuts a large paste in one pass', () => {
    const text = 'line of text é😀\n'.repeat(400_000); const started = performance.now();
    const cut = fitPaste(text); expect(size(cut)).toBeLessThanOrEqual(1024 * 1024); expect(performance.now() - started).toBeLessThan(400);
  });
});
