import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { RepositoryContext } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';
import { FileTree } from './FileTree';
export function WorkspaceExplorer({ onClose }: { onClose: () => void }) {
  const root = useWorkspaceStore((s) => s.rootDirectory); const [repo, setRepo] = useState<RepositoryContext | null>(null); const [revision, setRevision] = useState(0); const [selected, setSelected] = useState<string | null>(null); const [text, setText] = useState('Select a file to preview it.'); const [error, setError] = useState('');
  useEffect(() => { let cancelled = false; let opened: RepositoryContext | null = null; const host = window.codingHub; setRepo(null); setError(''); if (!root || !host) return;
    host.openRepository({ directory: root }).then((result) => { if (!result.ok) { if (!cancelled) setError(result.error.message); return; } opened = result.value; if (cancelled) void host.closeRepository({ repositoryId: opened.id }); else setRepo(opened); }).catch(() => setError('Explorer unavailable.'));
    return () => { cancelled = true; if (opened) void host.closeRepository({ repositoryId: opened.id }); };
  }, [root]);
  useEffect(() => { if (!repo || !selected) return; let cancelled = false; window.codingHub!.readFile({ repositoryId: repo.id, path: selected }).then((result) => { if (!cancelled) setText(result.ok ? result.value.binary ? 'Binary or unsupported text encoding.' : (result.value.truncated ? '[Preview truncated]\n' : '') + result.value.text!.slice(0, 32000) : result.error.message); }).catch(() => { if (!cancelled) setText('Preview unavailable.'); }); return () => { cancelled = true; }; }, [repo, selected, revision]);
  return <aside className="workspace-explorer" aria-label="Workspace explorer"><header><span className="eyebrow">EXPLORER</span><div><button className="icon-button" aria-label="Refresh workspace explorer" onClick={() => setRevision(revision + 1)}><RefreshCw size={14} /></button><button className="icon-button" aria-label="Close workspace explorer" onClick={onClose}><X size={14} /></button></div></header><div className="repository-list-scroll">{repo ? <FileTree repository={repo} selected={selected} revision={revision} onSelect={setSelected} /> : <p className="control-note">{error || (root ? 'Opening project…' : 'Open a project to browse files.')}</p>}</div><pre className="explorer-preview">{text}</pre></aside>;
}
