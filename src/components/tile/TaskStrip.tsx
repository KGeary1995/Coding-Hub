import { ClipboardList } from 'lucide-react';
import { TASK_COLUMNS, useTaskStore } from '../../state/task-store';
import { useWorkspaceStore } from '../../state/workspace-store';

/**
 * The task a channel is working on, under its tile: what it is, where it stands, how many files it changed, and any
 * warning (a change outside its files, or files another task changed too). Clicking opens Tasks.
 */
export function TaskStrip({ sessionId }: { sessionId: string }) {
  const task = useTaskStore((state) => state.tasks.find((item) => item.sessionId === sessionId && (item.status === 'active' || item.status === 'review')));
  const changed = useTaskStore((state) => task ? state.watch.changed[task.id]?.length ?? 0 : 0);
  const warning = useTaskStore((state) => task ? state.watch.warnings.find((item) => item.taskIds.includes(task.id))?.text : undefined);
  if (!task) return null;
  const column = TASK_COLUMNS.find((item) => item.status === task.status)!;
  return <button className={`task-strip ${warning ? 'warned' : ''}`} title="Open Tasks" onClick={() => useWorkspaceStore.getState().setView('tasks')}>
    <ClipboardList size={13} aria-hidden="true" /><span className="task-strip-state">{column.label}</span><span className="task-strip-title">{task.title}</span>
    {changed > 0 && <span className="muted">{changed} {changed === 1 ? 'file' : 'files'} changed</span>}
    {warning && <span className="error-message">{warning}</span>}
  </button>;
}
