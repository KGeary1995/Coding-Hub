import type { WindowHealthReport } from '../../shared/ipc';

/** A task in the window this long or longer is recorded (ms), as the main process's stalls are. */
export const LONG_TASK_MS = 250;
/** A timer this late while the window is visible is a stall, unless a long task already covers it (ms). */
export const WINDOW_STALL_MS = 1000;
/** A timer later than this means the computer slept, not that the window stalled (the main side's limit too). */
export const WINDOW_SLEEP_MS = 60000;
const TICK = 500;
/** Long tasks reach their observer a little after the task; a stall waits this long to see whether one covers it. */
const COVER_WAIT = 1000;
/** At most this many reports a minute (the host keeps the same limit). */
const REPORTS_PER_MINUTE = 10;

/** What the watcher needs from the page, so it can be tested without one. */
export interface WindowHealthEnvironment {
  now(): number;
  visible(): boolean;
  /** Calls `listener` with each long task's start, duration and name; returns its stop function, or null without long-task support. */
  longTasks(listener: (start: number, duration: number, name: string) => void): (() => void) | null;
  onVisibility(listener: () => void): () => void;
  send(report: WindowHealthReport): void;
}

/**
 * Records when the window stops responding: long tasks of LONG_TASK_MS or more, and, while the window is visible,
 * timers late by WINDOW_STALL_MS or more that no long task explains. A hidden window's timers are slowed on purpose,
 * so they are not counted; nor is a gap over WINDOW_SLEEP_MS, which is the computer sleeping (the page clock can run
 * on through sleep, and the window stays "visible" while minimized). Returns its stop function.
 */
export function watchWindowHealth(env: WindowHealthEnvironment): () => void {
  const tasks: { start: number; end: number }[] = [];
  const stopTasks = env.longTasks((start, duration, name) => {
    if (!(duration >= LONG_TASK_MS)) return;
    tasks.push({ start, end: start + duration }); if (tasks.length > 20) tasks.shift();
    env.send({ kind: 'long-task', ms: Math.round(duration), detail: name });
  });
  let last = env.now(); let wasVisible = env.visible(); const checks = new Set<ReturnType<typeof setTimeout>>();
  const timer = setInterval(() => {
    const at = env.now(); const late = at - last - TICK; const visible = env.visible(); const counted = wasVisible && visible;
    last = at; wasVisible = visible;
    if (!counted || late < WINDOW_STALL_MS || late > WINDOW_SLEEP_MS) return;
    const from = at - late;
    const check = setTimeout(() => {
      checks.delete(check);
      // A long task that took at least half of the stall already says what happened.
      if (tasks.some((task) => Math.min(task.end, at) - Math.max(task.start, from) >= late / 2)) return;
      env.send({ kind: 'stall', ms: Math.round(late), detail: 'visible' });
    }, COVER_WAIT);
    checks.add(check);
  }, TICK);
  const stopVisibility = env.onVisibility(() => { last = env.now(); wasVisible = env.visible(); });
  return () => { clearInterval(timer); for (const check of checks) clearTimeout(check); checks.clear(); stopTasks?.(); stopVisibility(); };
}

let sent: number[] = [];
/**
 * Tells the host about trouble in the window (a lost WebGL context, a stall), for Settings' diagnostics. Only a kind,
 * a length and a short label are sent, never page content; at most REPORTS_PER_MINUTE a minute.
 */
export function reportWindowHealth(kind: WindowHealthReport['kind'], ms?: number, detail?: string, now = Date.now()): void {
  const host = typeof window === 'undefined' ? undefined : window.codingHub; if (!host?.reportWindowHealth) return;
  sent = sent.filter((at) => now - at < 60000); if (sent.length >= REPORTS_PER_MINUTE) return; sent.push(now);
  const report: WindowHealthReport = { kind };
  if (ms !== undefined && Number.isFinite(ms)) report.ms = Math.min(3_600_000, Math.max(0, Math.round(ms)));
  const label = detail?.replace(/[^\w .:/-]/g, '').slice(0, 60); if (label) report.detail = label;
  void host.reportWindowHealth(report).catch(() => {});
}

/** Starts recording the window's stalls (once, from main.tsx); returns its stop function. Does nothing outside Trace's window. */
export function startWindowHealth(): () => void {
  if (typeof window === 'undefined' || !window.codingHub?.reportWindowHealth) return () => {};
  return watchWindowHealth({
    now: () => performance.now(),
    visible: () => document.visibilityState === 'visible',
    longTasks: (listener) => {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return null;
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) listener(entry.startTime, entry.duration, entry.name); });
      observer.observe({ type: 'longtask', buffered: false }); return () => observer.disconnect();
    },
    onVisibility: (listener) => { document.addEventListener('visibilitychange', listener); return () => document.removeEventListener('visibilitychange', listener); },
    send: (report) => reportWindowHealth(report.kind, report.ms, report.detail),
  });
}
