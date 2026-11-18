import { useEffect, useState } from 'react';
import { AlertTriangle, FolderOpen, FolderTree, RefreshCw, X } from 'lucide-react';
import type { RepositoryContext } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';
import { FileTree } from './FileTree';
/** What the preview holds: file text (mono, on the terminal well), a hint, or an error in the danger colour. */
type PreviewTone = 'text' | 'hint' | 'error';
export function WorkspaceExplorer({ onClose }: { onClose: () => void }) {
  const root = useWorkspaceStore((s) => s.rootDirectory); const [repo, setRepo] = useState<RepositoryContext | null>(null); const [revision, setRevision] = useState(0); const [selected, setSelected] = useState<string | null>(null); const [text, setText] = useState('Select a file to preview it.'); const [tone, setTone] = useState<PreviewTone>('hint'); const [error, setError] = useState('');
  /** The file whose text the preview holds. Not `selected`: while the next file is being read, the old text is still shown. */
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; let opened: RepositoryContext | null = null; const host = window.codingHub; setRepo(null); setError(''); setSelected(null); setText('Select a file to preview it.'); setTone('hint'); if (!root || !host) return;
    host.openRepository({ directory: root }).then((result) => { if (!result.ok) { if (!cancelled) setError(result.error.message); return; } opened = result.value; if (cancelled) void host.closeRepository({ repositoryId: opened.id }); else setRepo(opened); }).catch(() => setError('Explorer unavailable.'));
    return () => { cancelled = true; if (opened) void host.closeRepository({ repositoryId: opened.id }); };
  }, [root]);
  useEffect(() => { if (!repo || !selected) return; let cancelled = false; window.codingHub!.readFile({ repositoryId: repo.id, path: selected }).then((result) => { if (cancelled) return; setShown(selected); setTone(!result.ok ? 'error' : result.value.binary ? 'hint' : 'text'); setText(result.ok ? result.value.binary ? 'Binary or unsupported text encoding.' : (result.value.truncated ? '[Preview truncated]\n' : '') + result.value.text!.slice(0, 32000) : result.error.message); }).catch(() => { if (!cancelled) { setTone('error'); setText('Preview unavailable.'); } }); return () => { cancelled = true; }; }, [repo, selected, revision]);
  return <aside className="workspace-explorer ui-card" aria-label="Workspace explorer"><header className="ui-card-head"><FolderTree size={16} /><h2>Explorer</h2><div className="ui-card-actions"><button className="icon-button" aria-label="Refresh workspace explorer" onClick={() => setRevision(revision + 1)}><RefreshCw size={14} /></button><button className="icon-button" aria-label="Close workspace explorer" onClick={onClose}><X size={14} /></button></div></header>
    <div className="repository-list-scroll">{repo ? <FileTree repository={repo} selected={selected} revision={revision} onSelect={setSelected} />
      : error ? <p className="tree-message error-message" role="alert"><AlertTriangle size={12} />{error}</p>
      : root ? <p className="control-note" role="status">Opening project…</p>
      : <div className="ui-empty"><FolderOpen /><h3>No project open</h3><p>Open a project to browse its files.</p></div>}</div>
    {/* The file's name heads its text; messages are words, not file text, so they are not mono. */}
    {shown && tone === 'text' && <p className="explorer-preview-path"><code title={shown}>{shown}</code></p>}
    {tone === 'text' ? <pre className="explorer-preview">{text}</pre> : <p className={`explorer-preview hint ${tone === 'error' ? 'error-message' : ''}`} role={tone === 'error' ? 'alert' : undefined}>{text}</p>}</aside>;
}
