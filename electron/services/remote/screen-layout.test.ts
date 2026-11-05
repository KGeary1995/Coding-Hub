import { describe, expect, it } from 'vitest';
import { layoutDisplays } from './screen-layout';

describe('the shared Windows screen covers every display', () => {
  it('keeps one display as it was: full size up to 1920×1200', () => {
    expect(layoutDisplays([{ id: '1', x: 0, y: 0, width: 1920, height: 1080 }])).toEqual({ width: 1920, height: 1080, parts: [{ id: '1', x: 0, y: 0, width: 1920, height: 1080 }] });
    expect(layoutDisplays([{ id: '1', x: 0, y: 0, width: 3840, height: 2160 }])).toMatchObject({ width: 1920, height: 1080 });
  });

  it('puts two displays side by side at full size, as Windows arranges them', () => {
    const layout = layoutDisplays([{ id: '1', x: 0, y: 0, width: 1920, height: 1080 }, { id: '2', x: 1920, y: 0, width: 1920, height: 1080 }]);
    expect(layout).toEqual({ width: 3840, height: 1080, parts: [{ id: '1', x: 0, y: 0, width: 1920, height: 1080 }, { id: '2', x: 1920, y: 0, width: 1920, height: 1080 }] });
  });

  it('handles a second display to the left of and lower than the main one (negative coordinates)', () => {
    const layout = layoutDisplays([{ id: 'main', x: 0, y: 0, width: 2560, height: 1440 }, { id: 'left', x: -1920, y: 360, width: 1920, height: 1080 }]);
    expect(layout.width).toBeLessThanOrEqual(3840); expect(layout.width % 2).toBe(0); expect(layout.height % 2).toBe(0);
    expect(layout.width * layout.height).toBeLessThanOrEqual(1920 * 1200 * 2);
    const [main, left] = layout.parts;
    expect(left.x).toBe(0); expect(main.x).toBe(left.width); expect(main.x + main.width).toBe(layout.width);
    expect(main.y).toBe(0); expect(left.y).toBeGreaterThan(0); expect(left.y + left.height).toBe(layout.height);
  });

  it('scales large setups down to fit', () => {
    const layout = layoutDisplays([{ id: '1', x: 0, y: 0, width: 3840, height: 2160 }, { id: '2', x: 3840, y: 0, width: 3840, height: 2160 }]);
    expect(layout.width).toBeLessThanOrEqual(3840); expect(layout.width * layout.height).toBeLessThanOrEqual(1920 * 1200 * 2);
    expect(Math.abs(layout.width / layout.height - 7680 / 2160)).toBeLessThan(0.01); expect(layout.parts[1].x + layout.parts[1].width).toBe(layout.width);
  });
});
