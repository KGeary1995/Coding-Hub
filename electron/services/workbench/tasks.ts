import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskAudit } from '../../../shared/workbench';
import type { Verification } from './verification';
import { load, save, directory } from './local-store';
import { HubError } from '../cli/engine-adapter';
const scope = z.string().trim().min(1).max(300).refine((s) => !s.includes('\\') && !s.startsWith('/') && !s.split('/').includes('..') && !s.includes('\0') && !/^[a-z]:/i.test(s) && !/[?\[\]]/.test(s) && (!s.includes('*') || s === '*' || s === '**' || s.endsWith('/**') && !s.slice(0, -3).includes('*')), 'Use relative paths such as src/** or README.md.');
const task = z.object({ id: z.uuid(), designRef: z.object({ snapshotId: z.uuid(), annotationId: z.uuid() }).strict().optional(), title: z.string().trim().min(1).max(150), directory: z.string().max(4096), sessionId: z.uuid().nullable(), scope: z.array(scope).min(1).max(30), status: z.enum(['queued', 'active', 'review', 'done']), notes: z.string().max(2000), verificationId: z.uuid().nullable(), createdAt: z.iso.datetime() }).strict();
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('task-list') }).strict(), z.object({ action: z.literal('task-audit') }).strict(), task.omit({ createdAt: true, id: true }).extend({ action: z.literal('task-save'), id: z.uuid().optional() }).strict()]);
export function matchesScope(file: string, patterns: string[]) { return patterns.some((pattern) => pattern === '**' || pattern === '*' || pattern.endsWith('/**') ? pattern === '**' || pattern === '*' || file.startsWith(pattern.slice(0, -2)) : file === pattern || file.startsWith(pattern.replace(/\/$/, '') + '/')); }
export function scopesOverlap(a: string[], b: string[]) { return a.some((left) => b.some((right) => matchesScope(left.replace(/\/\*\*$/, '/scope-file'), [right]) || matchesScope(right.replace(/\/\*\*$/, '/scope-file'), [left]))); }
export class Tasks {
  constructor(private root: string, private verification: Verification) {}
  list(): Task[] { return load(this.root, 'tasks.json', z.array(task).max(200), []); }
  async execute(input: unknown): Promise<Task[] | Task | TaskAudit> {
    const request = schema.parse(input); const tasks = this.list(); if (request.action === 'task-list') return tasks;
    if (request.action === 'task-save') {
      if (!request.id && tasks.length >= 200) throw new HubError('TASK_LIMIT', 'Up to 200 tasks are supported.');
      if (request.id && !tasks.some((t) => t.id === request.id)) throw new HubError('TASK_MISSING', 'This task is unavailable.');
      const cwd = directory(request.directory);
      if (request.status === 'done' && !request.notes.trim()) throw new HubError('TASK_REVIEW', 'Record completion and review evidence before marking the task done.');
      if (request.verificationId) { const check = this.verification.data().results.find((r) => r.id === request.verificationId); if (!check?.passed || path.resolve(check.directory) !== cwd) throw new HubError('TASK_CHECK', 'Select a passing verification result for this project.'); }
      const value: Task = { ...(request.designRef ? { designRef: request.designRef } : {}), id: request.id ?? randomUUID(), title: request.title, directory: cwd, sessionId: request.sessionId, scope: request.scope, status: request.status, notes: request.notes, verificationId: request.verificationId, createdAt: tasks.find((t) => t.id === request.id)?.createdAt ?? new Date().toISOString() };
      save(this.root, 'tasks.json', [...tasks.filter((t) => t.id !== value.id), value]); return value;
    }
    const active = tasks.filter((t) => t.status !== 'done'); const report: TaskAudit = { tasks, overlaps: [], changes: [], warnings: ['Git changes can come from humans, either agent, or earlier work. This audit identifies scope conflicts, not edit authorship or enforced permissions.'] };
    for (let i = 0; i < active.length; i++) for (const other of active.slice(i + 1)) if (active[i].directory === other.directory && scopesOverlap(active[i].scope, other.scope)) report.overlaps.push(`${active[i].title} ↔ ${other.title}`);
    for (const cwd of [...new Set(active.map((t) => t.directory))]) try {
      const command = promisify(execFile); const { stdout: repository } = await command('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 8000, maxBuffer: 65536 });
      const { stdout } = await command('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { timeout: 8000, maxBuffer: 1048576 });
      const entries = stdout.split('\0'); const prefix = path.relative(repository.trim(), cwd).replace(/\\/g, '/');
      for (let i = 0; i < entries.length; i++) { if (!entries[i]) continue; const name = entries[i].slice(3); if (/[RC]/.test(entries[i].slice(0, 2))) i++; const relative = prefix && name.startsWith(prefix + '/') ? name.slice(prefix.length + 1) : name; const covered = active.filter((t) => t.directory === cwd && matchesScope(relative, t.scope)); report.changes.push({ directory: cwd, path: relative, tasks: covered.map((t) => t.title), outsideScope: !covered.length }); if (report.changes.length >= 500) break; }
    } catch { report.warnings.push(`Git status unavailable: ${cwd}`); }
    return report;
  }
}
