import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { load, save } from '../workbench/local-store';
import type { HostHealthReport } from '../../../shared/workbench';
const entry = z.object({ time: z.iso.datetime(), event: z.string().max(80), reason: z.string().max(120).nullable(), exitCode: z.number().int().nullable() }).strict();
/** Stalls are kept apart from the lifecycle events, so channel starts cannot push them out. */
export const STALL_LIMIT = 200;
/** Which side stopped (the main process, the window, the GPU process), what (`main-stall`, `long-task`…), how long, and the job's label. */
const stallEntry = z.object({ time: z.iso.datetime(), side: z.enum(['main', 'window', 'gpu']), kind: z.string().max(40), ms: z.number().int().min(0).nullable(), job: z.string().max(80).nullable() }).strict();
export type StallRecord = z.infer<typeof stallEntry>;
const schema = z.object({ cleanShutdown: z.boolean(), events: z.array(entry).max(100), stalls: z.array(stallEntry).max(STALL_LIMIT).optional() }).strict();

/**
 * Each window's state when the GPU process crashed, as one health reason (at most 120 characters): "w1 visible focused;
 * w2 minimized". Says nothing about what a window shows.
 */
export function gpuCrashWindows(windows: { isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean }[]): string {
  if (!windows.length) return 'no windows';
  const states = windows.map((window, index) => `w${index + 1} ${[window.isMinimized() ? 'minimized' : window.isVisible() ? 'visible' : 'hidden', ...(window.isFocused() ? ['focused'] : [])].join(' ')}`);
  const text = states.join('; '); return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
/** Crash dumps kept this long; Trace never uploads them, so older ones only fill the disk. */
export const CRASH_DUMP_DAYS = 14;
/**
 * Removes crash dumps older than `days` from Crashpad's folders under `root` (reports on Windows, completed and pending
 * on a Mac), in the background. Returns how many were removed; unreadable files and folders are skipped.
 */
export async function pruneCrashDumps(root: string, days = CRASH_DUMP_DAYS, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const folder of ['reports', 'completed', 'pending'].map((name) => path.join(root, name))) {
    let names: string[] = []; try { names = await fs.promises.readdir(folder); } catch { continue; }
    for (const name of names) {
      const file = path.join(folder, name);
      try { const info = await fs.promises.lstat(file); if (info.isFile() && now - info.mtimeMs > days * 86_400_000) { await fs.promises.rm(file, { force: true }); removed++; } } catch { /* Next file. */ }
    }
  }
  return removed;
}
/** A main-process stall this long or longer is recorded (ms). */
export const STALL_MS = 250;
/** A longer "stall" is a computer that slept with Trace open. */
const SLEEP_MS = 60_000;
/** The event loop's longest delay since the last read, in ms. */
export interface LoopDelay { read(): number; stop(): void }
/** perf_hooks' native sampler (a timer every 20 ms, outside JavaScript), read and reset once a second. */
function loopDelay(): LoopDelay {
  const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
  return { read: () => { const ms = histogram.max / 1e6; histogram.reset(); return ms; }, stop: () => histogram.disable() };
}
/**
 * Says which job the main process was running when it stalled. Jobs are labelled by name only (an IPC channel and
 * action, "hub-tick"), never with what they were given.
 */
