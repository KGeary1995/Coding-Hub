import { describe, expect, it } from 'vitest';
import { compareExperiment } from './experiments';
import type { Experiment, Trial } from './workbench';
import type { UsageRecord } from './hub';
describe('outcome comparisons', () => {
  it('keeps missing telemetry unknown and shows successful outcomes alongside tokens', () => {
    const experiment = { id: 'e' } as Experiment; const trials = [{ experimentId: 'e', variant: 'A', runId: 'r', minutes: 10, rework: 2, outcome: 'successful', evidence: 'Tests pass' }, { experimentId: 'e', variant: 'B', runId: null, minutes: 5, rework: 0, outcome: 'failed', evidence: 'Failed tests' }] as Trial[];
    const usage = [{ runId: 'r', engine: 'codex', input: 100, output: 30, cached: 20, cacheWrite: 0 }] as UsageRecord[];
    const [a, b] = compareExperiment(experiment, trials, usage); expect(a.averageTokens).toBe(110); expect(a.successful).toBe(1); expect(b.averageTokens).toBeNull(); expect(b.successful).toBe(0); expect(b.averageMinutes).toBe(5);
  });
  it('counts new tokens, as tiles and Usage do, not cache re-reads', () => {
    const trials = [{ experimentId: 'e', variant: 'A', runId: 'c', minutes: 1, rework: 0, outcome: 'successful', evidence: '' }, { experimentId: 'e', variant: 'B', runId: 'x', minutes: 1, rework: 0, outcome: 'successful', evidence: '' }] as Trial[];
    const usage = [{ runId: 'c', engine: 'claude', input: 1000, output: 2000, cached: 500000, cacheWrite: 20000 }, { runId: 'x', engine: 'codex', input: 520000, output: 2000, cached: 500000, cacheWrite: 0 }] as UsageRecord[];
    expect(compareExperiment({ id: 'e' } as Experiment, trials, usage).map((side) => side.averageTokens)).toEqual([23000, 22000]);
  });
});
