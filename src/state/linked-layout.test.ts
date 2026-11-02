import { describe, expect, it } from 'vitest';
import { arrangeLinked } from './linked-layout';

describe('arrangeLinked', () => {
  it('places new channels two to a row', () => {
    expect(arrangeLinked(['a', 'b', 'c'], {}).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([
      { i: 'a', x: 0, y: 0, w: 6, h: 12 }, { i: 'b', x: 6, y: 0, w: 6, h: 12 }, { i: 'c', x: 0, y: 12, w: 6, h: 12 },
    ]);
  });
  it('keeps where the person put channels, drops closed ones, and adds new ones below', () => {
    const layout = arrangeLinked(['b', 'new'], { a: { x: 0, y: 0, w: 4, h: 8 }, b: { x: 4, y: 0, w: 8, h: 20 } });
    expect(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([{ i: 'b', x: 4, y: 0, w: 8, h: 20 }, { i: 'new', x: 0, y: 20, w: 6, h: 12 }]);
  });
});
