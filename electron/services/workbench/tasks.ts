import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskAudit, TaskDetail, TaskSent, TaskWatch, TaskWarning } from '../../../shared/workbench';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostEnvironment } from '../cli/discovery';
import { readOnlyGitOptions } from '../repository/git-safety';
import type { Verification } from './verification';
import { load, save, directory } from './local-store';
import { HubError } from '../cli/engine-adapter';
import { changedFiles } from './repository-state';
import { promptMark, SIGNAL_INSTRUCTION } from '../../../shared/task-signal';
const scope = z.string().trim().min(1).max(300).refine((s) => !s.includes('\\') && !s.startsWith('/') && !s.replace(/\/$/, '').split('/').some((part) => part === '..' || part === '.' || part === '') && !s.includes('\0') && !/^[a-z]:/i.test(s) && !/[?\[\]]/.test(s) && (!s.includes('*') || s === '*' || s === '**' || s.endsWith('/**') && !s.slice(0, -3).includes('*')), 'Use relative paths such as src/** or README.md.');
/** A changed file as it was when a task was sent: its size and when it last changed, so later edits to it show. */
const signature = z.string().max(60);
/** designRef linked a task to an annotation in the removed Design workspace. Saved tasks may still carry it, so it is read and kept, but never set. */
const task = z.object({ id: z.uuid(), designRef: z.object({ snapshotId: z.uuid(), annotationId: z.uuid() }).strict().optional(), title: z.string().trim().min(1).max(150), details: z.string().max(2000).optional(), directory: z.string().max(4096), sessionId: z.uuid().nullable(), scope: z.array(scope).min(1).max(30), status: z.enum(['queued', 'active', 'review', 'done']), notes: z.string().max(2000), verificationId: z.uuid().nullable(), createdAt: z.iso.datetime(), sentAt: z.iso.datetime().optional(), baseline: z.record(z.string().max(4096), signature).optional(), outcome: z.enum(['finished', 'quiet', 'stopped', 'failed', 'blocked', 'unconfirmed']).optional(), outcomeNote: z.string().max(500).optional(), sendId: z.string().regex(/^t-[0-9a-f]{8}$/).optional(), pullRequest: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/).optional() }).strict();
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('task-list') }).strict(), z.object({ action: z.literal('task-audit') }).strict(), z.object({ action: z.literal('task-watch') }).strict(),
  z.object({ action: z.literal('task-send'), id: z.uuid() }).strict(), z.object({ action: z.literal('task-detail'), id: z.uuid() }).strict(), z.object({ action: z.literal('task-pr'), id: z.uuid(), url: task.shape.pullRequest.unwrap() }).strict(), z.object({ action: z.literal('task-remove'), id: z.uuid() }).strict(), z.object({ action: z.literal('task-status'), id: z.uuid(), status: task.shape.status, outcome: task.shape.outcome, outcomeNote: task.shape.outcomeNote }).strict(),
  task.omit({ createdAt: true, id: true, sentAt: true, baseline: true, designRef: true, outcome: true, outcomeNote: true, pullRequest: true, sendId: true }).extend({ action: z.literal('task-save'), id: z.uuid().optional() }).strict()]);
export function matchesScope(file: string, patterns: string[]) { return patterns.some((pattern) => pattern === '**' || pattern === '*' || pattern.endsWith('/**') ? pattern === '**' || pattern === '*' || file.startsWith(pattern.slice(0, -2)) : file === pattern || file.startsWith(pattern.replace(/\/$/, '') + '/')); }
export function scopesOverlap(a: string[], b: string[]) { return a.some((left) => b.some((right) => matchesScope(left.replace(/\/\*\*$/, '/scope-file'), [right]) || matchesScope(right.replace(/\/\*\*$/, '/scope-file'), [left]))); }
/** A task limited to some files, not the whole project. */
export const limited = (task: Pick<Task, 'scope'>) => !task.scope.some((pattern) => pattern === '**' || pattern === '*');
/** What a task's agent is asked, on one line (a terminal sends on Enter). */
export function taskPrompt(task: Pick<Task, 'title' | 'details' | 'scope' | 'sendId'>) {
  const details = task.details?.trim().replace(/\s*\n\s*/g, ' ');
  return [promptMark(task), details, limited(task) ? `Change only these files or folders: ${task.scope.join(', ')}. If the task needs others, ask me first.` : null, SIGNAL_INSTRUCTION].filter(Boolean).join(' ');
}


