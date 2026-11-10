import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { useTaskStore } from '../../state/task-store';
import { needsYou, waited, type NeedsYouItem } from '../../state/needs-you';
import { jumpToChannel } from './StatusBar';

const ACTION: Record<NeedsYouItem['action'], string> = { answer: 'Answer', retry: 'Open channel', handoff: 'Write handoff', tasks: 'Open Tasks' };

/** "Needs you · N" in the status bar: one list of everything waiting for the person, each with its next step. */
export function NeedsYouCell() {
  const sessions = useWorkspaceStore((s) => s.sessions); const records = useHubStore((s) => s.usage); const tasks = useTaskStore((s) => s.tasks);
  const [open, setOpen] = useState(false); const [, tick] = useState(0); const box = useRef<HTMLDivElement>(null);
  const items = needsYou(sessions, records, tasks);
  // Waiting times stay current while the list is open; Escape or a click elsewhere closes it.
  useEffect(() => { if (!open) return; const timer = setInterval(() => tick((n) => n + 1), 30000); const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false); }; window.addEventListener('mousedown', close); window.addEventListener('keydown', close); return () => { clearInterval(timer); window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); }; }, [open]);
  if (!items.length) return null;
  const go = (item: NeedsYouItem) => { setOpen(false); if (item.action === 'tasks') useWorkspaceStore.getState().setView('tasks'); else if (item.action === 'handoff') useWorkspaceStore.getState().setView('memory'); else if (item.sessionId) jumpToChannel(item.sessionId); };
  return <div className="needs-you" ref={box}>
    <button className="tr-sb-cell needs-you-cell" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="Everything waiting for you">Needs you · {items.length}</button>
    {open && <div className="needs-you-list" role="dialog" aria-label="Needs you"><ol>{items.map((item) => <li key={item.key} className={`needs-you-${item.kind}`}>
      <div><strong>{item.title}</strong>{item.since && <small className="tnum"> · waiting {waited(item.since)}</small>}<p>{item.detail}</p></div>
      <button className="quiet-button" onClick={() => go(item)}>{ACTION[item.action]}</button>
    </li>)}</ol></div>}
  </div>;
}
