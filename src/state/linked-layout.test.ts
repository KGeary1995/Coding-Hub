import { describe, expect, it } from 'vitest';
import { arrangeLinked } from './linked-layout';

describe('arrangeLinked', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `c${index + 1}`);
  /** Each row's tile widths, top to bottom (twelve columns). */
  const rows = (count: number) => { const out: number[][] = []; for (const tile of arrangeLinked(ids(count), {})) (out[tile.y / 12] ??= []).push(tile.w); return out; };
  it('places new channels two to a row, and a last one alone in its row across the whole width', () => {
    expect(arrangeLinked(['a', 'b', 'c'], {}).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([
      { i: 'a', x: 0, y: 0, w: 6, h: 12 }, { i: 'b', x: 6, y: 0, w: 6, h: 12 }, { i: 'c', x: 0, y: 12, w: 12, h: 12 },
    ]);
    expect(Array.from({ length: 8 }, (_, index) => rows(index + 1))).toEqual([
      [[12]], [[6, 6]], [[6, 6], [12]], [[6, 6], [6, 6]], [[6, 6], [6, 6], [12]], [[6, 6], [6, 6], [6, 6]], [[6, 6], [6, 6], [6, 6], [12]], [[6, 6], [6, 6], [6, 6], [6, 6]],
    ]);
  });
  it('keeps where the person put channels, drops closed ones, and adds new ones below', () => {
    const saved = { a: { x: 0, y: 0, w: 4, h: 8 }, b: { x: 4, y: 0, w: 8, h: 20 } };
    expect(arrangeLinked(['b', 'new'], saved).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([{ i: 'b', x: 4, y: 0, w: 8, h: 20 }, { i: 'new', x: 0, y: 20, w: 12, h: 12 }]);
    expect(arrangeLinked(['a', 'b', 'n1', 'n2'], saved).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([{ i: 'a', x: 0, y: 0, w: 4, h: 8 }, { i: 'b', x: 4, y: 0, w: 8, h: 20 }, { i: 'n1', x: 0, y: 20, w: 6, h: 12 }, { i: 'n2', x: 6, y: 20, w: 6, h: 12 }]);
  });
});
