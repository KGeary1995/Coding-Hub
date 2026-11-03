import type { DayUsage, HubPreferences } from '../../shared/hub';
import type { PlanLimits } from '../../shared/plan-limits';
import type { AlertTarget } from '../../shared/ipc';

/** A desktop notification, and what clicking it opens. */
export interface DesktopAlert { title: string; body: string; target: AlertTarget }
/** The share of a budget or plan limit at which Trace warns first (it warns again when it is reached). */
export const DEFAULT_WARNING = 80;
const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);

/**
 * Warnings for today's usage against the daily budgets set in Settings, and for each plan limit the CLIs report, each
 * at most once: at the warning share and again when it is reached (a plan limit once per window, by when it resets).
 * `warned` holds what was already said and is updated.
 */
export function usageAlerts(today: DayUsage, limits: PlanLimits[], preferences: Pick<HubPreferences, 'dailyTokens' | 'dailyCost' | 'limitWarning'>, warned: Set<string>): DesktopAlert[] {
  const alerts: DesktopAlert[] = []; const warning = (preferences.limitWarning ?? DEFAULT_WARNING) / 100;
  const once = (key: string, alert: DesktopAlert) => { if (warned.has(key)) return; warned.add(key); alerts.push(alert); };
  const tokens = today.claude + today.codex;
  const budget = (kind: 'tokens' | 'cost', used: number | null, limit: number | null | undefined, text: (value: number) => string) => {
    if (!limit || used === null) return;
    const share = used / limit; const level = share >= 1 ? 100 : share >= warning ? Math.round(warning * 100) : 0; if (!level) return;
    once(`${today.day}:${kind}:${level}`, { title: level === 100 ? `Today's ${kind === 'tokens' ? 'token' : 'cost'} budget is used up` : `${Math.round(share * 100)}% of today's ${kind === 'tokens' ? 'token' : 'cost'} budget used`, body: `${text(used)} of ${text(limit)} today on this computer.`, target: { view: 'usage' } });
  };
  budget('tokens', tokens, preferences.dailyTokens, (value) => `${compact(value)} tokens`);
  budget('cost', today.cost, preferences.dailyCost, (value) => `$${value.toFixed(2)}`);
  for (const plan of limits) for (const window of plan.windows) {
    const share = window.usedPercent / 100; const level = share >= 1 ? 100 : share >= warning ? Math.round(warning * 100) : 0; if (!level) continue;
    const name = `${plan.engine === 'claude' ? 'Claude' : 'Codex'}${plan.account !== 'Default' ? ` (${plan.account})` : ''} ${window.label.toLowerCase()} limit`;
    once(`${plan.engine}:${plan.account}:${window.label}:${window.resets ?? ''}:${level}`, { title: level === 100 ? `${name} reached` : `${Math.round(window.usedPercent)}% of the ${name} used`, body: window.resets ? `It resets ${/^\d{4}-/.test(window.resets) ? new Date(window.resets).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : window.resets}.` : 'Open Usage for details.', target: { view: 'usage' } });
  }
  return alerts;
}
