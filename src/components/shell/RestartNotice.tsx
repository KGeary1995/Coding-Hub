import { useState } from 'react';
import { useTaskStore } from '../../state/task-store';
import { useChatStore } from '../../state/chat-store';
import { useWorkspaceStore } from '../../state/workspace-store';

/** When this window started: tasks sent before it whose channel stopped were cut short by the restart. */
const STARTED = new Date().toISOString();

/** Once per start: which tasks a restart cut short, and which Round Table messages it kept. Needs you lists each. */
export function RestartNotice() {
  const [dismissed, setDismissed] = useState(false);
  const cut = useTaskStore((s) => s.tasks).filter((task) => task.status === 'active' && task.outcome === 'stopped' && task.sentAt && task.sentAt < STARTED);
  const kept = Object.values(useChatStore((s) => s.threads)).filter((thread) => thread.table?.waitingKept).length;
  if (dismissed || (!cut.length && !kept)) return null;
  return <article className="tr-toast" aria-label="After the restart">
    <header><strong>After Trace restarted</strong><button className="tr-toast-close" aria-label="Dismiss the restart notice" onClick={() => setDismissed(true)}>×</button></header>
    <p>{cut.length ? `${cut.length} ${cut.length === 1 ? 'task was' : 'tasks were'} in progress and stopped: ${cut.slice(0, 3).map((task) => task.title).join(', ')}${cut.length > 3 ? ', …' : ''}. ` : ''}{kept ? `${kept} Round Table ${kept === 1 ? 'message was' : 'messages were'} kept, not sent. ` : ''}Needs you lists each.</p>
    <footer>{cut.length > 0 && <button className="tr-toast-action" onClick={() => { useWorkspaceStore.getState().setView('tasks'); setDismissed(true); }}>Open Tasks</button>}</footer>
  </article>;
}
