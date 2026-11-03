import { create } from 'zustand';
import { localDay, type DayUsage, type LogUsage } from '../../shared/hub';
import { workbench } from '../runtime/workbench';

/** Today's usage from the CLIs' own logs (see DayUsage on the host), for the status bar's "Σ today". */
export const useDayUsage = create<{ usage: DayUsage | null; days: LogUsage | null }>(() => ({ usage: null, days: null }));
let reading = false; let readingDays = false;
/** Every day's usage from the CLIs' logs (the last 60 days), for the Usage screen; read again until caught up. */
export async function refreshUsageDays() {
  if (readingDays) return; readingDays = true;
  try { const days = await workbench<LogUsage>({ action: 'usage-days' }); useDayUsage.setState({ days }); if (!days.complete) setTimeout(() => void refreshUsageDays(), 300); }
  catch { /* The Usage screen falls back to Trace's own runs. */ }
  finally { readingDays = false; }
}
export async function refreshDayUsage() {
  if (reading) return; reading = true;
  // A long day's logs take more than one read: the next follows at once, until they are caught up.
  try { const usage = await workbench<DayUsage>({ action: 'usage-today' }); useDayUsage.setState({ usage }); if (!usage.complete) setTimeout(() => void refreshDayUsage(), 500); }
  catch { /* Kept as it was; the status bar falls back to Trace's own runs. */ }
  finally { reading = false; }
}
/**
 * The day's total: the CLIs' logs, which include use outside Trace, or Trace's own runs when those are ahead (the logs
 * are read every few seconds, and a long day's first read takes more than one pass).
 */
export function dayTotal(logs: DayUsage | null, trace: { tokens: number; cost: number | null }, now = new Date()) {
  const fromLogs = logs && logs.day === localDay(now) ? logs.claude + logs.codex : null;
  return fromLogs === null || fromLogs < trace.tokens ? { ...trace, logs: null } : { tokens: fromLogs, cost: logs!.cost, logs };
}
