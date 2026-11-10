import type { Finding } from '../../shared/findings';
import type { Task } from '../../shared/workbench';

/**
 * The Round Table findings that belong to one task: those reported on its channel after it was sent and before the next
 * task on that channel was sent. A task never inherits findings about earlier or later work.
 */
export function findingsForTask(task: Task, tasks: Task[], findings: Finding[]): Finding[] {
  if (!task.sessionId || !task.sentAt) return [];
  const from = task.sentAt; const until = tasks.filter((other) => other.id !== task.id && other.sessionId === task.sessionId && other.sentAt && other.sentAt > from).map((other) => other.sentAt!).sort()[0];
  return findings.filter((finding) => finding.at >= from && (!until || finding.at < until));
}
