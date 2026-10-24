import { useEffect, useRef, useState } from 'react';
import { Command, ArrowRight } from 'lucide-react';
import { useWorkspaceStore } from '../state/workspace-store';
import { refreshEngines, startSession, stopSession } from '../runtime/use-native-host';

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const { sessions, setView, arrange } = useWorkspaceStore();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); setOpen((current) => !current); }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    setQuery('');
    input.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', trapFocus);
    return () => { window.removeEventListener('keydown', trapFocus); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);
  const commands = [
    { name: 'Search local workspace', detail: 'Workflow', run: () => { useWorkspaceStore.setState({ workflowTab: 'search' }); setView('workflow'); } },
    { name: 'Recover a failed session', detail: 'Workflow', run: () => { useWorkspaceStore.setState({ workflowTab: 'recovery' }); setView('workflow'); } },
    { name: 'Apply a project template', detail: 'Workflow', run: () => { useWorkspaceStore.setState({ workflowTab: 'templates' }); setView('workflow'); } },
    { name: 'Export a diagnostic report', detail: 'Support', run: () => { useWorkspaceStore.setState({ workflowTab: 'support' }); setView('workflow'); } },
    { name: 'Go to workspace', detail: 'Navigation', run: () => setView('workspace') },
    { name: 'Open, create, or clone a project', detail: 'Setup', run: () => setView('projects') },
    { name: 'Connect Claude, Codex, or GitHub account', detail: 'Setup', run: () => setView('accounts') },
    { name: 'Open session history', detail: 'Navigation', run: () => setView('history') },
    { name: 'Browse project files', detail: 'Navigation', run: () => setView('files') },
    { name: 'Manage MCP servers', detail: 'Navigation', run: () => setView('connectors') },
    { name: 'Inspect skills and plugins', detail: 'Navigation', run: () => setView('skills') },
    { name: 'Open shared memory', detail: 'Navigation', run: () => setView('memory') },
    { name: 'Edit shared rules', detail: 'Navigation', run: () => setView('rules') },
    { name: 'Open help and AI guide', detail: 'Navigation', run: () => setView('help') },
    { name: 'Review token usage', detail: 'Navigation', run: () => setView('usage') },
    { name: 'Review Git changes', detail: 'Navigation', run: () => setView('diff') },
    { name: 'Arrange sessions in grid', detail: 'Layout', run: () => { setView('workspace'); arrange('grid'); } },
    { name: 'Refresh local CLI detection', detail: 'Native host', run: () => void refreshEngines() },
    { name: 'Open workspace settings', detail: 'Navigation', run: () => setView('settings') },
    ...sessions.flatMap((session, index) => session.status === 'running'
      ? [{ name: `Stop ${session.title} · session ${index + 1}`, detail: 'Process', run: () => void stopSession(session.id) }]
      : session.status !== 'starting' ? [{ name: `Start ${session.title} · session ${index + 1}`, detail: 'Process', run: () => { setView('workspace'); void startSession(session.id); } }] : []),
  ].filter((command) => command.name.toLowerCase().includes(query.toLowerCase()));
  return <><button className="command-trigger" aria-label="Search or run a command" title="Search or run a command (Ctrl ⇧ P)" onClick={() => setOpen(true)}><span>Search or run a command</span><kbd aria-hidden="true">Ctrl ⇧ P</kbd></button>{open && <div className="command-backdrop" onClick={() => setOpen(false)}><section ref={dialog} className="command-menu" role="dialog" aria-modal="true" aria-label="Workspace commands" onClick={(event) => event.stopPropagation()}><div className="command-search"><Command size={18} /><input ref={input} aria-label="Search commands" placeholder="What would you like to do?" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && commands[0]) { setOpen(false); commands[0].run(); } }} /><button className="quiet-button" onClick={() => setOpen(false)}>Esc</button></div><div className="command-list">{commands.map((command) => <button key={command.name} onClick={() => { setOpen(false); command.run(); }}><span>{command.name}<small>{command.detail}</small></span><ArrowRight size={14} /></button>)}{commands.length === 0 && <p>No matching commands.</p>}</div></section></div>}</>;
}
