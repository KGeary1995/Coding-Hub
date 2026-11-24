import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScheduledJobData, Task } from '../../../shared/workbench';
import type { ScheduledRunRequest } from '../../../shared/remote';
import { dueRun, MAX_JOBS, nextRun, previousRun, ScheduledJobs, TICK_MS, type JobHost } from './scheduled-jobs';

// Schedules are in local time: these tests run in a zone with daylight saving (2026: forward on 8 March, back on 1 November).
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-jobs-')); roots.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute);

/** A Trace for the scheduler: tasks in memory, channels that start when asked (or as `open` says), every call recorded. */
function host(overrides: Partial<JobHost> = {}) {
  const tasks: Task[] = []; const opened: Omit<ScheduledRunRequest, 'requestId'>[] = []; const running = new Set<string>(); const full: (string | undefined)[] = [];
  const value: JobHost & { tasks: Task[]; opened: typeof opened; running: Set<string>; full: typeof full; isFull: boolean } = {
    tasks, opened, running, full, isFull: false,
    ready: () => true, held: () => null,
    channelsFull: (replace) => { full.push(replace); return value.isFull; },
    channelRunning: (id) => running.has(id),
    task: (id) => tasks.find((task) => task.id === id),
    addTask: async (fields) => { const task: Task = { id: randomUUID(), ...fields, scope: ['**'], status: 'queued', verificationId: null, createdAt: new Date().toISOString() }; tasks.push(task); return task; },
    noteTask: (id, note) => { const task = tasks.find((item) => item.id === id)!; task.notes = [task.notes, note].filter(Boolean).join('\n'); },
    open: async (request) => { opened.push(request); running.add(request.sessionId); },
    changed: () => {},
    ...overrides,
  };
  return value;
}
const save = (jobs: ScheduledJobs, root: string, fields: Record<string, unknown> = {}) => jobs.execute({ action: 'job-save', name: 'Update dependencies and run the tests', directory: root, engine: 'claude', prompt: 'Update the dependencies, then run the tests.', schedule: { kind: 'daily', time: '08:00' }, ...fields }) as Promise<ScheduledJobData>;

