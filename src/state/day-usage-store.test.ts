import { describe, expect, it, vi } from 'vitest';

let reads = 0;
vi.mock('../runtime/workbench', () => ({ workbench: vi.fn(async () => { reads++; return { day: '2026-11-02', claude: 0, codex: 0, cost: null, complete: false }; }) }));
import type { UsageRecord } from '../../shared/hub';
import { channelToday } from './channel-state';
import { dayTotal, FOLLOW_UP_MS, refreshDayUsage } from './day-usage-store';
import { dailySeries, inWindow, logRecords, usageTotals } from './usage-summary';

const now = new Date(2026, 10, 2, 15, 0);
const run = (runId: string, sessionId: string, days: UsageRecord['days']) => ({ runId, sessionId, engine: 'claude', timestamp: now.toISOString(), input: 0, output: 0, cached: 0, cacheWrite: 0, cost: null, days }) as unknown as UsageRecord;

describe("today's counts", () => {
  it("count a channel's runs today together, across restarts, and only today's part of each", () => {
    const records = [run('a', 'ch1', { '2026-11-01': { tokens: 900, cost: null }, '2026-11-02': { tokens: 100, cost: null } }), run('b', 'ch1', { '2026-11-02': { tokens: 50, cost: null } }), run('c', 'ch2', { '2026-11-02': { tokens: 7, cost: null } })];
    expect(channelToday('ch1', records, now).tokens).toBe(150); expect(channelToday('ch3', records, now).tokens).toBe(0);
  });
  it("give the Usage screen one record per day and engine from the CLIs' logs, counted on that day", () => {
    const logs = { days: { '2026-11-01': { claude: { input: 10, output: 90, cached: 5000, cacheWrite: 0, cost: 0.2 } }, '2026-11-02': { codex: { input: 700, output: 40, cached: 300, cacheWrite: 0, cost: null } } }, complete: true };
    const records = logRecords(logs);
    expect(usageTotals(inWindow(records, 1, now))).toMatchObject({ input: 700, output: 40, cached: 300 });
    expect(dailySeries(records, 7, now).slice(-2).map((day) => [day.claude, day.codex])).toEqual([[100, 0], [0, 740]]);
  });
  it("use the CLIs' logs for the day, unless they are behind Trace's own runs or from another day", () => {
    const logs = { day: '2026-11-02', claude: 1000, codex: 200, cost: 0.5, complete: true };
    expect(dayTotal(logs, { tokens: 900, cost: null }, now)).toMatchObject({ tokens: 1200, cost: 0.5 });
    expect(dayTotal(logs, { tokens: 1500, cost: null }, now)).toEqual({ tokens: 1500, cost: null, logs: null });
    expect(dayTotal({ ...logs, day: '2026-11-01' }, { tokens: 10, cost: null }, now).tokens).toBe(10);
    expect(dayTotal(null, { tokens: 10, cost: null }, now).tokens).toBe(10);
  });
});

describe('catching up on a long day', () => {
  it('keeps one chain of follow-up reads, a second apart, however often the status bar asks', async () => {
    vi.useFakeTimers();
    try {
      await refreshDayUsage(); await refreshDayUsage(); await refreshDayUsage(); expect(reads).toBe(3);
      await vi.advanceTimersByTimeAsync(FOLLOW_UP_MS - 1); expect(reads).toBe(3);
      await vi.advanceTimersByTimeAsync(1); expect(reads).toBe(4);
      await vi.advanceTimersByTimeAsync(FOLLOW_UP_MS); expect(reads).toBe(5);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
