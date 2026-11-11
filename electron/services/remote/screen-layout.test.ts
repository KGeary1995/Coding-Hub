import { describe, expect, it } from 'vitest';
import { layoutDisplays, mainDisplayFallback, orderDisplays, pictureRegion, WHOLE_DESKTOP } from './screen-layout';
import { pointerCommands } from './screen-input';

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

describe('one display of several, at full size', () => {
  const main = { id: 'main', x: 0, y: 0, width: 2560, height: 1440 }; const left = { id: 'left', x: -1920, y: 360, width: 1920, height: 1080 };
  it('numbers displays from the left', () => {
    expect(orderDisplays([main, left]).map((d) => d.id)).toEqual(['left', 'main']);
  });
  it('places one display on the desktop, so clicks in its picture land on it', () => {
    expect(pictureRegion([main, left], [main, left])).toEqual(WHOLE_DESKTOP);
    // The desktop runs from x -1920 to 2559 and y 0 to 1439; the main display is its right-hand part.
    const region = pictureRegion([main, left], [main]);
    expect(region.left).toBeCloseTo(1920 / 4479); expect(region.width).toBeCloseTo(2559 / 4479); expect(region).toMatchObject({ top: 0, height: 1 });
    // Its picture is 1920 × 1080 (the one-display limit): its corners are the main display's corners on the desktop.
    const picture = layoutDisplays([main]); expect(picture).toMatchObject({ width: 1920, height: 1080 });
    expect(pointerCommands(0, 0, 0, 0, picture.width, picture.height, region)[0]).toBe(`m ${Math.round(65535 * 1920 / 4479)} 0 49153 0`);
    expect(pointerCommands(1919, 1079, 0, 0, picture.width, picture.height, region)[0]).toBe('m 65535 65535 49153 0');
    // The left display, lower down: its top is 360 of the desktop's 1440 rows.
    const low = pictureRegion([main, left], [left]); expect(pointerCommands(0, 0, 0, 0, 1920, 1080, low)[0]).toBe(`m 0 ${Math.round(65535 * 360 / 1439)} 49153 0`);
  });
});

describe('the fallback when no capture source names its display', () => {
  it('shows the main display at its physical size, with clicks on it alone', () => {
    // The main display at 125%: 1536 × 864 in Windows' logical pixels, 1920 × 1080 physical; a second display to its right.
    const main = { id: '1', x: 0, y: 0, width: 1920, height: 1080 }; const right = { id: '2', x: 1920, y: 0, width: 2560, height: 1440 };
    const { layout, region } = mainDisplayFallback([main, right], main);
    expect(layout).toMatchObject({ width: 1920, height: 1080 });
    // Its corners are the main display's corners on the desktop (0 to 4479 across, 0 to 1439 down), not the desktop's.
    expect(pointerCommands(0, 0, 0, 0, layout.width, layout.height, region)[0]).toBe('m 0 0 49153 0');
    expect(pointerCommands(1919, 1079, 0, 0, layout.width, layout.height, region)[0]).toBe(`m ${Math.round(65535 * 1919 / 4479)} ${Math.round(65535 * 1079 / 1439)} 49153 0`);
  });
});
