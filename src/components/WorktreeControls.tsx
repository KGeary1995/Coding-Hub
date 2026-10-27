import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { ManagedWorktree } from '../../shared/project-tools';
import type { Session } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';
export function WorktreeControls({ session }: { session: Session }) {
  const root = useWorkspaceStore((s) => s.rootDirectory);
  const [trees, setTrees] = useState<ManagedWorktree[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function refresh() { const result = await window.codingHub?.projectTools({ action: 'worktree-list' }); if (result?.ok) setTrees(result.value as ManagedWorktree[]); }
  useEffect(() => { void refresh(); }, []);
  const directory = session.binding.mode === 'independent' ? session.binding.cwd : root;
  return <div className="worktree-controls"><label>Managed worktree<select aria-label="Managed worktree" value={trees.some((tree) => tree.directory === directory) ? directory! : ''} disabled={busy} onChange={(event) => { /* Current directory goes back to the workspace folder. */ useWorkspaceStore.getState().updateBinding(session.id, event.target.value ? { mode: 'independent', cwd: event.target.value } : { mode: 'workspace' }); }}><option value="">Current directory</option>{trees.map((tree) => <option key={tree.id} value={tree.directory}>{tree.branch} · {tree.repository}</option>)}</select></label><button type="button" className="button secondary" disabled={busy || !directory || !window.codingHub} onClick={() => void (async () => { setBusy(true); setError(''); try { const result = await window.codingHub!.projectTools({ action: 'worktree-create', directory: directory! }); if (!result.ok) throw new Error(result.error.message); const tree = result.value as ManagedWorktree; useWorkspaceStore.getState().updateBinding(session.id, { mode: 'independent', cwd: tree.directory }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not create worktree.'); } finally { setBusy(false); } })()}><GitBranch size={14} />{busy ? 'Creating…' : 'Create isolated worktree'}</button><small className="control-note">Starts from the current committed HEAD on a new branch. Uncommitted files stay in the original repository. Apply shared rules to the worktree before launching, then review it in Changes. Changes are combined through your normal Git review.</small>{error && <p className="error-message" role="alert">{error}</p>}</div>;
}
