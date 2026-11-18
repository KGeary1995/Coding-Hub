import type { Finding } from '../../shared/findings';
import type { Task } from '../../shared/workbench';
import { promptMark } from '../../shared/task-signal';

/**
 * What names one send of a task in its prompt: `Task <sendId>:`, which a later title edit does not change (the colon ends
 * it, so one id never matches as the start of another). A task sent before send ids existed: its whole mark, title included.
 */
export const sendMark = (task: Task) => task.sendId ? `Task ${task.sendId}:` : promptMark(task);

/**
 * The Round Table findings that belong to one task: those reported on its channel after it was sent and before the next
 * task on that channel was sent. A task never inherits findings about earlier or later work. A later task that has not
 * started does not end it: one back in To do, or one still waiting at a hierarchy table (`waiting`, the prompts in its
 * chain's nextTasks), since the table works on this one meanwhile.
 */
export function findingsForTask(task: Task, tasks: Task[], findings: Finding[], waiting: readonly string[] = []): Finding[] {
  const started = (other: Task) => other.status !== 'queued' && !waiting.some((prompt) => prompt.includes(sendMark(other)));
  if (!task.sessionId || !task.sentAt || !started(task)) return [];
  const from = task.sentAt; const until = tasks.filter((other) => other.id !== task.id && other.sessionId === task.sessionId && other.sentAt && other.sentAt > from && started(other)).map((other) => other.sentAt!).sort()[0];
  return findings.filter((finding) => finding.at >= from && (!until || finding.at < until));
}
