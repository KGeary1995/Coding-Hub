import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, GitPullRequestArrow, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DeliveryResult, DeliveryStatus } from '../../shared/productivity';
import { workbench } from '../runtime/workbench';
import { loadTasks, useTaskStore } from '../state/task-store';

/** One numbered step of the Ship column; done steps show a check in the circle. Title and facts sit together, closer than the controls. */
function Step({ index, title, meta, done, children }: { index: number; title: string; meta: ReactNode; done: boolean; children: ReactNode }) {
  return <li className={`tr-step ${done ? 'done' : ''}`}>
    <span className="tr-step-dot" aria-hidden="true">{done ? '✓' : index}</span>
    <div className="tr-step-body"><div className="tr-step-head"><h3>{title}</h3><p className="tr-step-meta">{meta}</p></div>{children}</div>
  </li>;
}

export type DeliveryAction = { action: 'stage'; paths: string[] } | { action: 'unstage'; paths: string[] } | { action: 'commit'; message: string } | { action: 'push'; remote: string }
  | { action: 'pr'; title: string; body: string; base: string; draft: boolean; task: string };
/** What Changes knows of the repository for staging and shipping, shared by its file list and its Ship column (1.31.3). */
export interface Delivery { state: DeliveryStatus | null; notRepository: boolean; busy: boolean; error: string; result: DeliveryResult | null; reload: () => void; run: (request: DeliveryAction) => Promise<boolean>; fail: (message: string) => void }

/**
 * Reads the repository for delivery, again when the page's Refresh (revision) or an action changes it, and runs
 * stage, unstage, commit, push and pull request with the fingerprint read last. Every write or remote action still
 * needs native confirmation and a fresh fingerprint; there is no force push or discard.
 */
