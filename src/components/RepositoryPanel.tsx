import { GitDeliveryPanel, useDelivery } from './GitDeliveryPanel';
import { useEffect, useState } from 'react';
import { CircleAlert, Files, FolderOpen, GitCompareArrows, LoaderCircle, MonitorOff, RefreshCw } from 'lucide-react';
import type { RepositoryContext } from '../../shared/types';
import { channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { FileBrowser } from './FileBrowser';
import { DiffViewer } from './DiffViewer';
import { CommitHistory } from './CommitHistory';

export function RepositoryPanel({ mode }: { mode: 'files' | 'diff' }) {
  const { rootDirectory, sessions, setView, setRootDirectory } = useWorkspaceStore();
  // Review changes on a channel opens that channel's repository; otherwise Changes starts at the workspace root.
  const [selection, setSelection] = useState(() => { const id = useWorkspaceStore.getState().reviewSessionId; return id && sessions.some((session) => session.id === id) ? id : 'workspace'; });
  useEffect(() => { if (useWorkspaceStore.getState().reviewSessionId) useWorkspaceStore.setState({ reviewSessionId: null }); }, []);
  const [repository, setRepository] = useState<RepositoryContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [connectionRevision, setConnectionRevision] = useState(0);
  /** Uncommitted changes or the commit History; the diff stays mounted behind History so its review comments are kept. */
  const [history, setHistory] = useState(false);
  const choices = [
    { id: 'workspace', name: 'Workspace root', directory: rootDirectory },
    ...channelsOf(sessions).map((session, index) => ({ id: session.id, name: `Channel ${index + 1} · ${session.title}`, directory: session.status === 'running' ? session.runningCwd : session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory })),
  ];
  const selected = choices.find((choice) => choice.id === selection) ?? choices[0];
  const directory = selected.directory;
  useEffect(() => {
    let cancelled = false; let opened: RepositoryContext | null = null;
    setRepository(null); setError(null);
    const host = window.codingHub;
    if (!host || !directory) return;
    void host.openRepository({ directory }).then((result) => {
      if (!result.ok) { if (!cancelled) setError(result.error.message); return; }
      opened = result.value;
      if (cancelled) void host.closeRepository({ repositoryId: opened.id }).catch(() => {});
      else setRepository(opened);
    }).catch(() => { if (!cancelled) setError('This project could not be opened.'); });
    return () => { cancelled = true; if (opened) void host.closeRepository({ repositoryId: opened.id }).catch(() => {}); };
  }, [directory, connectionRevision]);
  async function chooseProject() {
    try { const selected = await window.codingHub?.pickDirectory(); if (selected) { setRootDirectory(selected); setSelection('workspace'); setConnectionRevision((value) => value + 1); } }
    catch { setError('The folder picker could not open.'); }
  }
  // One reading of the repository for staging and shipping, shared by the file list and the Ship column (1.31.3).
  const delivery = useDelivery(mode === 'diff' && repository ? repository.directory : '', revision, () => setRevision((value) => value + 1));
  const Icon = mode === 'files' ? Files : GitCompareArrows;
  const body = !window.codingHub ? <div className="repository-empty repository-message ui-card ui-empty"><MonitorOff size={34} /><h2>Desktop host required</h2><p>Run Trace with npm to browse local files and Git changes.</p></div>
    : error ? <div className="repository-empty repository-message ui-card ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Project unavailable</h2><p className="error-message">{error}</p></div>
    : !directory ? <div className="repository-empty repository-message ui-card ui-empty"><FolderOpen size={34} /><h2>Choose a project</h2><p>Open a project, or pick a channel with its own repository folder.</p></div>
    : !repository ? <div className="repository-empty repository-message ui-card ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Opening project…</p></div>
    : mode === 'files' ? <FileBrowser key={repository.id} repository={repository} revision={revision} /> : <><div className="tr-changes-view" hidden={history}><DiffViewer key={repository.id} repository={repository} revision={revision} delivery={delivery} /></div>{history && <div className="tr-changes-view"><CommitHistory key={repository.id} repository={repository} revision={revision} /></div>}</>;
  const shown = repository?.directory ?? directory;
  // The shared page heading (title, folder, context, actions), then the files or the diff beside the delivery stepper.
  return <section className={`repository-panel tr-repo ${mode === 'diff' ? 'tr-changes' : 'tr-files'}`}>
    <header className="ui-page-head">
      <span className="ui-page-icon" aria-hidden="true"><Icon /></span>
      <div><h1>{mode === 'files' ? 'Files' : 'Changes'}</h1><p>{shown ? <code className="tr-subhead-path" title={shown}>{shown}</code> : 'No folder selected'}</p></div>
      <div className="ui-page-actions">
        <label className="tr-subhead-select"><span className="tr-visually-hidden">Repository context</span><select aria-label="Repository context" value={selected.id} onChange={(event) => setSelection(event.target.value)}>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}{choice.directory ? '' : ' · no folder'}</option>)}</select></label>
        {mode === 'diff' && repository && <span className="tr-seg" role="group" aria-label="Changes view"><button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>Uncommitted</button><button type="button" aria-pressed={history} onClick={() => setHistory(true)}>History</button></span>}
        <button className="button secondary" onClick={chooseProject} disabled={!window.codingHub}><FolderOpen size={16} />{rootDirectory ? 'Change project' : 'Open project'}</button>
        <button className="button secondary" onClick={() => { setRevision((value) => value + 1); if (!repository) setConnectionRevision((value) => value + 1); }} disabled={!directory || !window.codingHub}><RefreshCw size={16} />Refresh {mode === 'files' ? 'files' : 'changes'}</button>
        <button className="quiet-button" onClick={() => setView('workspace')}>Back to channels</button>
      </div>
    </header>
    {mode === 'diff' ? <div className="tr-changes-grid"><div className="tr-changes-main">{body}</div>{repository && <GitDeliveryPanel key={repository.id + '-delivery'} directory={repository.directory} delivery={delivery} />}</div> : body}
  </section>;
}
