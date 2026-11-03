import { create } from 'zustand';
import { localDay, type DayUsage } from '../../shared/hub';
import { workbench } from '../runtime/workbench';

/** Today's usage from the CLIs' own logs (see DayUsage on the host), for the status bar's "Σ today". */
export const useDayUsage = create<{ usage: DayUsage | null }>(() => ({ usage: null }));
let reading = false;
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
