import type { Session } from '../../shared/types';
import type { UsageRecord } from '../../shared/hub';
import type { Task } from '../../shared/workbench';
import { channelAlerts } from './channel-state';

/**
 * Everything waiting for the person, in one list: channels waiting for an approval (with the exact request and since
 * when), channels that failed, and tasks that stopped, went quiet or are ready for review. Each says what to do next.
 */
export interface NeedsYouItem { key: string; kind: 'approval' | 'failed' | 'limit' | 'task-stopped' | 'task-quiet' | 'task-review'; title: string; detail: string; since: string | null; sessionId: string | null; taskId: string | null; action: 'answer' | 'retry' | 'handoff' | 'tasks' }
const ORDER: Record<NeedsYouItem['kind'], number> = { approval: 0, failed: 1, 'task-stopped': 2, 'task-quiet': 3, 'task-review': 4, limit: 5 };

export function needsYou(sessions: Session[], records: UsageRecord[], tasks: Task[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const taskOf = (sessionId: string) => tasks.find((task) => task.sessionId === sessionId && (task.status === 'active' || task.status === 'review'));
  for (const alert of channelAlerts(sessions, records)) {
    const session = sessions.find((item) => item.id === alert.sessionId); const task = taskOf(alert.sessionId);
    const onTask = task ? ` · task: ${task.title}` : '';
    if (alert.state === 'waiting') items.push({ key: `a:${alert.sessionId}`, kind: 'approval', title: alert.text, detail: (session?.attention?.message || 'The agent is asking for your approval.') + onTask, since: session?.attention?.at ?? null, sessionId: alert.sessionId, taskId: task?.id ?? null, action: 'answer' });
    else if (alert.state === 'failed') items.push({ key: `f:${alert.sessionId}`, kind: 'failed', title: alert.text, detail: (session?.error || 'The channel stopped with an error.') + onTask, since: session?.endedAt ?? null, sessionId: alert.sessionId, taskId: task?.id ?? null, action: 'retry' });
    else items.push({ key: `l:${alert.sessionId}`, kind: 'limit', title: alert.text, detail: 'Near its context or budget limit: write a handoff before it runs out.' + onTask, since: null, sessionId: alert.sessionId, taskId: task?.id ?? null, action: 'handoff' });
  }
  for (const task of tasks) {
    // A failed channel is listed above with its task; its task is not listed twice.
    if (task.sessionId && items.some((item) => item.taskId === task.id)) continue;
    if (task.status === 'active' && (task.outcome === 'stopped' || task.outcome === 'failed')) items.push({ key: `t:${task.id}`, kind: 'task-stopped', title: `Task ${task.outcome === 'failed' ? 'failed' : 'stopped'}: ${task.title}`, detail: task.outcome === 'failed' ? 'Its channel failed before the agent finished. Send it again, or move it on.' : 'Its channel stopped before the agent finished (also after Trace restarts). Send it again, or move it on.', since: task.sentAt ?? null, sessionId: task.sessionId, taskId: task.id, action: 'tasks' });
    else if (task.status === 'active' && task.outcome === 'quiet') items.push({ key: `t:${task.id}`, kind: 'task-quiet', title: `Task gone quiet: ${task.title}`, detail: 'Its channel has drawn nothing for 45 seconds. Look whether the agent finished or is waiting.', since: task.sentAt ?? null, sessionId: task.sessionId, taskId: task.id, action: 'tasks' });
    else if (task.status === 'review') items.push({ key: `t:${task.id}`, kind: 'task-review', title: `Ready for review: ${task.title}`, detail: 'The agent finished its turn. Check the changes, then mark it done.', since: task.sentAt ?? null, sessionId: task.sessionId, taskId: task.id, action: 'tasks' });
  }
  return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.since ?? '').localeCompare(b.since ?? ''));
}

/** How long something has waited: "4 min", "2 h", "3 d". */
export function waited(since: string | null, now = Date.now()) {
  if (!since) return ''; const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
}
