import { describe, expect, it } from 'vitest';
import { blankExperiment, experimentDeleteQuestion, keptExperiment, trialLine, trialValues } from './ExperimentsPanel';

describe('recording an experiment trial', () => {
  it('refuses a trial whose time, rework or outcome was left empty, instead of saving 0 minutes and 0 rework', () => {
    expect(trialValues('', '', '', 'Tests pass')).toContain('Fill in');
    expect(trialValues('30', '', 'successful', 'Tests pass')).toContain('Fill in');
    expect(trialValues('30', '1', '', 'Tests pass')).toContain('Fill in');
  });
  it('keeps a 0 the person typed, and refuses values the host would refuse', () => {
    expect(trialValues('0', '0', 'failed', 'Tests pass')).toEqual({ minutes: 0, rework: 0, outcome: 'failed' });
    expect(trialValues('12.5', '2', 'partial', 'Tests pass')).toEqual({ minutes: 12.5, rework: 2, outcome: 'partial' });
    expect(trialValues('2000', '1', 'partial', 'Tests pass')).toContain('1,440');
    expect(trialValues('10', '1.5', 'partial', 'Tests pass')).toContain('whole number');
  });
  it('refuses evidence of only spaces before the host does', () => {
    expect(trialValues('5', '1', 'partial', '   ')).toContain('spaces alone');
    expect(trialValues('5', '1', 'partial', 'Tests pass')).toEqual({ minutes: 5, rework: 1, outcome: 'partial' });
  });
  it('refuses an experiment with a field of only spaces before the host does', () => {
    expect(blankExperiment(['  ', 'h', 'c', 'a', 'b'])).toContain('spaces alone');
    expect(blankExperiment(['n', 'h', 'c', 'a', 'b'])).toBe('');
  });
});

describe('deleting a wrong record', () => {
  const experiment = { id: 'e1', name: 'Short prompts', hypothesis: 'h', criterion: 'c', promptA: 'a', promptB: 'b', createdAt: '2026-11-17T10:00:00.000Z' };
  it('asks first, saying the experiment’s trials go with it', () => {
    expect(experimentDeleteQuestion(experiment, 0)).toBe('Delete this experiment? Short prompts');
    expect(experimentDeleteQuestion(experiment, 1)).toBe('Delete this experiment and its 1 trial? Short prompts');
    expect(experimentDeleteQuestion(experiment, 3)).toBe('Delete this experiment and its 3 trials? Short prompts');
  });
  it('names a trial well enough to tell it from the others', () => {
    const line = trialLine({ id: 't1', experimentId: 'e1', variant: 'B', runId: null, minutes: 12.5, rework: 1, outcome: 'partial', evidence: 'Tests pass', createdAt: '2026-11-17T10:00:00.000Z' });
    expect(line).toMatch(/^Variant B · Partial · 12.5 min · 1 rework · .+ · Tests pass$/);
  });
  it('keeps the trial form on its experiment, or on the first one left when that one was deleted', () => {
    const data = { experiments: [{ ...experiment, id: 'e2' }, { ...experiment, id: 'e3' }], trials: [] };
    expect(keptExperiment('e3', data)).toBe('e3'); expect(keptExperiment('e1', data)).toBe('e2'); expect(keptExperiment('e1', { experiments: [], trials: [] })).toBe('');
  });
});