export class Tasks {
  constructor(private root: string, private verification: Verification) {}
  list(): Task[] { return load(this.root, 'tasks.json', z.array(task).max(200), []); }
  private write(tasks: Task[]) { save(this.root, 'tasks.json', tasks); }
  async execute(input: unknown): Promise<Task[] | Task | TaskAudit | TaskSent | TaskWatch | TaskDetail | null> {
    const request = schema.parse(input); const tasks = this.list(); if (request.action === 'task-list') return tasks;
    if (request.action === 'task-save') {
      if (!request.id && tasks.length >= 200) throw new HubError('TASK_LIMIT', 'Up to 200 tasks are kept. Remove finished ones to add more.');
      if (request.id && !tasks.some((t) => t.id === request.id)) throw new HubError('TASK_MISSING', 'This task is no longer here.');
      const cwd = directory(request.directory);
      if (request.verificationId) { const check = this.verification.data().results.find((r) => r.id === request.verificationId); if (!check?.passed || path.resolve(check.directory) !== cwd) throw new HubError('TASK_CHECK', 'Select a passing verification result for this project.'); }
      const previous = tasks.find((t) => t.id === request.id);
      const designRef = previous?.designRef;
      const value: Task = { ...(designRef ? { designRef } : {}), id: request.id ?? randomUUID(), title: request.title, ...(request.details?.trim() ? { details: request.details.trim() } : {}), directory: cwd, sessionId: request.sessionId, scope: request.scope, status: request.status, notes: request.notes, verificationId: request.verificationId, createdAt: previous?.createdAt ?? new Date().toISOString(), ...(previous?.sentAt ? { sentAt: previous.sentAt } : {}), ...(previous?.baseline ? { baseline: previous.baseline } : {}), ...(previous?.sendId ? { sendId: previous.sendId } : {}), ...(previous?.outcome && previous.status === request.status ? { outcome: previous.outcome, ...(previous.outcomeNote ? { outcomeNote: previous.outcomeNote } : {}) } : {}), ...(previous?.pullRequest ? { pullRequest: previous.pullRequest } : {}) };
      this.write([...tasks.filter((t) => t.id !== value.id), value]); return value;
    }
    if (request.action === 'task-remove') { this.write(tasks.filter((t) => t.id !== request.id)); return null; }
    if (request.action === 'task-status' || request.action === 'task-send') {
      const current = tasks.find((t) => t.id === request.id); if (!current) throw new HubError('TASK_MISSING', 'This task is no longer here.');
      let value: Task;
      if (request.action === 'task-status') { const { outcome: _old, outcomeNote: _note, ...rest } = current; value = { ...rest, status: request.status, ...(request.outcome ? { outcome: request.outcome, ...(request.outcomeNote ? { outcomeNote: request.outcomeNote } : {}) } : {}) }; }
      else {
        if (!current.sessionId) throw new HubError('TASK_CHANNEL', 'Choose the channel to give this task to first.');
        // What was already changed when the task was sent is not this task's work.
        const files = await changedFiles(current.directory);
        const { outcome: _old, outcomeNote: _note, ...rest } = current; // A new id each send, in the prompt, so its replies are told apart from an earlier send's or another task's.
        value = { ...rest, status: 'active', sentAt: new Date().toISOString(), sendId: `t-${randomUUID().replace(/-/g, '').slice(0, 8)}`, baseline: Object.fromEntries(files ?? []) };
      }
      this.write([...tasks.filter((t) => t.id !== value.id), value]);
      return request.action === 'task-send' ? { task: value, prompt: taskPrompt(value) } : value;
    }
    if (request.action === 'task-watch') return this.watch(tasks);
    // A pull request belongs to the one task the person chose when opening it (Changes → Delivery), never to a folder's tasks.
    if (request.action === 'task-pr') { const current = tasks.find((t) => t.id === request.id); if (!current) throw new HubError('TASK_MISSING', 'This task is no longer here.'); const value = { ...current, pullRequest: request.url }; this.write([...tasks.filter((t) => t.id !== value.id), value]); return value; }
    if (request.action === 'task-detail') {
      const current = tasks.find((t) => t.id === request.id); if (!current) throw new HubError('TASK_MISSING', 'This task is no longer here.');
      const git = async (args: string[]) => { try { const safe = await readOnlyGitOptions(current.directory); return (await promisify(execFile)('git', [...safe, '-C', current.directory, ...args], { timeout: 8000, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 65536 })).stdout.trim() || null; } catch { return null; } };
      const [branch, head] = await Promise.all([git(['symbolic-ref', '--short', '-q', 'HEAD']), git(['rev-parse', '--short', '-q', '--verify', 'HEAD'])]);
      return { branch, head };
    }
    const active = tasks.filter((t) => t.status !== 'done'); const report: TaskAudit = { tasks, overlaps: [], changes: [], warnings: ['Git changes can come from humans, either agent, or earlier work. This audit identifies scope conflicts, not edit authorship or enforced permissions.'] };
    for (let i = 0; i < active.length; i++) for (const other of active.slice(i + 1)) if (active[i].directory === other.directory && scopesOverlap(active[i].scope, other.scope)) report.overlaps.push(`${active[i].title} ↔ ${other.title}`);
    for (const cwd of [...new Set(active.map((t) => t.directory))]) {
      const files = await changedFiles(cwd); if (!files) { report.warnings.push(`Git status unavailable: ${cwd}`); continue; }
      for (const relative of files.keys()) { const covered = active.filter((t) => t.directory === cwd && matchesScope(relative, t.scope)); report.changes.push({ directory: cwd, path: relative, tasks: covered.map((t) => t.title), outsideScope: !covered.length }); }
    }
    return report;
  }

