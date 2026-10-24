import type { UsageRecord } from '../../shared/hub';

/** Usage windows on the Usage screen, in days ("Today" is the current local day). */
export const USAGE_WINDOWS = [{ id: 1, label: 'Today' }, { id: 7, label: '7 d' }, { id: 14, label: '14 d' }, { id: 30, label: '30 d' }] as const;
export type UsageWindow = typeof USAGE_WINDOWS[number]['id'];

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/** The first instant of a window that ends today and spans `days` local days, shifted back `periods` whole windows. */
export function windowStart(days: number, now = new Date(), periods = 0) {
  const start = startOfDay(now); start.setDate(start.getDate() - (days - 1) - periods * days); return start;
}

/** Records whose session started inside the window (`periods` back selects the window before it, for deltas). */
export function inWindow(records: UsageRecord[], days: number, now = new Date(), periods = 0) {
  const from = windowStart(days, now, periods).getTime();
  const to = periods === 0 ? Infinity : windowStart(days, now, periods - 1).getTime();
  return records.filter((record) => { const at = new Date(record.timestamp).getTime(); return at >= from && at < to; });
}

/** Share of the context window a run reached, when the CLI reported one. */
export const contextPeak = (record: UsageRecord) => record.context && record.context.limit > 0 ? record.context.used / record.context.limit : null;

export interface UsageTotals { input: number; output: number; cached: number; reasoning: number | null; sessions: number; overContext: number; cost: number | null; unpriced: number }

/** Totals for the KPI strip. Reasoning is reported inside output, so it is shown as part of it and never added again. */
export function usageTotals(records: UsageRecord[]): UsageTotals {
  let reasoning: number | null = null; let cost: number | null = null; let unpriced = 0;
  const totals = { input: 0, output: 0, cached: 0, sessions: records.length, overContext: 0 };
  for (const record of records) {
    totals.input += record.input; totals.output += record.output; totals.cached += record.cached;
    if (record.reasoning !== null) reasoning = (reasoning ?? 0) + record.reasoning;
    if (record.cost === null) unpriced++; else cost = (cost ?? 0) + record.cost;
    if ((contextPeak(record) ?? 0) >= 0.8) totals.overContext++;
  }
  return { ...totals, reasoning, cost, unpriced };
}

/** Change against the previous window, as a whole percentage; null when there is nothing to compare with. */
export const delta = (current: number, previous: number) => previous > 0 ? Math.round((current - previous) / previous * 100) : null;

export interface UsageDay { key: string; date: Date; claude: number; codex: number; cost: number | null }

/** One entry per local day in the window, oldest first, with input + output tokens (cache excluded) per engine. */
export function dailySeries(records: UsageRecord[], days: number, now = new Date()): UsageDay[] {
  const series: UsageDay[] = [];
  const start = windowStart(days, now);
  for (let offset = 0; offset < days; offset++) { const date = new Date(start); date.setDate(start.getDate() + offset); series.push({ key: dayKey(date), date, claude: 0, codex: 0, cost: null }); }
  const byKey = new Map(series.map((day) => [day.key, day]));
  for (const record of records) {
    const day = byKey.get(dayKey(new Date(record.timestamp))); if (!day) continue;
    day[record.engine] += record.input + record.output;
    if (record.cost !== null) day.cost = (day.cost ?? 0) + record.cost;
  }
  return series;
}

/** A round axis maximum above the tallest bar (1, 2 or 5 × a power of ten), so gridlines land on readable numbers. */
export function axisMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * power).find((candidate) => candidate >= value)!;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
