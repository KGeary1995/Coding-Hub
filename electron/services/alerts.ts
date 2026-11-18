import type { DayUsage, HubPreferences } from '../../shared/hub';
import type { PlanLimits } from '../../shared/plan-limits';
import type { AlertTarget } from '../../shared/ipc';

/** A desktop notification, and what clicking it opens. */
export interface DesktopAlert { title: string; body: string; target: AlertTarget }
/** The share of a budget or plan limit at which Trace warns first (it warns again when it is reached). */
export const DEFAULT_WARNING = 80;
const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);

/**
 * A plan window's reset as a stable key. Claude Code words it itself and the minute drifts between checks ("Nov 4,
 * 10:59am", then "Nov 4, 11am"), so its time is taken to the nearest hour, carried over midnight ("Nov 4, 11:59pm" is
 * "Nov 5, 12am"). With no reset given, the day stands in for it, so a later window is still warned about.
 */
export function resetKey(resets: string | null, day: string): string {
  if (!resets) return `day ${day}`; if (/^\d{4}-/.test(resets)) return resets;
  let text = resets.toLowerCase().replace(/\s+at\s+|,/g, ' ').replace(/\s+/g, ' ').trim();
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/.exec(text); if (!time) return text;
  const hour = Math.round(((Number(time[1]) % 12 + (time[3] === 'pm' ? 12 : 0)) * 60 + Number(time[2] ?? 0)) / 60);
  text = text.replace(time[0], `${hour % 24}h`);
  const date = new RegExp(String.raw`\b(${MONTHS.join('|')})[a-z]*\.? (\d{1,2})\b`).exec(text);
  if (hour === 24 && date) { const next = new Date(Date.UTC(Number(day.slice(0, 4)) || 2000, MONTHS.indexOf(date[1]), Number(date[2]) + 1)); text = text.replace(date[0], `${MONTHS[next.getUTCMonth()]} ${next.getUTCDate()}`); }
  return text;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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
    once(`${plan.engine}:${plan.account}:${window.label}:${resetKey(window.resets, today.day)}:${level}`, { title: level === 100 ? `${name} reached` : `${Math.round(window.usedPercent)}% of the ${name} used`, body: window.resets ? `It resets ${/^\d{4}-/.test(window.resets) ? new Date(window.resets).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : window.resets}.` : 'Open Usage for details.', target: { view: 'usage' } });
  }
  return alerts;
}
