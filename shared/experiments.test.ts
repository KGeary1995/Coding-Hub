import { describe, expect, it } from 'vitest';
import { compareExperiment } from './experiments';
import type { Experiment, Trial } from './workbench';
import type { UsageRecord } from './hub';
describe('outcome comparisons', () => {
  it('keeps missing telemetry unknown and shows successful outcomes alongside tokens', () => {
    const experiment = { id: 'e' } as Experiment; const trials = [{ experimentId: 'e', variant: 'A', runId: 'r', minutes: 10, rework: 2, outcome: 'successful', evidence: 'Tests pass' }, { experimentId: 'e', variant: 'B', runId: null, minutes: 5, rework: 0, outcome: 'failed', evidence: 'Failed tests' }] as Trial[];
    const usage = [{ runId: 'r', engine: 'codex', input: 100, output: 30, cached: 20, cacheWrite: 0 }] as UsageRecord[];
    const [a, b] = compareExperiment(experiment, trials, usage); expect(a.averageTokens).toBe(130); expect(a.successful).toBe(1); expect(b.averageTokens).toBeNull(); expect(b.successful).toBe(0); expect(b.averageMinutes).toBe(5);
  });
});
