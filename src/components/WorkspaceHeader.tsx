import { useState } from 'react';
import { ArrowUpRight, Columns2, FolderOpen, Grid2X2, Plus, Rows2 } from 'lucide-react';
import { useWorkspaceStore } from '../state/workspace-store';
import { EngineHealth } from './EngineHealth';
import { useHubStore, tokens, formatNumber, dollars } from '../state/hub-store';

export function WorkspaceHeader() {
  const { rootDirectory, setRootDirectory, sessions, layoutMode, arrange, focusedSessionId } = useWorkspaceStore();
  const [editingPath, setEditingPath] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const allUsage = useHubStore((s) => s.usage);
  const usage = allUsage.filter((u) => sessions.some((s) => s.runId === u.runId));
  const total = usage.reduce((n, u) => n + tokens(u), 0);
  const cost = usage.length && usage.every((u) => u.cost !== null) ? usage.reduce((n, u) => n + u.cost!, 0) : null;
  async function chooseDirectory() {
    setError('');
    if (window.codingHub) {
      try {
        const selected = await window.codingHub.pickDirectory();
        if (selected) setRootDirectory(selected);
      } catch { setError('The directory picker could not open. Try again.'); }
    } else {
      setPath(rootDirectory ?? '');
      setEditingPath(true);
    }
  }
  return (
    <>
      <div className="workspace-heading">
        <div><div className="eyebrow">YOUR LOCAL COMMAND CENTER</div><h1>One workspace. Two perspectives.</h1><p>Bring Claude Code and Codex together. Stay in your flow.</p></div>
        <button className="button secondary" onClick={chooseDirectory}><FolderOpen size={16} />{rootDirectory ? 'Change project' : 'Open project'}<ArrowUpRight size={14} /></button>
      </div>
      {!rootDirectory && <div className="workspace-setup"><strong>Set up your workspace</strong><p>First connect your accounts. Then choose a folder on your PC, create a new project, or clone a GitHub repository. Account setup works before any coding session starts.</p><div className="hub-toolbar"><button className="button primary" onClick={() => useWorkspaceStore.getState().setView('accounts')}>1. Connect accounts</button><button className="button secondary" onClick={() => useWorkspaceStore.getState().setView('projects')}>2. Choose or clone a project</button><button className="quiet-button" onClick={chooseDirectory}>Browse local folder</button></div></div>}
      {rootDirectory && <button className="quiet-button" onClick={() => useWorkspaceStore.getState().setView('projects')}>Open, create, or clone another project</button>}
      {editingPath && <form className="path-entry" onSubmit={(event) => { event.preventDefault(); if (path.trim()) { setRootDirectory(path.trim()); setEditingPath(false); } }}><label htmlFor="workspace-path">Workspace directory</label><input id="workspace-path" autoFocus required value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path/to/project" /><button className="button primary" type="submit">Set directory</button><button className="quiet-button" type="button" onClick={() => setEditingPath(false)}>Cancel</button><small>Browser preview stores the path only. Desktop mode uses the native folder picker.</small></form>}
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="summary-strip">
        <div><span>CONFIGURED SESSIONS</span><strong>{String(sessions.length).padStart(2, '0')}<small>/ 4 available</small></strong></div>
        <div><span>SESSION TOKENS</span><strong>{usage.length ? formatNumber(total) : '—'}<small>{usage.length ? 'Reported by CLI' : 'Awaiting CLI usage'}</small></strong></div>
        <div><span>ESTIMATED COST</span><strong>{dollars(cost)}<small>{cost === null ? 'Configure model prices' : 'Local price estimate'}</small></strong></div>
        <div className="project-summary"><span>WORKSPACE ROOT</span><strong title={rootDirectory ?? undefined}><FolderOpen size={15} />{rootDirectory ? rootDirectory.split(/[\\/]/).filter(Boolean).at(-1) : 'No project selected'}<small>{rootDirectory ? 'Shared by default' : 'Open a local directory'}</small></strong></div>
      </div>
      <EngineHealth />
      <div className="grid-toolbar"><div><h2>Sessions</h2><span className="session-count">{sessions.length}</span><span className="toolbar-hint">Drag to arrange · Resize to fit</span></div><div className="toolbar-actions"><div className="layout-switcher" aria-label="Grid arrangement">{[{ mode: 'columns' as const, icon: Columns2, label: 'Split vertically: columns' }, { mode: 'rows' as const, icon: Rows2, label: 'Split horizontally: rows' }, { mode: 'grid' as const, icon: Grid2X2, label: 'Arrange in grid' }].map(({ mode, icon: Icon, label }) => <button key={mode} className={`icon-button ${layoutMode === mode ? 'selected' : ''}`} title={label} aria-label={label} aria-pressed={layoutMode === mode} disabled={!!focusedSessionId} onClick={() => arrange(mode)}><Icon size={16} /></button>)}</div><NewSessionMenu /></div></div>
    </>
  );
}

function NewSessionMenu() {
  const [open, setOpen] = useState(false);
  const { sessions, addSession } = useWorkspaceStore();
  return <div className="new-session-menu"><button className="button primary" disabled={sessions.length >= 4} aria-expanded={open} onClick={() => setOpen(!open)}><Plus size={15} />New session</button>{open && sessions.length < 4 && <div className="dropdown"><button onClick={() => { addSession('claude'); setOpen(false); }}><span className="claude-text">✳</span>Claude Code</button><button onClick={() => { addSession('codex'); setOpen(false); }}>⌘ Codex CLI</button></div>}</div>;
}
