import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobRun, JobSchedule, ScheduledJob, ScheduledJobData, ScheduledJobView, Task } from '../../../shared/workbench';
import type { ScheduledRunRequest } from '../../../shared/remote';
import { MAX_CHANNELS } from '../../../shared/schemas';
import { load, save, directory } from './local-store';
import { HubError } from '../cli/engine-adapter';

/**
 * Scheduled jobs (1.39.0): an agent request that Trace sends by itself at set times ("every morning, update dependencies
 * and run the tests"), while Trace is running. Each run is a task on the Tasks board, in a new channel for that agent in
 * the job's folder; the window opens and starts the channel (ScheduledRunRequest) and sends the task once the agent is
 * ready. A run is not started while the job's previous run is still going. A run missed while Trace was closed runs once
 * when Trace opens again if it was due within the last 12 hours, otherwise it is skipped and said so.
 */
export const MAX_JOBS = 20; export const MISSED_LIMIT_MS = 12 * 60 * 60_000; export const TICK_MS = 30_000;
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
const FILE = 'scheduled-jobs.json';
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 08:30.');
const schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time }).strict(),
  z.object({ kind: z.literal('weekdays'), time, days: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one day.').max(7).refine((days) => new Set(days).size === days.length, 'Choose each day once.') }).strict(),
  z.object({ kind: z.literal('hours'), every: z.number().int().refine((value) => (HOUR_STEPS as readonly number[]).includes(value), 'Choose 1, 2, 3, 4, 6, 8 or 12 hours.'), time }).strict(),
]);
const fields = { name: z.string().trim().min(1).max(150), directory: z.string().min(1).max(4096), engine: z.enum(['claude', 'codex', 'gemini']), prompt: z.string().trim().min(1).max(2000), schedule };
const run = z.object({ at: z.iso.datetime(), result: z.enum(['started', 'skipped', 'missed', 'failed']), note: z.string().max(500), taskId: z.uuid().optional(), sessionId: z.uuid().optional() }).strict();
const job = z.object({ id: z.uuid(), ...fields, paused: z.boolean(), createdAt: z.iso.datetime(), checkedAt: z.iso.datetime(), lastRun: run.optional(), active: z.object({ taskId: z.uuid(), sessionId: z.uuid() }).strict().optional() }).strict();
const dataSchema = z.object({ jobs: z.array(job).max(MAX_JOBS) }).strict();
export const jobRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('job-list') }).strict(),
  z.object({ action: z.literal('job-save'), id: z.uuid().optional(), ...fields }).strict(),
  z.object({ action: z.literal('job-delete'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('job-pause'), id: z.uuid(), paused: z.boolean() }).strict(),
  z.object({ action: z.literal('job-run'), id: z.uuid() }).strict(),
]);

/** The times a schedule runs on one local day, in order. Built from local wall-clock times, so a daylight-saving change moves nothing: an hour that does not exist that day runs an hour later, and one that happens twice runs once. */
function timesOn(plan: JobSchedule, day: Date): Date[] {
  const [hour, minute] = plan.time.split(':').map(Number);
  const at = (h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, minute);
  const hours = plan.kind === 'hours' ? Array.from({ length: 24 / plan.every }, (_, index) => (hour % plan.every) + index * plan.every) : plan.kind === 'weekdays' && !plan.days.includes(day.getDay()) ? [] : [hour];
  return [...new Map(hours.map(at).filter((date) => date.getDate() === day.getDate()).map((date) => [date.getTime(), date])).values()].sort((a, b) => a.getTime() - b.getTime());
}
const dayAfter = (day: Date, step: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + step);
/** The first time the schedule runs after `after`. */
export function nextRun(plan: JobSchedule, after: Date): Date {
  for (let step = 0; step <= 8; step++) { const found = timesOn(plan, dayAfter(after, step)).find((date) => date > after); if (found) return found; }
  throw new Error('A schedule runs at least once a week.');
}
/** The latest time the schedule ran at or before `at`, looking back a week; null when none. */
export function previousRun(plan: JobSchedule, at: Date): Date | null {
  for (let step = 0; step <= 8; step++) { const found = timesOn(plan, dayAfter(at, -step)).filter((date) => date <= at).at(-1); if (found) return found; }
  return null;
}
/**
 * The run a job owes at `now`: the latest scheduled time since it was last checked, once, however many were passed.
 * `missed` when that was more than 12 hours ago (Trace was not running then): it is skipped, not run late.
 */
