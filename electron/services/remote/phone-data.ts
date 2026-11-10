import type { DayUsage, HubPreferences, MemoryNote } from '../../../shared/hub';
import type { PlanLimits } from '../../../shared/plan-limits';
import type { NativeConversation, Task } from '../../../shared/workbench';
import type { RemoteHistoryItem, RemoteMemory, RemoteTask, RemoteTaskStatus, RemoteUsage } from '../../../shared/remote';
import { DEFAULT_WARNING } from '../alerts';

/** What phones see of Usage, tasks, CLI history and memory: shaped here so no full path ever leaves this computer. */
/** The last part of a folder's path, Windows or POSIX ('' for none): a phone is told a project's name, never where it is. */
export function lastSegment(directory: string | null | undefined) { return (directory ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''; }

/** The board's stored statuses and the names phones use for its columns (To do, Working, Ready for review, Done). */
const TO_PHONE: Record<Task['status'], RemoteTaskStatus> = { queued: 'todo', active: 'working', review: 'review', done: 'done' };
export const FROM_PHONE: Record<RemoteTaskStatus, Task['status']> = { todo: 'queued', working: 'active', review: 'review', done: 'done' };

export function remoteUsage(today: DayUsage, limits: PlanLimits[], budget: Pick<HubPreferences, 'dailyTokens' | 'dailyCost' | 'limitWarning'> | null): RemoteUsage {
  const set = budget && (budget.dailyTokens || budget.dailyCost);
  return { day: today.day, tokens: { claude: today.claude, codex: today.codex }, cost: today.cost, complete: today.complete, limits,
    budget: set ? { tokens: budget.dailyTokens || null, dollars: budget.dailyCost || null, warnAt: (budget.limitWarning ?? DEFAULT_WARNING) / 100 } : null };
}
/** Newest change first; `channel` from the channel's place in this computer's workspace. */
export function remoteTasks(tasks: Task[], sessionIds: string[]): RemoteTask[] {
  return tasks.map((task): RemoteTask => { const index = task.sessionId ? sessionIds.indexOf(task.sessionId) : -1;
    return { id: task.id, title: task.title, status: TO_PHONE[task.status], sessionId: task.sessionId, channel: index >= 0 ? index + 1 : null, files: task.scope, updatedAt: task.sentAt ?? task.createdAt, ...(task.outcome ? { outcome: task.outcome } : {}) }; })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export const HISTORY_LIMIT = 100;
/** The desktop's list (already newest first) under the names the person gave conversations there. */
export function remoteHistory(items: (NativeConversation & { label?: string })[]): RemoteHistoryItem[] {
  return items.slice(0, HISTORY_LIMIT).map((item) => ({ key: item.key, engine: item.engine, title: item.label || item.title, folder: lastSegment(item.directory), modified: item.modifiedAt }));
}
export const MEMORY_NOTES = 30; export const MEMORY_CONTENT = 20000;
export function remoteMemory(project: { project: string; directory: string }, notes: MemoryNote[]): RemoteMemory {
  return { project: project.project, name: lastSegment(project.directory),
    notes: [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MEMORY_NOTES).map((note) => ({ id: note.id, title: note.title, author: note.author, createdAt: note.createdAt, content: note.content.slice(0, MEMORY_CONTENT) })) };
}
