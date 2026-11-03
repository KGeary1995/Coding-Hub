import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../shared/hub';
import { channelToday } from './channel-state';
import { dayTotal } from './day-usage-store';

const now = new Date(2026, 10, 2, 15, 0);
const run = (runId: string, sessionId: string, days: UsageRecord['days']) => ({ runId, sessionId, engine: 'claude', timestamp: now.toISOString(), input: 0, output: 0, cached: 0, cacheWrite: 0, cost: null, days }) as unknown as UsageRecord;

describe("today's counts", () => {
  it("count a channel's runs today together, across restarts, and only today's part of each", () => {
    const records = [run('a', 'ch1', { '2026-11-01': { tokens: 900, cost: null }, '2026-11-02': { tokens: 100, cost: null } }), run('b', 'ch1', { '2026-11-02': { tokens: 50, cost: null } }), run('c', 'ch2', { '2026-11-02': { tokens: 7, cost: null } })];
    expect(channelToday('ch1', records, now).tokens).toBe(150); expect(channelToday('ch3', records, now).tokens).toBe(0);
  });
  it("use the CLIs' logs for the day, unless they are behind Trace's own runs or from another day", () => {
    const logs = { day: '2026-11-02', claude: 1000, codex: 200, cost: 0.5, complete: true };
    expect(dayTotal(logs, { tokens: 900, cost: null }, now)).toMatchObject({ tokens: 1200, cost: 0.5 });
    expect(dayTotal(logs, { tokens: 1500, cost: null }, now)).toEqual({ tokens: 1500, cost: null, logs: null });
    expect(dayTotal({ ...logs, day: '2026-11-01' }, { tokens: 10, cost: null }, now).tokens).toBe(10);
    expect(dayTotal(null, { tokens: 10, cost: null }, now).tokens).toBe(10);
  });
});
