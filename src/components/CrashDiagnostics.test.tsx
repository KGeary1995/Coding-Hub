import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StallList, stallLines, type Stall } from './CrashDiagnostics';

const stalls: Stall[] = [
  { time: '2026-11-17T10:00:00.000Z', side: 'main', kind: 'main-stall', ms: 1200, job: 'telemetry-poll' },
  { time: '2026-11-17T10:05:00.000Z', side: 'gpu', kind: 'gpu-crash', ms: null, job: null },
];

describe('stalls in Diagnostics', () => {
  it('lists them newest first, naming the side, with the time stopped and the job when known', () => {
    const lines = stallLines(stalls);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ · GPU · gpu-crash$/);
    expect(lines[1]).toMatch(/ · Main process · main-stall · 1200 ms · telemetry-poll$/);
  });
  it('shows nothing when there are none, or the host sends none', () => {
    expect(renderToStaticMarkup(<StallList stalls={[]} />)).toBe('');
    expect(renderToStaticMarkup(<StallList stalls={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<StallList stalls={stalls} />)).toContain('aria-label="Stalls"');
  });
});
