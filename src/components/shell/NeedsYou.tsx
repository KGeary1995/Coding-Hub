import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { useTaskStore } from '../../state/task-store';
import { useChatStore } from '../../state/chat-store';
import { needsYou, waited, type NeedsYouItem } from '../../state/needs-you';
import { jumpToChannel } from './StatusBar';
import { forgetTable } from '../../runtime/round-table';
import { useLinkedStore } from '../../state/linked-store';

const ACTION: Record<NeedsYouItem['action'], string> = { answer: 'Answer', retry: 'Open channel', handoff: 'Write handoff', tasks: 'Open Tasks', 'save-findings': 'Save to memory', open: 'Open channel' };

/**
 * "Needs you · N" in the status bar: one list of everything waiting for the person, on this computer and linked ones,
 * each with its next step. It is the bar's only alert: a second chip naming the first channel (before 1.30.2) said the same twice.
 */
export function NeedsYouCell() {
  const sessions = useWorkspaceStore((s) => s.sessions); const records = useHubStore((s) => s.usage); const tasks = useTaskStore((s) => s.tasks); const computers = useLinkedStore((s) => s.computers);
  const [open, setOpen] = useState(false); const [, tick] = useState(0); const box = useRef<HTMLDivElement>(null);
  const threads = useChatStore((s) => s.threads); const tables = Object.fromEntries(Object.entries(threads).map(([id, thread]) => [id, thread.table]));
  const items = needsYou(sessions, records, tasks, tables, computers);
  // Waiting times stay current while the list is open; Escape or a click elsewhere closes it.
  useEffect(() => { if (!open) return; const timer = setInterval(() => tick((n) => n + 1), 30000); const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false); }; window.addEventListener('mousedown', close); window.addEventListener('keydown', close); return () => { clearInterval(timer); window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); }; }, [open]);
  if (!items.length) return null;
  const go = (item: NeedsYouItem) => { setOpen(false); if (item.action === 'save-findings' && item.sessionId) { /* As closing a table does: the findings, then any tasks still waiting there back to To do, then the record. */ void forgetTable(item.sessionId); }
    else if (item.computerId) useWorkspaceStore.setState({ computerId: item.computerId, activeView: 'computer' });
    else if (item.action === 'tasks') useWorkspaceStore.getState().setView('tasks'); else if (item.action === 'handoff') useWorkspaceStore.getState().setView('memory'); else if (item.sessionId) jumpToChannel(item.sessionId); };
  return <div className="needs-you" ref={box}>
    {/* The separator is not drawn (the count is a pill), but it stays in the button's name: "Needs you · 2". */}
    <button className="tr-sb-cell needs-you-cell" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title={items.map((item) => item.title).join('\n')}>Needs you<span className="needs-you-sep"> · </span><span className="ui-count waiting">{items.length}</span></button>
    {open && <div className="needs-you-list" role="dialog" aria-label="Needs you"><ol>{items.map((item) => <li key={item.key} className={`needs-you-${item.kind}`}>
      <div><strong>{item.title}</strong>{item.since && <small className="tnum"> · waiting {waited(item.since)}</small>}<p>{item.detail}</p></div>
      <button className="button small" onClick={() => go(item)}>{ACTION[item.action]}</button>
    </li>)}</ol></div>}
  </div>;
}
