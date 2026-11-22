import { create } from 'zustand';
import { localDay, type DayUsage, type LogUsage } from '../../shared/hub';
import { workbench } from '../runtime/workbench';

/** Today's usage from the CLIs' own logs (see DayUsage on the host), for the status bar's "Σ today". */
export const useDayUsage = create<{ usage: DayUsage | null; days: LogUsage | null }>(() => ({ usage: null, days: null }));
let reading = false; let readingDays = false;
/**
 * The next read of a day not caught up yet. One at a time: the status bar also asks every 15 s, and each answer that is
 * not caught up used to start another chain, so reads came closer and closer together. Each read blocks the host for up
 * to about 0.1 s, so they are a second apart.
 */
let followUp: ReturnType<typeof setTimeout> | null = null;
export const FOLLOW_UP_MS = 1000;
/** Every day's usage from the CLIs' logs (the last 60 days), for the Usage screen; read again until caught up. */
export async function refreshUsageDays() {
  if (readingDays) return; readingDays = true;
  try { const days = await workbench<LogUsage>({ action: 'usage-days' }); useDayUsage.setState({ days }); if (!days.complete) setTimeout(() => void refreshUsageDays(), 300); }
  catch { /* The Usage screen falls back to Trace's own runs. */ }
  finally { readingDays = false; }
}
export async function refreshDayUsage() {
  if (reading) return; reading = true;
  // A long day's logs take more than one read: the next follows shortly, until they are caught up.
  try { const usage = await workbench<DayUsage>({ action: 'usage-today' }); useDayUsage.setState({ usage }); if (!usage.complete) followUp ??= setTimeout(() => { followUp = null; void refreshDayUsage(); }, FOLLOW_UP_MS); }
  catch { /* Kept as it was; the status bar falls back to Trace's own runs. */ }
  finally { reading = false; }
}
/**
 * The day's total: the CLIs' logs, which include use outside Trace, or Trace's own runs when those are ahead (the logs
 * are read every few seconds, and a long day's first read takes more than one pass).
 */
export function dayTotal(logs: DayUsage | null, trace: { tokens: number; cost: number | null }, now = new Date()) {
  const fromLogs = logs && logs.day === localDay(now) ? logs.claude + logs.codex + (logs.gemini ?? 0) : null;
  return fromLogs === null || fromLogs < trace.tokens ? { ...trace, logs: null } : { tokens: fromLogs, cost: logs!.cost, logs };
}
