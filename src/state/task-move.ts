import type { Task } from '../../shared/workbench';

/**
 * The task as it moves into a worktree: its channel and folder change, and a check attached to it is let go, since it
 * tested the old folder (the host refuses a check from another folder). Its notes say which check it was, so the
 * history stays; the new worktree needs a fresh run.
 */
export function movedTask(task: Task, sessionId: string, directory: string): Task {
  const note = task.verificationId ? `Moved to ${directory}; the check attached before (${task.verificationId}) tested ${task.directory}. Run it again here.` : '';
  return { ...task, sessionId, directory, status: 'queued', verificationId: null, notes: note ? [task.notes, note].filter(Boolean).join('\n').slice(-2000) : task.notes };
}
