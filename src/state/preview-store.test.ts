import { describe, expect, it } from 'vitest';
import { covers } from './preview-store';

const room = { left: 100, top: 100, right: 500, bottom: 400 };
describe('the app preview under Trace’s own menus (1.43.0)', () => {
  it('is covered by a menu or dialog that overlaps its room, not by one beside it or one with no size', () => {
    expect(covers(room, [{ left: 450, top: 40, right: 700, bottom: 200 }])).toBe(true);
    expect(covers(room, [{ left: 500, top: 100, right: 700, bottom: 400 }])).toBe(false);
    expect(covers(room, [{ left: 200, top: 200, right: 200, bottom: 300 }])).toBe(false);
    expect(covers(room, [])).toBe(false);
  });
});