export class MainStalls {
  private last: string | null = null;
  private longest: { label: string; ms: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private delay: LoopDelay | null = null;
  constructor(private now: () => number = () => performance.now()) {}
  /** Runs `run` as `label`. Its synchronous part is timed; an async job's steps after its first await are not. */
  timed<T>(label: string, run: () => T): T {
    const started = this.now(); this.last = label;
    try { return run(); } finally { const ms = this.now() - started; if (ms > (this.longest?.ms ?? 0)) this.longest = { label, ms }; }
  }
  /** One sample: the longest the loop was blocked since the last one. A stall names the job that took most of it, or the last one before it. */
  sample(blocked: number, report: (ms: number, job: string | null) => void) {
    const longest = this.longest; this.longest = null;
    if (!(blocked >= STALL_MS) || blocked > SLEEP_MS) return;
    const job = longest && longest.ms >= blocked / 2 ? `${longest.label} ${Math.round(longest.ms)} ms` : this.last ? `after ${this.last}` : null;
    report(Math.round(blocked), job && job.slice(0, 80));
  }
  /** Samples about once a second until stop(). */
  start(report: (ms: number, job: string | null) => void, delay: LoopDelay = loopDelay(), every = 1000) {
    this.stop(); this.delay = delay;
    this.timer = setInterval(() => this.sample(delay.read(), report), every); this.timer.unref?.();
  }
  /** Drops what was measured so far: the computer is going to sleep or just woke up. */
  skip() { this.delay?.read(); this.longest = null; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.delay?.stop(); this.delay = null; }
}
/** The main process's one stall sampler (started by main.ts). */
export const mainStalls = new MainStalls();
/** Labels a main-process job for the stall record: `timed('hub-tick', () => …)`. */
export function timed<T>(label: string, run: () => T): T { return mainStalls.timed(label, run); }
/** At most this many of the window's own reports a minute, so a window in trouble cannot push every other stall out. */
const WINDOW_REPORTS_PER_MINUTE = 10;
/** Stalls found within this time are written together, after the stall rather than during it. */
const STALL_WRITE_DELAY = 1000;
/** Only lifecycle metadata is recorded: no prompts, terminal output, account
 * identifiers, environment values or raw exception messages/stacks. */
export class HostHealth {
  private windowReports: number[] = [];
  private state: z.infer<typeof schema> = { cleanShutdown: false, events: [], stalls: [] };
  private previousShutdown: HostHealthReport['previousShutdown'] = 'unknown';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private root: string) {
    try {
      const previous = load(root, 'host-health.json', schema, { cleanShutdown: true, events: [] });
      this.previousShutdown = previous.events.length ? previous.cleanShutdown ? 'clean' : 'unclean' : 'unknown';
      this.state.events = previous.events; this.state.stalls = previous.stalls ?? [];
    } catch { /* Health reporting cannot prevent the app from starting. */ }
    this.record('host-start');
  }
  record(event: string, reason: string | null = null, exitCode: number | null = null) {
    const parsed = entry.safeParse({ time: new Date().toISOString(), event, reason, exitCode }); if (!parsed.success) return;
    this.state.events = [...this.state.events, parsed.data].slice(-100);
    this.write();
  }
  /** A stall or a GPU process death, in its own list of STALL_LIMIT. Written a second later, with any others found by then. */
  stall(side: StallRecord['side'], kind: string, ms: number | null = null, job: string | null = null) {
    const parsed = stallEntry.safeParse({ time: new Date().toISOString(), side, kind, ms, job }); if (!parsed.success) return;
    this.state.stalls = [...this.state.stalls ?? [], parsed.data].slice(-STALL_LIMIT);
    if (!this.writeTimer) { this.writeTimer = setTimeout(() => { this.writeTimer = null; this.write(); }, STALL_WRITE_DELAY); this.writeTimer.unref?.(); }
  }
  /** What the window reported about itself (untrusted): at most WINDOW_REPORTS_PER_MINUTE a minute. */
  recordFromWindow(kind: string, ms: number | null = null, detail: string | null = null, now = Date.now()): boolean {
    // A window "stall" longer than SLEEP_MS is the computer sleeping, as on the main side.
    if (kind === 'stall' && ms !== null && ms > SLEEP_MS) return false;
    this.windowReports = this.windowReports.filter((at) => now - at < 60000);
    if (this.windowReports.length >= WINDOW_REPORTS_PER_MINUTE) return false;
    this.windowReports.push(now); this.stall('window', kind, ms, detail); return true;
  }
  private write() {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    try { save(this.root, 'host-health.json', this.state); } catch { /* A read-only diagnostics store must not close live sessions. */ }
  }
  close() { this.state.cleanShutdown = true; this.record('host-stop'); }
  report(): HostHealthReport & { stalls: StallRecord[] } { return { previousShutdown: this.previousShutdown, events: structuredClone(this.state.events), stalls: structuredClone(this.state.stalls ?? []) }; }
}
