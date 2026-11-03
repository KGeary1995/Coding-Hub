import { describe, expect, it } from 'vitest';
import type { PlanLimits } from '../../shared/plan-limits';
import { usageAlerts } from './alerts';

const today = (tokens: number, cost: number | null = null) => ({ day: '2026-11-02', claude: tokens, codex: 0, cost, complete: true });
const claude = (usedPercent: number, resets = '2026-11-03T09:00:00.000Z'): PlanLimits => ({ engine: 'claude', account: 'Default', windows: [{ label: 'Week', usedPercent, resets }], plan: null, checkedAt: '', error: null });

describe('usage warnings', () => {
  it('warn once at the warning share of a daily budget and again when it is used up', () => {
    const warned = new Set<string>(); const preferences = { dailyTokens: 1000000, dailyCost: 10 };
    expect(usageAlerts(today(500000, 2), [], preferences, warned)).toEqual([]);
    const first = usageAlerts(today(850000, 2), [], preferences, warned); expect(first.map((alert) => alert.title)).toEqual(['85% of today\'s token budget used']); expect(first[0].target).toEqual({ view: 'usage' });
    expect(usageAlerts(today(900000, 2), [], preferences, warned)).toEqual([]);
    expect(usageAlerts(today(1200000, 10.5), [], preferences, warned).map((alert) => alert.title)).toEqual(['Today\'s token budget is used up', 'Today\'s cost budget is used up']);
    // A new day starts over.
    expect(usageAlerts({ ...today(850000), day: '2026-11-03' }, [], preferences, warned)).toHaveLength(1);
  });
  it('warn about a plan limit once per window, at the share chosen in Settings, and stay quiet with no budgets set', () => {
    const warned = new Set<string>();
    expect(usageAlerts(today(5e9), [claude(60)], { limitWarning: 70 }, warned)).toEqual([]);
    expect(usageAlerts(today(0), [claude(75)], { limitWarning: 70 }, warned).map((alert) => alert.title)).toEqual(['75% of the Claude week limit used']);
    expect(usageAlerts(today(0), [claude(80)], { limitWarning: 70 }, warned)).toEqual([]);
    expect(usageAlerts(today(0), [claude(100)], { limitWarning: 70 }, warned).map((alert) => alert.title)).toEqual(['Claude week limit reached']);
    // The window reset and filled up again.
    expect(usageAlerts(today(0), [claude(90, '2026-11-10T09:00:00.000Z')], {}, warned)).toHaveLength(1);
  });
});