export function useDelivery(directory: string, revision: number, onChanged: () => void): Delivery {
  const [state, setState] = useState<DeliveryStatus | null>(null); const [notRepository, setNotRepository] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<DeliveryResult | null>(null);
  async function refresh() {
    if (!window.codingHub) throw new Error('This feature requires the desktop app.');
    const answer = await window.codingHub.workbench({ action: 'flow-git-inspect', directory });
    // NOT_A_REPOSITORY only hides the column; any other failure is shown, or it would have nowhere to show.
    if (!answer.ok) { if (answer.error.code !== 'NOT_A_REPOSITORY') { setNotRepository(false); throw new Error(answer.error.message); } setNotRepository(true); setState(null); return; }
    setNotRepository(false); setState(answer.value as DeliveryStatus);
  }
  /** Checks again, and clears an error a check before left. */
  const reload = () => { setError(''); void refresh().catch((e) => setError((e as Error).message)); };
  // Another folder: nothing of the last one stays. No folder (Files, or Changes with nothing open): nothing is read.
  useEffect(() => { setState(null); setResult(null); setNotRepository(false); }, [directory]);
  useEffect(() => { if (directory) reload(); }, [directory, revision]);
  /** True when it was done; its output (and a pull request's address) stays in `result`. */
  async function run(request: DeliveryAction) {
    if (!state) return false; setBusy(true); setError(''); setResult(null);
    try {
      const ref = { directory: state.directory, revision: state.revision };
      const value = await workbench<DeliveryResult | null>(request.action === 'stage' || request.action === 'unstage' ? { action: request.action === 'stage' ? 'flow-git-stage' : 'flow-git-unstage', ...ref, paths: request.paths }
        : request.action === 'commit' ? { action: 'flow-git-commit', ...ref, message: request.message } : request.action === 'push' ? { action: 'flow-git-push', ...ref, remote: request.remote }
          : { action: 'flow-git-pr', ...ref, title: request.title, body: request.body, base: request.base, draft: request.draft });
      if (request.action === 'pr' && value?.url && request.task) { try { await workbench({ action: 'task-pr', id: request.task, url: value.url }); await loadTasks(); } catch { /* The pull request stands; only the task link is missing. */ } }
      setResult(value); await refresh(); onChanged(); return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  return { state, notRepository, busy, error, result, reload, run, fail: setError };
}

/**
 * Commit, push and pull request beside the diff: the Ship column. Staging is in the file list (1.31.3; before, a
 * second list of check boxes here staged files apart from the list beside the diff). A step shows a check once it is
 * done: Commit once nothing staged is left after a commit here, Push while the branch is not ahead of its upstream,
 * Pull request once one was created here.
 */
export function GitDeliveryPanel({ delivery, directory }: { delivery: Delivery; directory: string }) {
  const { state, busy, error, result, reload, run } = delivery;
  const [message, setMessage] = useState(''); const [remote, setRemote] = useState('');
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [base, setBase] = useState('main'); const [draft, setDraft] = useState(true);
  const [committed, setCommitted] = useState(false); const [opened, setOpened] = useState(false);
  // The task this pull request is for, chosen by the person; none by default, so no task takes another's pull request.
  const openTasks = useTaskStore((s) => s.tasks).filter((task) => (task.status === 'active' || task.status === 'review') && task.directory.replace(/[\\/]+$/, '').toLowerCase() === directory.replace(/[\\/]+$/, '').toLowerCase()); const [forTask, setForTask] = useState('');
  useEffect(() => { if (state) setRemote((current) => state.remotes.includes(current) ? current : state.upstream?.split('/')[0] && state.remotes.includes(state.upstream.split('/')[0]) ? state.upstream.split('/')[0] : state.remotes[0] ?? ''); }, [state]);
  if (delivery.notRepository) return null;
  const clean = Boolean(state && !state.staged.length && !state.unstaged.length);
  const pushed = Boolean(state?.upstream) && state?.ahead === 0;
  return <aside className="delivery-panel tr-delivery ui-card" aria-label="Git delivery">
    <header className="ui-card-head"><GitPullRequestArrow size={16} /><h2>Ship</h2>{state?.branch && <span className="ui-badge neutral tr-ship-branch" title={state.upstream ? `${state.branch} → ${state.upstream}` : state.branch}>{state.branch}</span>}<div className="ui-card-actions"><button className="icon-button" aria-label="Refresh delivery state" title="Refresh delivery state" disabled={busy} onClick={reload}><RefreshCw size={16} /></button></div></header>
    {error && <div role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
    {/* Only the steps scroll. The head, an error, the last step's output and the closing note stay in sight. */}
    <div className="tr-delivery-scroll">
    {!state ? !error && <p className="tr-step-meta" role="status"><LoaderCircle size={12} className="spin" />Reading the repository…</p> : <ol className="tr-steps">
      <Step index={1} title="Commit" meta={state.staged.length ? `${state.staged.length} staged ${state.staged.length === 1 ? 'file' : 'files'} ready` : state.unstaged.length ? 'Stage files in the list first' : 'Nothing to commit'} done={committed && !state.staged.length}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void run({ action: 'commit', message }).then((done) => { if (done) { setMessage(''); setCommitted(true); } }); }}><textarea aria-label="Delivery commit message" placeholder="Commit message" value={message} required maxLength={2000} rows={3} onChange={(e) => setMessage(e.target.value)} /><button className="button primary" disabled={busy || !state.staged.length}>Commit staged changes</button></form>
      </Step>
      <Step index={2} title="Push" meta={!state.branch ? 'Detached HEAD · nothing to push' : state.upstream ? `${state.branch} → ${state.upstream} · ${state.ahead ? `${state.ahead} to push` : 'up to date'}${state.behind ? ` · ${state.behind} behind` : ''}` : `${state.branch} → ${remote || 'no remote'} · not pushed yet`} done={pushed}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void run({ action: 'push', remote }); }}>{state.remotes.length > 1 && <select aria-label="Delivery remote" value={remote} onChange={(e) => setRemote(e.target.value)}>{state.remotes.map((name) => <option key={name}>{name}</option>)}</select>}<button className="button secondary" disabled={busy || !remote || !state.branch || pushed}>Push current branch</button></form>
      </Step>
      <Step index={3} title="Pull request" meta={clean ? 'Uses the GitHub CLI (gh) login' : 'Commit or stash changes first'} done={opened}>
        <form className="delivery-form" onSubmit={(e) => { e.preventDefault(); void run({ action: 'pr', title, body, base, draft, task: forTask }).then((done) => { if (done) { setTitle(''); setBody(''); setForTask(''); setOpened(true); } }); }}>
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
    {result && <div role="status" className="tr-delivery-result"><pre className="check-output">{result.output}</pre>{result.url && <button className="button secondary" onClick={() => void workbench({ action: 'flow-open-pr', url: result.url! }).catch((e: Error) => delivery.fail(e.message))}>Open created pull request</button>}</div>}
    <p className="tr-step-note ui-hint">Each step shows a native confirmation first. No force push or discard.</p>
  </aside>;
}