export function dueRun(item: Pick<ScheduledJob, 'schedule' | 'paused' | 'checkedAt'>, now: Date): { at: Date; missed: boolean } | null {
  if (item.paused) return null;
  const at = previousRun(item.schedule, now); if (!at || at.getTime() <= Date.parse(item.checkedAt)) return null;
  return { at, missed: now.getTime() - at.getTime() > MISSED_LIMIT_MS };
}

/** What the scheduler needs from Trace (main.ts); tests give their own. */
export interface JobHost {
  /** Whether the window can open channels now: the workspace has loaded and the window exists. */
  ready(): boolean;
  /** Why no run may start now (an update installing, a backup), or null. A held run is tried again at the next tick. */
  held(): string | null;
  /** Whether every channel is taken, counting `replace` (a channel the run closes first) as free. */
  channelsFull(replace?: string): boolean;
  channelRunning(sessionId: string): boolean;
  task(id: string): Task | undefined;
  addTask(fields: { title: string; details: string; directory: string; sessionId: string | null; notes: string }): Promise<Task>;
  /** Adds a line to a task's notes. */
  noteTask(id: string, note: string): void;
  /** Asks the window to open and start the run's channel; rejects with why it could not. */
  open(request: Omit<ScheduledRunRequest, 'requestId'>): Promise<void>;
  /** The jobs or tasks changed: the window reads them again. */
  changed(): void;
}
const MISSED_NOTE = 'Trace was not running then, and it was more than 12 hours ago, so this run was skipped.';
const localTime = (date: Date) => date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export class ScheduledJobs {
  private starting = new Set<string>(); private ticking = false; private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private root: string, private host: JobHost, private now = () => new Date()) {}
  /** A run is being opened: updates and backups wait for it (busyJobs, readyForBackup). */
  get running() { return this.starting.size > 0; }
  private jobs(): ScheduledJob[] { return load(this.root, FILE, dataSchema, { jobs: [] }).jobs as ScheduledJob[]; }
  private write(jobs: ScheduledJob[]) { save(this.root, FILE, { jobs }); }
  /** Changes one job as it is saved now (the person may have edited it while a run opened); nothing when it was deleted. */
  private update(id: string, change: (item: ScheduledJob) => ScheduledJob) { const jobs = this.jobs(); if (jobs.some((item) => item.id === id)) this.write(jobs.map((item) => item.id === id ? change(item) : item)); }
  /** The job's last started run is still going: opening, or its channel runs and its task is not sent yet, being worked on, or waiting for the person. */
  busy(item: ScheduledJob): boolean {
    if (this.starting.has(item.id)) return true;
    if (!item.active || !this.host.channelRunning(item.active.sessionId)) return false;
    const task = this.host.task(item.active.taskId);
    return Boolean(task && (task.status === 'queued' || task.status === 'active' && (!task.outcome || task.outcome === 'blocked')));
  }
  private view(item: ScheduledJob): ScheduledJobView { return { ...item, nextAt: item.paused ? null : nextRun(item.schedule, this.now()).toISOString(), running: this.busy(item) }; }
  data(): ScheduledJobData { return { jobs: this.jobs().map((item) => this.view(item)) }; }

  async execute(input: unknown): Promise<ScheduledJobData> {
    const request = jobRequestSchema.parse(input); const jobs = this.jobs(); const now = this.now().toISOString();
    if (request.action === 'job-list') return this.data();
    if (request.action === 'job-save') {
      const previous = jobs.find((item) => item.id === request.id);
      if (request.id && !previous) throw new HubError('JOB_MISSING', 'This scheduled job is no longer here.');
      if (!previous && jobs.length >= MAX_JOBS) throw new HubError('JOB_LIMIT', `Up to ${MAX_JOBS} scheduled jobs are kept. Delete one to add another.`);
      const { action: _action, id: _id, ...given } = request;
      // Checked from now: a time already passed today waits for its next turn instead of running at once.
      const value: ScheduledJob = { ...previous, ...given, directory: directory(request.directory), id: previous?.id ?? randomUUID(), paused: previous?.paused ?? false, createdAt: previous?.createdAt ?? now, checkedAt: now };
      this.write(previous ? jobs.map((item) => item.id === value.id ? value : item) : [...jobs, value]); return this.data();
    }
    const found = jobs.find((item) => item.id === request.id); if (!found) throw new HubError('JOB_MISSING', 'This scheduled job is no longer here.');
    if (request.action === 'job-delete') { this.write(jobs.filter((item) => item.id !== found.id)); return this.data(); }
    // A paused job's runs are not owed when it is resumed: it continues from its next time.
    if (request.action === 'job-pause') { this.update(found.id, (item) => ({ ...item, paused: request.paused, ...(request.paused ? {} : { checkedAt: now }) })); return this.data(); }
    await this.run(found, this.now(), true); return this.data();
  }

  /** Checks the jobs every 30 s from now on. */
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Starts the runs that are due, one after another; records a missed one. */
  async tick() {
    if (this.ticking || !this.host.ready()) return; this.ticking = true;
    try {
      let jobs: ScheduledJob[]; try { jobs = this.jobs(); } catch { return; }
      for (const item of jobs) {
        const now = this.now(); const due = dueRun(item, now); if (!due) continue;
        if (due.missed) { this.update(item.id, (current) => ({ ...current, checkedAt: now.toISOString(), lastRun: { at: due.at.toISOString(), result: 'missed', note: MISSED_NOTE } })); this.host.changed(); continue; }
        if (this.host.held()) continue;
        this.update(item.id, (current) => ({ ...current, checkedAt: now.toISOString() }));
        await this.run(item, due.at);
      }
    } finally { this.ticking = false; }
  }

  /** One run of a job: its task, then its channel. `manual`: Run now, which says why it cannot run instead of recording it. */
  private async run(item: ScheduledJob, at: Date, manual = false): Promise<JobRun> {
    const when = at.toISOString();
    const record = (value: JobRun) => { this.update(item.id, (current) => ({ ...current, lastRun: value })); this.host.changed(); return value; };
    if (this.busy(item)) { if (manual) throw new HubError('JOB_BUSY', 'This job’s last run is still going. Wait for it to finish, or stop its channel first.'); return record({ at: when, result: 'skipped', note: 'Skipped: the last run was still going.' }); }
    const held = this.host.held(); if (held) throw new HubError('JOB_HELD', held);
    // The previous run's channel, once its task is finished (or the channel stopped), makes way for this one; one the
    // person is still answering stays open.
    const previous = item.active && this.host.task(item.active.taskId);
    const replace = item.active && (!previous || previous.status === 'review' || previous.status === 'done' || !this.host.channelRunning(item.active.sessionId)) ? item.active.sessionId : undefined;
    const base = { title: item.name, details: item.prompt, directory: item.directory };
    this.starting.add(item.id);
    try {
      if (this.host.channelsFull(replace)) {
        const task = await this.host.addTask({ ...base, sessionId: null, notes: `Scheduled run at ${localTime(at)} skipped: all ${MAX_CHANNELS} channels were in use. Close a channel, then press Run now under Scheduled jobs.` });
        return record({ at: when, result: 'skipped', note: `Skipped: all ${MAX_CHANNELS} channels were in use.`, taskId: task.id });
      }
      const sessionId = randomUUID(); let task: Task;
      try { task = await this.host.addTask({ ...base, sessionId, notes: `Scheduled run of “${item.name}”, ${localTime(at)}.${item.engine === 'gemini' ? ' Trace cannot read Gemini’s replies: read its channel, then move this task on.' : ''}` }); }
      catch (error) { return record({ at: when, result: 'failed', note: `Did not start: ${error instanceof HubError ? error.message : 'its task could not be saved.'}` }); }
      this.update(item.id, (current) => ({ ...current, active: { taskId: task.id, sessionId } }));
      try { await this.host.open({ taskId: task.id, sessionId, engine: item.engine, directory: task.directory, title: item.name, ...(replace ? { replace } : {}) }); }
      catch (error) {
        const why = error instanceof HubError ? error.message : 'the channel could not be opened.';
        try { this.host.noteTask(task.id, `It did not start: ${why}`); } catch { /* The run's line says it. */ }
        return record({ at: when, result: 'failed', note: `Did not start: ${why}`.slice(0, 500), taskId: task.id });
      }
      return record({ at: when, result: 'started', note: 'Started.', taskId: task.id, sessionId });
    } finally { this.starting.delete(item.id); }
  }
}