describe('when a scheduled job runs', () => {
  it('every day at a time: later today, or tomorrow once it has passed', () => {
    const plan = { kind: 'daily', time: '08:00' } as const;
    expect(nextRun(plan, local(3, 10, 7))).toEqual(local(3, 10, 8));
    expect(nextRun(plan, local(3, 10, 8))).toEqual(local(3, 11, 8));
    expect(previousRun(plan, local(3, 10, 7, 59))).toEqual(local(3, 9, 8));
    expect(previousRun(plan, local(3, 10, 8))).toEqual(local(3, 10, 8));
  });
  it('on chosen weekdays, skipping the others', () => {
    const plan = { kind: 'weekdays' as const, time: '09:30', days: [1, 3, 5] };
    // Friday 27 November 2026, after its run: next is Monday.
    expect(nextRun(plan, local(11, 27, 10))).toEqual(local(11, 30, 9, 30));
    expect(nextRun(plan, local(11, 30, 9, 30))).toEqual(local(12, 2, 9, 30));
    expect(previousRun(plan, local(11, 29, 12))).toEqual(local(11, 27, 9, 30));
  });
  it('every N hours of each day, counted from its start time', () => {
    const plan = { kind: 'hours', every: 6, time: '08:15' } as const;
    expect(nextRun(plan, local(5, 4, 3))).toEqual(local(5, 4, 8, 15));
    expect(nextRun(plan, local(5, 4, 20, 30))).toEqual(local(5, 5, 2, 15));
    expect(previousRun(plan, local(5, 4, 2))).toEqual(local(5, 3, 20, 15));
  });
  it('keeps to the local clock across daylight-saving changes', () => {
    const daily = { kind: 'daily', time: '08:00' } as const;
    const spring = nextRun(daily, local(3, 7, 8)); expect(spring.getHours()).toBe(8); expect(spring.getTime() - local(3, 7, 8).getTime()).toBe(23 * 3600_000);
    const autumn = nextRun(daily, local(10, 31, 8)); expect(autumn.getHours()).toBe(8); expect(autumn.getTime() - local(10, 31, 8).getTime()).toBe(25 * 3600_000);
    // 02:30 does not exist on 8 March: that day's run is at 03:30, once.
    expect(nextRun({ kind: 'daily', time: '02:30' }, local(3, 8, 0))).toEqual(new Date(2026, 2, 8, 3, 30));
    // Hourly on 1 November (a 25-hour day): each clock time once, 01:30 included, so 24 runs.
    const hourly = { kind: 'hours', every: 1, time: '00:30' } as const; const runs: Date[] = [];
    for (let at = nextRun(hourly, local(11, 1, 0)); at < local(11, 2, 0); at = nextRun(hourly, at)) runs.push(at);
    expect(runs).toHaveLength(24); expect(runs.map((at) => at.getHours())).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
  });
  it('owes the latest time since it was checked, once; one more than 12 hours ago is missed', () => {
    const plan = { kind: 'daily', time: '08:00' } as const; const checkedAt = local(6, 1, 7).toISOString();
    expect(dueRun({ schedule: plan, paused: false, checkedAt }, local(6, 1, 7, 59))).toBeNull();
    expect(dueRun({ schedule: plan, paused: false, checkedAt }, local(6, 1, 8, 0))).toEqual({ at: local(6, 1, 8), missed: false });
    expect(dueRun({ schedule: plan, paused: false, checkedAt }, local(6, 1, 20, 0))).toEqual({ at: local(6, 1, 8), missed: false });
    expect(dueRun({ schedule: plan, paused: false, checkedAt }, local(6, 1, 20, 1))).toEqual({ at: local(6, 1, 8), missed: true });
    // Closed for days: only the latest is owed, and it is still within 12 hours.
    expect(dueRun({ schedule: plan, paused: false, checkedAt }, local(6, 4, 9))).toEqual({ at: local(6, 4, 8), missed: false });
    expect(dueRun({ schedule: plan, paused: true, checkedAt }, local(6, 4, 9))).toBeNull();
    expect(dueRun({ schedule: plan, paused: false, checkedAt: local(6, 1, 8, 1).toISOString() }, local(6, 1, 20))).toBeNull();
  });
});

describe('scheduled jobs store', () => {
  it('checks what it saves: times, days, hours, the request, the folder and the number of jobs', async () => {
    const root = fixture(); const jobs = new ScheduledJobs(root, host());
    await expect(save(jobs, root, { schedule: { kind: 'daily', time: '25:00' } })).rejects.toThrow();
    await expect(save(jobs, root, { schedule: { kind: 'weekdays', time: '08:00', days: [] } })).rejects.toThrow();
    await expect(save(jobs, root, { schedule: { kind: 'weekdays', time: '08:00', days: [1, 1] } })).rejects.toThrow();
    await expect(save(jobs, root, { schedule: { kind: 'hours', every: 5, time: '08:00' } })).rejects.toThrow();
    await expect(save(jobs, root, { prompt: '   ' })).rejects.toThrow();
    await expect(save(jobs, root, { engine: 'shell' })).rejects.toThrow();
    await expect(save(jobs, root, { directory: 'relative/folder' })).rejects.toMatchObject({ code: 'PROJECT_PATH' });
    const saved = await save(jobs, root, { engine: 'gemini', schedule: { kind: 'hours', every: 4, time: '01:00' } });
    expect(saved.jobs).toHaveLength(1); expect(saved.jobs[0]).toMatchObject({ engine: 'gemini', paused: false, running: false, directory: fs.realpathSync(root) });
    for (let index = 1; index < MAX_JOBS; index++) await save(jobs, root);
    await expect(save(jobs, root)).rejects.toMatchObject({ code: 'JOB_LIMIT' });
    // An edit keeps the job's place and id.
    const edited = await save(jobs, root, { id: saved.jobs[0].id, name: 'Nightly tests' });
    expect(edited.jobs).toHaveLength(MAX_JOBS); expect(edited.jobs[0]).toMatchObject({ id: saved.jobs[0].id, name: 'Nightly tests' });
    await expect(jobs.execute({ action: 'job-delete', id: randomUUID() })).rejects.toMatchObject({ code: 'JOB_MISSING' });
  });
  it('refuses a damaged file without overwriting it', async () => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'scheduled-jobs.json'), '{"jobs":[{"id":"x"}]}');
    await expect(new ScheduledJobs(root, host()).execute({ action: 'job-list' })).rejects.toMatchObject({ code: 'LOCAL_DATA' });
    expect(fs.readFileSync(path.join(root, 'scheduled-jobs.json'), 'utf8')).toBe('{"jobs":[{"id":"x"}]}');
  });
});

