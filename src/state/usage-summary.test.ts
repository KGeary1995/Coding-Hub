import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../shared/hub';
import { axisMax, dailySeries, delta, inWindow, median, usageTotals, windowStart } from './usage-summary';

const now = new Date(2026, 9, 24, 15, 0);
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString();
const record = (patch: Partial<UsageRecord>): UsageRecord => ({ runId: Math.random().toString(), sessionId: 's', engine: 'claude', model: 'm', cwd: '/p', timestamp: at(24), input: 100, output: 50, cached: 10, cacheWrite: 0, reasoning: null, context: null, cost: null, ...patch });

describe('usage summary', () => {
  it('selects whole local days for a window and the window before it', () => {
    expect(windowStart(1, now)).toEqual(new Date(2026, 9, 24));
    expect(windowStart(7, now)).toEqual(new Date(2026, 9, 18));
    expect(windowStart(7, now, 1)).toEqual(new Date(2026, 9, 11));
    const records = [record({ timestamp: at(24) }), record({ timestamp: at(18, 0) }), record({ timestamp: at(17, 23) }), record({ timestamp: at(11) }), record({ timestamp: at(10) })];
    expect(inWindow(records, 7, now)).toHaveLength(2);
    expect(inWindow(records, 7, now, 1)).toHaveLength(2);
  });

  it('totals tokens without adding reasoning to output twice, and counts unpriced runs', () => {
    const totals = usageTotals([
      record({ engine: 'codex', output: 500, reasoning: 200, cost: 0.5, context: { used: 900, limit: 1000 } }),
      record({ output: 50, cost: null }),
    ]);
    // Codex input 100 includes its 10 cached tokens, so fresh input is 90 + Claude's 100.
    expect(totals).toMatchObject({ input: 190, output: 550, cached: 20, reasoning: 200, sessions: 2, overContext: 1, cost: 0.5, unpriced: 1 });
    expect(usageTotals([record({})]).reasoning).toBeNull();
    expect(usageTotals([]).cost).toBeNull();
  });

  it('builds one bar per day split by engine, cache excluded', () => {
    const series = dailySeries([record({ timestamp: at(24), input: 100, output: 50 }), record({ engine: 'codex', timestamp: at(23), input: 10, cached: 4, output: 5, cost: 1 }), record({ timestamp: at(1) })], 3, now);
    expect(series.map((day) => day.date.getDate())).toEqual([22, 23, 24]);
    expect(series[1]).toMatchObject({ claude: 0, codex: 11, cost: 1 });
    expect(series[2]).toMatchObject({ claude: 150, codex: 0, cost: null });
  });

  it('compares windows and picks readable axis steps', () => {
    expect(delta(120, 100)).toBe(20); expect(delta(5, 0)).toBeNull();
    expect(axisMax(0)).toBe(1); expect(axisMax(140_000)).toBe(200_000); expect(axisMax(48)).toBe(50); expect(axisMax(100)).toBe(100);
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull();
  });
});
