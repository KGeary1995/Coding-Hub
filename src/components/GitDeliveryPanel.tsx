import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DeliveryResult, DeliveryStatus } from '../../shared/productivity';
import { workbench } from '../runtime/workbench';

/** One numbered step of the delivery column; done steps show a check in the circle. */
function Step({ index, title, meta, done, children }: { index: number; title: string; meta: ReactNode; done: boolean; children: ReactNode }) {
  return <li className={`tr-step ${done ? 'done' : ''}`}>
    <span className="tr-step-dot" aria-hidden="true">{done ? '✓' : index}</span>
    <div className="tr-step-body"><h3>{title}</h3><p className="tr-step-meta">{meta}</p>{children}</div>
  </li>;
}

/**
 * Stage, commit, push and pull request as one vertical stepper beside the diff (docs/design/trace, sheet 04).
 * Every write or remote action still needs native confirmation and a fresh repository fingerprint; there is no force
 * push or discard.
 */
export function GitDeliveryPanel({ directory, onChanged }: { directory: string; onChanged: () => void }) {
  const [state, setState] = useState<DeliveryStatus | null>(null); const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState(''); const [remote, setRemote] = useState('');
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [base, setBase] = useState('main'); const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<DeliveryResult | null>(null);
  async function refresh() { const value = await workbench<DeliveryStatus>({ action: 'flow-git-inspect', directory }); setState(value); setRemote((current) => value.remotes.includes(current) ? current : value.remotes[0] ?? ''); setPaths([]); }
  useEffect(() => { void refresh().catch((e) => setError((e as Error).message)); }, [directory]);
  async function execute(action: 'stage' | 'unstage' | 'commit' | 'push' | 'pr') {
    if (!state) return; setBusy(true); setError(''); setResult(null);
    try {
      const ref = { directory: state.directory, revision: state.revision };
      const value = await workbench<DeliveryResult | null>(action === 'stage' || action === 'unstage' ? { action: action === 'stage' ? 'flow-git-stage' : 'flow-git-unstage', ...ref, paths } : action === 'commit' ? { action: 'flow-git-commit', ...ref, message } : action === 'push' ? { action: 'flow-git-push', ...ref, remote } : { action: 'flow-git-pr', ...ref, title, body, base, draft });
      setResult(value); await refresh(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const files = state ? [...new Set([...state.unstaged, ...state.staged])] : [];
  const clean = Boolean(state && !state.staged.length && !state.unstaged.length);
  return <aside className="delivery-panel tr-delivery" aria-label="Git delivery">
    <header><h2>Delivery</h2><button className="tr-ghost-button" disabled={busy} onClick={() => void refresh().catch((e) => setError((e as Error).message))}><RefreshCw size={13} />Refresh delivery state</button></header>
    {error && <p role="alert" className="error-message">{error}</p>}
    {!state ? <p className="tr-step-meta">Reading the repository…</p> : <ol className="tr-steps">
      <Step index={1} title="Stage" meta={`${state.staged.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'} staged`} done={files.length > 0 && !state.unstaged.length}>
        {files.length > 0 && <div className="delivery-file-list">{files.map((file) => <label key={file}><input type="checkbox" checked={paths.includes(file)} onChange={(e) => setPaths(e.target.checked ? [...paths, file] : paths.filter((item) => item !== file))} /><code>{file}</code><small>{state.staged.includes(file) ? 'staged' : ''}{state.staged.includes(file) && state.unstaged.includes(file) ? ' + ' : ''}{state.unstaged.includes(file) ? 'working' : ''}</small></label>)}</div>}
        <div className="tr-step-actions"><button className="button primary" disabled={busy || !paths.length || paths.some((file) => !state.unstaged.includes(file))} onClick={() => void execute('stage')}>Review and stage selected</button><button className="button secondary" disabled={busy || !paths.length || paths.some((file) => !state.staged.includes(file))} onClick={() => void execute('unstage')}>Unstage</button></div>
      </Step>
      <Step index={2} title="Commit" meta={state.staged.length ? `${state.staged.length} staged ${state.staged.length === 1 ? 'path' : 'paths'} ready` : 'nothing staged yet'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('commit'); }}><textarea aria-label="Delivery commit message" placeholder="Commit message" value={message} required maxLength={2000} rows={3} onChange={(e) => setMessage(e.target.value)} /><button className="button primary" disabled={busy || !state.staged.length}>Review and commit staged changes</button></form>
      </Step>
      <Step index={3} title="Push" meta={state.branch ? `${state.branch} → ${remote || 'no remote'}` : 'detached HEAD · nothing to push'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('push'); }}>{state.remotes.length > 1 && <select aria-label="Delivery remote" value={remote} onChange={(e) => setRemote(e.target.value)}>{state.remotes.map((name) => <option key={name}>{name}</option>)}</select>}<button className="button secondary" disabled={busy || !remote || !state.branch}>Review and push current branch</button></form>
      </Step>
      <Step index={4} title="Pull request" meta={clean ? 'uses the GitHub CLI (gh) login' : 'commit or stash changes first'} done={false}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void execute('pr'); }}>
          <input aria-label="Delivery PR title" placeholder="Title" value={title} required maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <input aria-label="Delivery PR base" placeholder="Base branch" value={base} required maxLength={150} onChange={(e) => setBase(e.target.value)} />
          <textarea aria-label="Delivery PR body" placeholder="Description" value={body} maxLength={10000} rows={3} onChange={(e) => setBody(e.target.value)} />
          <label className="update-checkbox"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Create as a draft</label>
          <button className="button secondary" disabled={busy || !state.branch || !clean}>Review and create pull request</button>
        </form>
      </Step>
    </ol>}
    {result && <div role="status" className="tr-delivery-result"><pre className="check-output">{result.output}</pre>{result.url && <button className="button secondary" onClick={() => void workbench({ action: 'flow-open-pr', url: result.url! }).catch((e) => setError(e.message))}>Open created pull request</button>}</div>}
    <p className="tr-step-note">Each step shows a native confirmation first. No force push or discard.</p>
  </aside>;
}
