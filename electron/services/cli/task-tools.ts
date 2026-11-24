import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Task } from '../../../shared/workbench';
import { HubError } from './engine-adapter';

/**
 * Task tools (served by the channel tools' MCP server, behind their own setting): an agent can read its project's tasks,
 * add one to To do, move one to Working or Ready for review, and add a note. It cannot delete a task, change its title or
 * details, or move it to Done: those are the person's. Its project is the folder its run works in.
 */
export interface TaskToolsHost {
  enabled(): boolean;
  /** The folder a run works in. */
  folderOf(runId: string): string | null;
  list(): Task[];
  add(fields: { title: string; details?: string; directory: string; notes: string }): Promise<Task>;
  status(id: string, status: Task['status']): Promise<Task>;
  /** Replaces a task's notes (the tool appends; Tasks keeps the 2000-character limit). */
  notes(id: string, notes: string): Task;
  /** A task changed: the window reads the board again. */
  changed(): void;
}
/** Who asks: its run, its channel's session, how its notes are signed (CH2, or Agent for a Round Table seat) and its channel's name. */
export interface TaskCaller { runId: string; sessionId: string | null; label: string; name: string | null }
export type TaskAction = 'task-list' | 'task-add' | 'task-update';

const listSchema = z.object({ status: z.enum(['queued', 'active', 'review', 'done']).optional() }).strict();
const addSchema = z.object({ title: z.string().trim().min(1).max(150), details: z.string().trim().max(2000).optional() }).strict();
const updateSchema = z.object({ id: z.uuid(), status: z.enum(['active', 'review', 'done']).optional(), note: z.string().trim().min(1).max(1000).optional() }).strict().refine((request) => request.status || request.note, 'Give a status, a note, or both.');

/** The folder as the file system names it, so a run's cwd and a task's saved (real) folder compare alike. */
const real = (folder: string) => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
/** Whether `folder` is `directory` or inside it. */
export function inProject(folder: string, directory: string) { const relative = path.relative(real(directory), real(folder)); return relative === '' || relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative); }
const shown = (task: Task) => ({ id: task.id, title: task.title, ...(task.details ? { details: task.details } : {}), status: task.status, notes: task.notes, ...(task.outcome ? { outcome: task.outcome } : {}), createdAt: task.createdAt });

export async function runTaskTool(host: TaskToolsHost, caller: TaskCaller, action: TaskAction, body: unknown): Promise<unknown> {
  const folder = host.folderOf(caller.runId); if (!folder) throw new HubError('TASK_TOOLS_FOLDER', 'Trace cannot tell which project this channel works in.');
  const mine = () => host.list().filter((task) => inProject(folder, task.directory));
  if (action === 'task-list') { const request = listSchema.parse(body); return { folder, tasks: mine().filter((task) => !request.status || task.status === request.status).map(shown) }; }
  if (action === 'task-add') {
    const request = addSchema.parse(body);
    const task = await host.add({ title: request.title, ...(request.details ? { details: request.details } : {}), directory: folder, notes: caller.name ? `Added by the agent in ${caller.label} (${caller.name}).` : 'Added by an agent.' });
    host.changed(); return { task: shown(task) };
  }
  const request = updateSchema.parse(body);
  // Another project's task reads as missing: an agent learns nothing of tasks outside its own folder.
  const task = mine().find((item) => item.id === request.id); if (!task) throw new HubError('TASK_TOOLS_MISSING', 'There is no such task in this channel\'s project. list_tasks lists them.');
  if (request.status === 'done') throw new HubError('TASK_TOOLS_DONE', 'Only the person moves a task to Done. Move it to review instead, with a note saying what to check.');
  if (request.status && task.status === 'done') throw new HubError('TASK_TOOLS_DONE', 'This task is done. Only the person reopens it.');
  const notes = request.note ? `${task.notes ? `${task.notes}\n` : ''}${caller.label}: ${request.note}` : null;
  if (notes && notes.length > 2000) throw new HubError('TASK_TOOLS_NOTES_FULL', `That note does not fit: a task's notes hold 2000 characters, and ${Math.max(0, 2000 - notes.length + request.note!.length)} are left. Keep the note shorter, or tell the person.`);
  let value = task;
  if (notes) value = host.notes(task.id, notes);
  if (request.status && request.status !== task.status) value = await host.status(task.id, request.status);
  host.changed(); return { task: shown(value) };
}
