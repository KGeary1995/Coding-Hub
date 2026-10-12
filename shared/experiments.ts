import type { Experiment, Trial } from './workbench';
import type { UsageRecord } from './hub';
export function compareExperiment(experiment: Experiment, trials: Trial[], usage: UsageRecord[]) {
  return (['A', 'B'] as const).map((variant) => {
    const samples = trials.filter((t) => t.experimentId === experiment.id && t.variant === variant); const measured = samples.flatMap((t) => { const record = usage.find((u) => u.runId === t.runId); return record ? [record] : []; });
    return { variant, trials: samples.length, successful: samples.filter((t) => t.outcome === 'successful').length, evidence: samples.filter((t) => t.evidence.trim()).length, averageMinutes: samples.length ? samples.reduce((s, t) => s + t.minutes, 0) / samples.length : null, averageRework: samples.length ? samples.reduce((s, t) => s + t.rework, 0) / samples.length : null, measuredRuns: measured.length, averageTokens: measured.length ? measured.reduce((s, u) => s + u.input + u.output + (u.engine === 'claude' ? u.cached + u.cacheWrite : 0), 0) / measured.length : null };
  });
}
