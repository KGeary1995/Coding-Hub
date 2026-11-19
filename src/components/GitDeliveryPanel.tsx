import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, GitPullRequestArrow, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DeliveryResult, DeliveryStatus } from '../../shared/productivity';
import { workbench } from '../runtime/workbench';
import { loadTasks, useTaskStore } from '../state/task-store';

/** One numbered step of the delivery column; done steps show a check in the circle. Title and facts sit together, closer than the controls. */
function Step({ index, title, meta, done, children }: { index: number; title: string; meta: ReactNode; done: boolean; children: ReactNode }) {
  return <li className={`tr-step ${done ? 'done' : ''}`}>
    <span className="tr-step-dot" aria-hidden="true">{done ? '✓' : index}</span>
    <div className="tr-step-body"><div className="tr-step-head"><h3>{title}</h3><p className="tr-step-meta">{meta}</p></div>{children}</div>
  </li>;
}

/**
 * Stage, commit, push and pull request as one vertical stepper beside the diff (docs/design/trace, sheet 04).
 * Every write or remote action still needs native confirmation and a fresh repository fingerprint; there is no force
 * push or discard.
 */
export function GitDeliveryPanel({ directory, revision, onChanged }: { directory: string; revision: number; onChanged: () => void }) {
  const [state, setState] = useState<DeliveryStatus | null>(null); const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState(''); const [remote, setRemote] = useState('');
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [base, setBase] = useState('main'); const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<DeliveryResult | null>(null);
  // The task this pull request is for, chosen by the person; none by default, so no task takes another's pull request.
  const openTasks = useTaskStore((s) => s.tasks).filter((task) => (task.status === 'active' || task.status === 'review') && task.directory.replace(/[\\/]+$/, '').toLowerCase() === directory.replace(/[\\/]+$/, '').toLowerCase()); const [forTask, setForTask] = useState('');
  /** The host's NOT_A_REPOSITORY, and only that: the folder has no Git, so there is nothing to deliver and the review card already says Git review is unavailable. */
  const [notRepository, setNotRepository] = useState(false);
  async function refresh() {
    if (!window.codingHub) throw new Error('This feature requires the desktop app.');
    const answer = await window.codingHub.workbench({ action: 'flow-git-inspect', directory });
    // Any other failure brings a hidden card back, or its error would have nowhere to show.
    if (!answer.ok) { if (answer.error.code !== 'NOT_A_REPOSITORY') { setNotRepository(false); throw new Error(answer.error.message); } setNotRepository(true); setState(null); return; }
    const value = answer.value as DeliveryStatus; setNotRepository(false); setState(value); setRemote((current) => value.remotes.includes(current) ? current : value.remotes[0] ?? ''); setPaths([]);
  }
  useEffect(() => { void refresh().catch((e) => setError((e as Error).message)); }, [directory]);
  // Hidden, the card has no Refresh of its own: the page's Refresh checks again, so a folder that has just become a repository gets it back.
  useEffect(() => { if (notRepository) void refresh().catch((e) => setError((e as Error).message)); }, [revision]);
  async function execute(action: 'stage' | 'unstage' | 'commit' | 'push' | 'pr') {
    if (!state) return; setBusy(true); setError(''); setResult(null);
    try {
      const ref = { directory: state.directory, revision: state.revision };
      const value = await workbench<DeliveryResult | null>(action === 'stage' || action === 'unstage' ? { action: action === 'stage' ? 'flow-git-stage' : 'flow-git-unstage', ...ref, paths } : action === 'commit' ? { action: 'flow-git-commit', ...ref, message } : action === 'push' ? { action: 'flow-git-push', ...ref, remote } : { action: 'flow-git-pr', ...ref, title, body, base, draft });
      if (action === 'pr' && value?.url && forTask) { try { await workbench({ action: 'task-pr', id: forTask, url: value.url }); await loadTasks(); } catch { /* The pull request stands; only the task link is missing. */ } }
      setResult(value); await refresh(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const files = state ? [...new Set([...state.unstaged, ...state.staged])] : [];
  const clean = Boolean(state && !state.staged.length && !state.unstaged.length);
  if (notRepository) return null;
  return <aside className="delivery-panel tr-delivery ui-card" aria-label="Git delivery">
    <header className="ui-card-head"><GitPullRequestArrow size={16} /><h2>Delivery</h2><div className="ui-card-actions"><button className="icon-button" aria-label="Refresh delivery state" title="Refresh delivery state" disabled={busy} onClick={() => void refresh().catch((e) => setError((e as Error).message))}><RefreshCw size={16} /></button></div></header>
    {error && <div role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
    {/* Only the steps scroll. The head, an error, the last step's output and the closing note stay in sight. */}
    <div className="tr-delivery-scroll">
    {!state ? !error && <p className="tr-step-meta" role="status"><LoaderCircle size={12} className="spin" />Reading the repository…</p> : <ol className="tr-steps">
      <Step index={1} title="Stage" meta={files.length ? `${state.staged.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'} staged` : 'No changes to stage'} done={files.length > 0 && !state.unstaged.length}>
        {files.length > 0 && <div className="delivery-file-list ui-list">{files.map((file) => { const staged = state.staged.includes(file); const working = state.unstaged.includes(file);
          return <label className="ui-row" key={file}><input type="checkbox" checked={paths.includes(file)} onChange={(e) => setPaths(e.target.checked ? [...paths, file] : paths.filter((item) => item !== file))} /><code title={file}>{file}</code><small className={`ui-badge ${working ? 'warning' : 'success'}`}>{staged ? 'Staged' : ''}{staged && working ? ' + ' : ''}{working ? (staged ? 'working' : 'Working') : ''}</small></label>; })}</div>}
        <div className="tr-step-actions"><button className="button secondary" disabled={busy || !paths.length || paths.some((file) => !state.unstaged.includes(file))} onClick={() => void execute('stage')}>Stage</button><button className="button secondary" disabled={busy || !paths.length || paths.some((file) => !state.staged.includes(file))} onClick={() => void execute('unstage')}>Unstage</button></div>
      </Step>
      <Step index={2} title="Commit" meta={state.staged.length ? `${state.staged.length} staged ${state.staged.length === 1 ? 'path' : 'paths'} ready` : 'Nothing staged yet'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('commit'); }}><textarea aria-label="Delivery commit message" placeholder="Commit message" value={message} required maxLength={2000} rows={3} onChange={(e) => setMessage(e.target.value)} /><button className="button primary" disabled={busy || !state.staged.length}>Commit staged changes</button></form>
      </Step>
      <Step index={3} title="Push" meta={state.branch ? `${state.branch} → ${remote || 'no remote'}` : 'Detached HEAD · nothing to push'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('push'); }}>{state.remotes.length > 1 && <select aria-label="Delivery remote" value={remote} onChange={(e) => setRemote(e.target.value)}>{state.remotes.map((name) => <option key={name}>{name}</option>)}</select>}<button className="button secondary" disabled={busy || !remote || !state.branch}>Push current branch</button></form>
      </Step>
      <Step index={4} title="Pull request" meta={clean ? 'Uses the GitHub CLI (gh) login' : 'Commit or stash changes first'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('pr'); }}>
          <input aria-label="Delivery PR title" placeholder="Title" value={title} required maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <input aria-label="Delivery PR base" placeholder="Base branch" value={base} required maxLength={150} onChange={(e) => setBase(e.target.value)} />
          <textarea aria-label="Delivery PR body" placeholder="Description" value={body} maxLength={10000} rows={3} onChange={(e) => setBody(e.target.value)} />
          <label className="update-checkbox"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Create as a draft</label>
          {openTasks.length > 0 && <label className="ui-field">For task<select aria-label="Task for this pull request" value={forTask} onChange={(e) => setForTask(e.target.value)}><option value="">None</option>{openTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
          <button className="button secondary" disabled={busy || !state.branch || !clean}>Create pull request</button>
        </form>
      </Step>
    </ol>}
    </div>
    {result && <div role="status" className="tr-delivery-result"><pre className="check-output">{result.output}</pre>{result.url && <button className="button secondary" onClick={() => void workbench({ action: 'flow-open-pr', url: result.url! }).catch((e) => setError(e.message))}>Open created pull request</button>}</div>}
    <p className="tr-step-note ui-hint">Each step shows a native confirmation first. No force push or discard.</p>
  </aside>;
}
