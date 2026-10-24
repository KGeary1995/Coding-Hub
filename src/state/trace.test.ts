import { describe, expect, it } from 'vitest';
import { TRACE_FLOOR, TRACE_HEIGHT, TRACE_RAIL, TRACE_WIDTH, tracePath, traceScale } from './trace';

const points = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));

describe('scope trace', () => {
  it('draws silence flat along the baseline across the full width', () => {
    const drawn = points(tracePath(Array(120).fill(0)));
    expect(drawn).toHaveLength(120);
    expect(drawn[0].x).toBe(0); expect(drawn.at(-1)!.x).toBe(TRACE_WIDTH);
    expect(new Set(drawn.map((point) => point.y)).size).toBe(1);
    expect(drawn[0].y).toBeGreaterThan(TRACE_HEIGHT / 2);
  });

  it('scales to the window peak, reaching the limit rail and never crossing it', () => {
    const drawn = points(tracePath([0, 5000, 2500, 20000, 0]));
    expect(Math.min(...drawn.map((point) => point.y))).toBe(Math.round(TRACE_RAIL * 10) / 10);
    expect(drawn[3].y).toBe(Math.min(...drawn.map((point) => point.y)));
    expect(drawn[1].y).toBeGreaterThan(drawn[3].y);
  });

  it('keeps quiet output low instead of scaling it up to full height', () => {
    expect(traceScale([3, 10, 2])).toBe(TRACE_FLOOR);
    const drawn = points(tracePath([0, 10, 0]));
    expect(drawn[1].y).toBeGreaterThan(TRACE_HEIGHT * 0.8);
  });
});