  /**
   * What the open tasks' agents changed since each was sent (files whose Git change is new or edited again), and what
   * needs the person: a change outside a task's files, by the only agent working in that project; one file in two
   * tasks' work; two limited tasks given overlapping files. Git cannot say who changed a file, so a change is a task's
   * when that task was the only one working in its project then.
   */
  async watch(tasks: Task[]): Promise<TaskWatch> {
    const open = tasks.filter((t) => t.sentAt && (t.status === 'active' || t.status === 'review'));
    const changed: Record<string, string[]> = {}; const warnings: TaskWarning[] = [];
    for (const cwd of [...new Set(open.map((t) => t.directory))]) {
      const here = open.filter((t) => t.directory === cwd); const files = await changedFiles(cwd); if (!files) continue;
      for (const item of here) changed[item.id] = [...files].filter(([file, mark]) => item.baseline?.[file] !== mark).map(([file]) => file).slice(0, 200);
      const working = here.filter((t) => t.status === 'active');
      if (working.length === 1 && limited(working[0])) {
        const outside = changed[working[0].id].filter((file) => !matchesScope(file, working[0].scope));
        if (outside.length) warnings.push({ taskIds: [working[0].id], text: `Changed ${outside.length === 1 ? outside[0] : `${outside.length} files`} outside this task's files${outside.length > 1 ? ` (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '…' : ''})` : ''}.` });
      }
      for (let i = 0; i < here.length; i++) for (const other of here.slice(i + 1)) {
        const shared = changed[here[i].id].filter((file) => changed[other.id].includes(file) && matchesScope(file, here[i].scope) && matchesScope(file, other.scope));
        if (shared.length && (limited(here[i]) || limited(other))) warnings.push({ taskIds: [here[i].id, other.id], text: `Both tasks' work includes ${shared.length === 1 ? shared[0] : `${shared.length} of the same files`}.` });
        else if (limited(here[i]) && limited(other) && scopesOverlap(here[i].scope, other.scope)) warnings.push({ taskIds: [here[i].id, other.id], text: 'These tasks were given overlapping files.' });
      }
      if (working.length > 1 && working.filter((t) => !limited(t)).length > 1) warnings.push({ taskIds: working.filter((t) => !limited(t)).map((t) => t.id), text: 'Several agents are working in this project with no file limits, so Trace cannot tell their changes apart. Give each task its files to catch clashes.' });
    }
    return { changed, warnings };
  }
}
