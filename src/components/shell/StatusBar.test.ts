import { describe, expect, it } from 'vitest';
import type { PlanLimits } from '../../../shared/plan-limits';
import { planReading } from './StatusBar';

const reading = (extra: Partial<PlanLimits> = {}): PlanLimits => ({ engine: 'claude', account: 'Default', windows: [], plan: null, checkedAt: '2026-11-18T10:00:00.000Z', error: null, ...extra });
const window = (label: string, usedPercent: number) => ({ label, usedPercent, resets: null });

describe('an engine’s plan cell in the status bar', () => {
  it('leaves whole when no account has a limit or an error', () => {
    expect(planReading([])).toBeNull();
    expect(planReading([reading(), reading({ account: 'Work' })])).toBeNull();
  });
  it('shows the default login’s 5-hour and weekly limits', () => {
    expect(planReading([reading({ account: 'Work', windows: [window('Session', 90)] }), reading({ windows: [window('Session', 12), window('Week', 40), window('Week (Fable)', 70)] })])).toEqual([window('Session', 12), window('Week', 40)]);
  });
  it('shows the fullest other limit when the login has neither of those', () => {
    expect(planReading([reading({ engine: 'codex', windows: [window('24 h', 20), window('Limit', 55)] })])).toEqual([window('Limit', 55)]);
  });
  it('keeps the cell, with nothing to count, for an error or when only another account has limits', () => {
    expect(planReading([reading({ error: 'Sign in to Claude Code to see its limits.' })])).toEqual([]);
    expect(planReading([reading(), reading({ account: 'Work', windows: [window('Week', 30)] })])).toEqual([]);
  });
});
