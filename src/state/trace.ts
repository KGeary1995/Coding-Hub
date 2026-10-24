/** Geometry of the scope strip trace: a 400 × 40 viewBox stretched to the strip (docs/design/trace/README.md). */
export const TRACE_WIDTH = 400;
export const TRACE_HEIGHT = 40;
/** The dashed limit rail sits 15% from the top; the trace tops out at it. */
export const TRACE_RAIL = TRACE_HEIGHT * 0.15;
const BASELINE = TRACE_HEIGHT - 3;

/**
 * Output below this many characters per second never reaches full height, so a quiet channel
 * (a prompt redraw, a spinner) stays low instead of being scaled up into noise.
 */
export const TRACE_FLOOR = 400;

/** Scale for a window of samples: its own peak, but never below the floor. */
export const traceScale = (samples: readonly number[]) => Math.max(TRACE_FLOOR, ...samples);

/** SVG path for per-second samples, oldest at the left. Silence is drawn at the baseline; nothing is invented. */
export function tracePath(samples: readonly number[]) {
  if (samples.length < 2) return `M0 ${BASELINE} H${TRACE_WIDTH}`;
  const scale = traceScale(samples); const step = TRACE_WIDTH / (samples.length - 1);
  return samples.map((sample, index) => {
    const y = BASELINE - Math.min(1, Math.max(0, sample) / scale) * (BASELINE - TRACE_RAIL);
    return `${index ? 'L' : 'M'}${round(index * step)} ${round(y)}`;
  }).join(' ');
}

const round = (value: number) => Math.round(value * 10) / 10;