describe('scheduled runs', () => {
  it('at its time, makes a task with the new channel and asks the window to open it (a Gemini job)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); const trace = host(); const jobs = new ScheduledJobs(root, trace);
    await save(jobs, root, { engine: 'gemini', name: 'Review the code for bugs', prompt: 'Review the code for bugs.' }); jobs.start();
    await vi.advanceTimersByTimeAsync(TICK_MS); expect(trace.opened).toHaveLength(0);
    vi.setSystemTime(local(7, 6, 8)); await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(trace.opened).toHaveLength(1); const [request] = trace.opened; const [task] = trace.tasks;
    expect(request).toMatchObject({ engine: 'gemini', taskId: task.id, sessionId: task.sessionId, directory: fs.realpathSync(root), title: 'Review the code for bugs' }); expect(request.replace).toBeUndefined();
    expect(task).toMatchObject({ title: 'Review the code for bugs', details: 'Review the code for bugs.', status: 'queued' }); expect(task.notes).toContain('Trace cannot read Gemini’s replies');
    const [job] = jobs.data().jobs; expect(job.lastRun).toMatchObject({ result: 'started', taskId: task.id, sessionId: task.sessionId }); expect(job.running).toBe(true);
    // Once per due time: later ticks the same morning start nothing.
    await vi.advanceTimersByTimeAsync(TICK_MS * 4); expect(trace.opened).toHaveLength(1); jobs.stop();
  });
  it('does not start a run while the last one is still going, and says so', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); let release = () => {};
    const trace = host(); trace.open = (request) => new Promise<void>((resolve) => { trace.opened.push(request); trace.running.add(request.sessionId); if (trace.opened.length === 1) release = resolve; else resolve(); });
    const jobs = new ScheduledJobs(root, trace); const { jobs: [saved] } = await save(jobs, root, { schedule: { kind: 'hours', every: 1, time: '00:00' } });
    vi.setSystemTime(local(7, 6, 8)); const first = jobs.tick();
    // Opening: it counts as a long job (updates and backups wait), and Run now refuses.
    for (let step = 0; step < 50 && !trace.opened.length; step++) await Promise.resolve();
    expect(trace.opened).toHaveLength(1); expect(jobs.running).toBe(true);
    await expect(jobs.execute({ action: 'job-run', id: saved.id })).rejects.toMatchObject({ code: 'JOB_BUSY' });
    release(); await first; expect(jobs.running).toBe(false);
    // Its task is being worked on in its running channel: the next hour's run is skipped.
    trace.tasks[0].status = 'active'; vi.setSystemTime(local(7, 6, 9)); await jobs.tick();
    expect(trace.opened).toHaveLength(1); expect(jobs.data().jobs[0].lastRun).toMatchObject({ result: 'skipped', note: 'Skipped: the last run was still going.' });
    // The agent finished (Ready for review): the next run starts, closing the last run's channel first.
    trace.tasks[0].status = 'review'; vi.setSystemTime(local(7, 6, 10)); await jobs.tick();
    expect(trace.opened).toHaveLength(2); expect(trace.opened[1].replace).toBe(trace.opened[0].sessionId); expect(trace.full.at(-1)).toBe(trace.opened[0].sessionId);
  });
  it('with every channel taken, skips the run and notes it on a task', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); const trace = host(); trace.isFull = true; const jobs = new ScheduledJobs(root, trace);
    await save(jobs, root, { engine: 'codex' }); vi.setSystemTime(local(7, 6, 8, 1)); await jobs.tick();
    expect(trace.opened).toHaveLength(0); expect(trace.tasks).toHaveLength(1);
    expect(trace.tasks[0]).toMatchObject({ sessionId: null, status: 'queued' }); expect(trace.tasks[0].notes).toContain('all 8 channels were in use');
    expect(jobs.data().jobs[0].lastRun).toMatchObject({ result: 'skipped', taskId: trace.tasks[0].id }); expect(jobs.data().jobs[0].running).toBe(false);
  });
  it('records why a channel did not open, on the run and its task', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); const { HubError } = await import('../cli/engine-adapter');
    const trace = host({ open: async () => { throw new HubError('REMOTE_CONTROL', 'Claude Code is not installed.'); } }); const jobs = new ScheduledJobs(root, trace);
    await save(jobs, root); vi.setSystemTime(local(7, 6, 8)); await jobs.tick();
    expect(jobs.data().jobs[0].lastRun).toMatchObject({ result: 'failed', note: 'Did not start: Claude Code is not installed.' }); expect(trace.tasks[0].notes).toContain('It did not start: Claude Code is not installed.');
  });
  it('runs a time missed while Trace was closed once if within 12 hours, otherwise says it was missed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); const trace = host(); const jobs = new ScheduledJobs(root, trace);
    await save(jobs, root);
    // Trace opens again at 21:00: 08:00 was 13 hours ago.
    vi.setSystemTime(local(7, 6, 21)); await jobs.tick();
    expect(trace.opened).toHaveLength(0); expect(jobs.data().jobs[0].lastRun).toMatchObject({ result: 'missed', at: local(7, 6, 8).toISOString() });
    // Closed again until 11:30 the next day (two days of runs passed): the latest, 3.5 hours ago, runs once.
    const later = new ScheduledJobs(root, trace); vi.setSystemTime(local(7, 8, 11, 30)); await later.tick(); await later.tick();
    expect(trace.opened).toHaveLength(1); expect(later.data().jobs[0].lastRun).toMatchObject({ result: 'started', at: local(7, 8, 8).toISOString() });
  });
  it('waits while an update or backup holds runs, and while the window is not ready; a paused job does not run', async () => {
    vi.useFakeTimers(); vi.setSystemTime(local(7, 6, 7)); const root = fixture(); let held: string | null = 'Trace is installing an update.'; let ready = false;
    const trace = host({ held: () => held, ready: () => ready }); const jobs = new ScheduledJobs(root, trace); const { jobs: [saved] } = await save(jobs, root);
    vi.setSystemTime(local(7, 6, 8)); await jobs.tick(); ready = true; await jobs.tick(); expect(trace.opened).toHaveLength(0);
    await expect(jobs.execute({ action: 'job-run', id: saved.id })).rejects.toMatchObject({ code: 'JOB_HELD' });
    held = null; await jobs.tick(); expect(trace.opened).toHaveLength(1);
    await jobs.execute({ action: 'job-pause', id: saved.id, paused: true }); expect(jobs.data().jobs[0].nextAt).toBeNull();
    trace.running.clear(); vi.setSystemTime(local(7, 7, 8)); await jobs.tick(); expect(trace.opened).toHaveLength(1);
    // Resumed: the runs passed while paused are not owed.
    await jobs.execute({ action: 'job-pause', id: saved.id, paused: false }); await jobs.tick(); expect(trace.opened).toHaveLength(1);
    expect(jobs.data().jobs[0].nextAt).toBe(local(7, 8, 8).toISOString());
  });
});
