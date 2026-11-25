import { createElement, useEffect, useState, type DragEvent } from 'react';
import { ClipboardList, FolderOpen, GitBranch, GitPullRequest, Inbox, Plus, Send, CircleAlert, CircleCheck } from 'lucide-react';
import { MenuButton } from './shell/MenuButton';
import { ENGINE_ICONS } from './tile/engine-icons';
import type { Task, TaskDetail, TaskOutcome, VerificationData, VerificationFreshness } from '../../shared/workbench';
import { useChatStore } from '../state/chat-store';
import { startTaskInWorktree } from '../runtime/task-worktree';
import { findingsForTask } from '../state/task-evidence';
import type { Finding } from '../../shared/findings';
import { workbench } from '../runtime/workbench';
import { channelNumber, channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { channelNameNow } from '../state/channel-names';
import { loadTasks, OUTCOME_TEXT, refreshTaskWatch, removeTask, saveTask, sendTask, setTaskStatus, TASK_COLUMNS, useTaskStore } from '../state/task-store';
import { isAgentConfig } from '../../shared/types';
import { ConfirmStep } from './ConfirmStep';
import { ScheduledJobsCard } from './ScheduledJobsCard';

const EMPTY_FORM = { id: '', title: '', details: '', sessionId: '', directory: '', files: '', notes: '', verificationId: '' };
/** "Only these files": blank means the whole project. */
const scopeOf = (files: string) => { const list = files.split('\n').map((line) => line.trim()).filter(Boolean); return list.length ? list : ['**']; };
const limitedTo = (task: Task) => task.scope.some((pattern) => pattern === '**' || pattern === '*') ? null : task.scope;
/** Why Trace flagged a task, as a badge on its card; the sentence under it (OUTCOME_TEXT) says what to do. */
const OUTCOME_BADGE: Record<TaskOutcome, { word: string; tone: string } | null> = { finished: null, quiet: { word: 'Quiet', tone: 'neutral' }, stopped: { word: 'Stopped', tone: 'danger' }, failed: { word: 'Failed', tone: 'danger' }, blocked: { word: 'Needs you', tone: 'waiting' }, unconfirmed: { word: 'Not confirmed', tone: 'warning' } };

/**
 * Task coordination: give each agent a job and the files it may change. Trace types the task into the channel, moves it
 * along as the agent works (task-store), and warns when an agent changes files outside its task or the same files as
 * another task.
 */
/**
 * Everything about one task in one place: what was asked, where (channel, folder, branch, commit), what changed, the check
 * and whether it still holds, the Round Table's findings on its channel, and the pull request opened from it.
 */
/** One empty list, so the store selector returns the same value when there are none. */
const NO_FINDINGS: Finding[] = []; const NO_PROMPTS: string[] = [];
function TaskEverything({ task, channel, changed, check }: { task: Task; channel: string; changed: string[]; check: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null); const [open, setOpen] = useState(false);
  const channelFindings = useChatStore((state) => task.sessionId ? state.threads[task.sessionId]?.table?.findings ?? NO_FINDINGS : NO_FINDINGS);
  // Tasks waiting at a hierarchy table have not started: they neither end this task's findings nor take them.
  const waitingPrompts = useChatStore((state) => task.sessionId ? state.threads[task.sessionId]?.table?.chain?.nextTasks ?? NO_PROMPTS : NO_PROMPTS);
  const tasks = useTaskStore((state) => state.tasks); const findings = findingsForTask(task, tasks, channelFindings, waitingPrompts);
  useEffect(() => { if (open) void workbench<TaskDetail>({ action: 'task-detail', id: task.id }).then(setDetail).catch(() => setDetail(null)); }, [open, task.id, changed.length]);
  const waiting = findings.filter((finding) => finding.status !== 'verified');
  return <details className="task-everything" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}><summary>Everything about this task</summary>
    <dl>
      <dt>Asked</dt><dd>{task.title}{task.details ? <><br />{task.details}</> : null}</dd>
      <dt>Where</dt><dd>{channel} · <code>{task.directory}</code>{detail?.branch ? <> · branch <code>{detail.branch}</code></> : null}{detail?.head ? <> · commit <code>{detail.head}</code></> : null}</dd>
      <dt>Changed</dt><dd>{changed.length ? changed.map((file) => <code key={file}>{file} </code>) : task.sentAt ? 'Nothing since it was sent.' : 'Not sent yet.'}</dd>
      <dt>Check</dt><dd>{check || 'No check attached. Attach a passing one under Edit → Review notes and checks.'}</dd>
      <dt>Review</dt><dd>{findings.length ? `${findings.length} Round Table ${findings.length === 1 ? 'finding' : 'findings'} since it was sent, ${waiting.length} not verified${waiting.length ? `: ${waiting.map((finding) => `${finding.id} ${finding.status}`).join(', ')}` : ''}.` : 'No Round Table findings since it was sent.'}</dd>
      <dt>Pull request</dt><dd>{task.pullRequest ? <button className="quiet-button" onClick={() => void workbench({ action: 'flow-open-pr', url: task.pullRequest! })}>{task.pullRequest.replace('https://github.com/', '')}</button> : 'None. Choose this task when you open a pull request in Changes → Delivery.'}</dd>
    </dl>
  </details>;
}

export function TasksPanel() {
  const { sessions, rootDirectory } = useWorkspaceStore();
  const { tasks, watch, draftFor, error } = useTaskStore();
  const [form, setForm] = useState(EMPTY_FORM); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  /** The task whose Remove was pressed: removing has no undo, so it asks first. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [checks, setChecks] = useState<VerificationData>({ profiles: [], results: [], running: false }); const [fresh, setFresh] = useState<VerificationFreshness>({});
  // A Round Table's hidden seats are not offered: tasks go to the channel that leads it.
  // Tasks read their outcome from the CLI's transcript: Claude Code and Codex only.
  const agents = channelsOf(sessions).filter((session) => isAgentConfig(session.config));
  const folderOf = (sessionId: string) => { const session = sessions.find((item) => item.id === sessionId); return session ? session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory) ?? '' : rootDirectory ?? ''; };
  const channelLabel = (sessionId: string | null) => { const number = channelNumber(sessions, sessionId); const session = sessions.find((item) => item.id === sessionId); return number && session ? `CH${number} · ${channelNameNow(session)}` : 'No channel'; };
  /** Until the first list arrives, the board says it is loading rather than that there are no tasks. */
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { void loadTasks().then(() => { setLoaded(true); return refreshTaskWatch(); }); void workbench<VerificationData>({ action: 'verification-list' }).then(setChecks).catch(() => {}); }, []);
  // Whether each task's check still describes its files, read again with the tasks' changes.
  useEffect(() => { if (tasks.some((task) => task.verificationId)) void workbench<VerificationFreshness>({ action: 'verification-fresh' }).then(setFresh).catch(() => {}); }, [watch, tasks]);
  const checkText = (task: Task) => { const result = checks.results.find((r) => r.id === task.verificationId); if (!result) return ''; const state = fresh[result.id]; return `Check: ${result.profileName} passed` + (state === 'current' ? ' on these files.' : state === 'changed' ? (result.tested?.changedDuring ? ', but files changed while it ran. Run it again.' : ', but files changed since. Run it again.') : '. Trace cannot tell which files it tested.'); };
  // "Task" on a channel opens the form for it.
  useEffect(() => { if (!draftFor) return; setForm({ ...EMPTY_FORM, sessionId: draftFor, directory: folderOf(draftFor) }); setOpen(true); useTaskStore.setState({ draftFor: null }); }, [draftFor]);
  const run = async (work: () => Promise<unknown>, done = '') => { setBusy(true); setNote(''); useTaskStore.setState({ error: '' }); try { await work(); if (done) setNote(done); } catch (e) { useTaskStore.setState({ error: (e as Error).message }); } finally { setBusy(false); } };
  const submit = (send: boolean) => run(async () => {
    const saved = await saveTask({ ...(form.id ? { id: form.id } : {}), title: form.title, details: form.details, directory: form.directory || folderOf(form.sessionId), sessionId: form.sessionId || null, scope: scopeOf(form.files), status: form.id ? tasks.find((task) => task.id === form.id)?.status ?? 'queued' : 'queued', notes: form.notes, verificationId: form.verificationId || null });
    setForm(EMPTY_FORM); setOpen(false);
    if (send) await sendTask(saved.id);
  }, send ? 'Sent. The task moves to Ready for review when the agent says TASK COMPLETE.' : 'Saved in To do.');
  const edit = (task: Task) => { setForm({ id: task.id, title: task.title, details: task.details ?? '', sessionId: task.sessionId ?? '', directory: task.directory, files: limitedTo(task)?.join('\n') ?? '', notes: task.notes, verificationId: task.verificationId ?? '' }); setOpen(true); };
  const drop = (status: Task['status']) => (event: DragEvent) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task'); if (id) void run(() => setTaskStatus(id, status)); };
  const running = (sessionId: string | null) => sessions.some((session) => session.id === sessionId && session.status === 'running');
  /** A channel badge takes its engine's colour. */
  const channelTone = (sessionId: string | null) => sessions.find((item) => item.id === sessionId)?.config.engine ?? 'neutral';
  const warningsFor = (id: string) => watch.warnings.filter((warning) => warning.taskIds.includes(id));

  return <section className="ui-page wide task-panel">
    <header className="ui-page-head"><span className="ui-page-icon" aria-hidden="true"><ClipboardList /></span><div><h1>Tasks</h1>
      <p>Give each channel a job and, if you like, the files it may change.</p></div>
      {!open && <div className="ui-page-actions"><button className="button primary" onClick={() => { setForm({ ...EMPTY_FORM, directory: rootDirectory ?? '' }); setOpen(true); }}><Plus />New task</button></div>}</header>
    {error && <p className="ui-banner danger" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}{note && <p className="ui-banner success" role="status"><CircleCheck aria-hidden="true" /><span>{note}</span></p>}
    <details className="task-howto"><summary>How this works</summary><ol><li><strong>Write a task</strong> and pick the channel to do it, or press <strong>Task</strong> on a channel.</li><li><strong>Send it.</strong> Trace types it into that agent, with its files and a request to say what it changed, and moves it along as the agent works.</li><li><strong>Check the result.</strong> When the agent finishes, the task moves to Ready for review with the files it changed. Look them over and mark it done.</li></ol><p>Trace warns you when an agent changes files outside its task or the same files as another task.</p></details>
    <ScheduledJobsCard />
    {open && <form className="ui-card task-form" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
      <div className="ui-card-head"><ClipboardList aria-hidden="true" /><h2>{form.id ? 'Edit task' : 'New task'}</h2></div>
      <label className="ui-field">What should the agent do?<input aria-label="Task title" required maxLength={150} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="For example: Add a dark mode switch to Settings" /></label>
      <label className="ui-field">More details (optional)<textarea aria-label="Task details" rows={3} maxLength={2000} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="What it should look like, what to avoid, how to check it" /></label>
      <div className="task-form-pair">
        <label className="ui-field">Channel<select aria-label="Task agent channel" value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value, directory: e.target.value ? folderOf(e.target.value) : form.directory })}><option value="">Choose later</option>{agents.map((session) => <option key={session.id} value={session.id}>{channelLabel(session.id)}{session.status === 'running' ? '' : ' (not running)'}</option>)}</select></label>
        <label className="ui-field">Project folder<div className="input-with-button">{/* Its own value: every way into the form sets it, and showing the channel's folder whenever it was empty meant it could not be cleared to type another (before 1.31.5). */}<input aria-label="Task folder" required value={form.directory} onChange={(e) => setForm({ ...form, directory: e.target.value })} /><button type="button" className="button secondary" onClick={() => void window.codingHub?.pickDirectory().then((value) => { if (value) setForm({ ...form, directory: value }); })}><FolderOpen aria-hidden="true" />Choose folder</button></div></label>
      </div>
      <label className="ui-field">Only these files or folders (optional)<textarea aria-label="Task file scope" rows={2} value={form.files} onChange={(e) => setForm({ ...form, files: e.target.value })} placeholder={'src/settings/**\nREADME.md'} /><small className="ui-hint">One per line. Empty means the whole project.</small></label>
      <details><summary>Review notes and checks</summary>
        <label className="ui-field">Notes (optional)<textarea aria-label="Task review notes" rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <label className="ui-field">Passing check (from Verification profiles)<select aria-label="Task verification evidence" value={form.verificationId} onChange={(e) => setForm({ ...form, verificationId: e.target.value })}><option value="">None</option>{checks.results.filter((r) => r.passed && r.directory === (form.directory || folderOf(form.sessionId))).map((r) => <option key={r.id} value={r.id}>{r.profileName} · {new Date(r.endedAt).toLocaleString()}</option>)}</select></label>
      </details>
      <div className="ui-actions"><button className="button primary" type="button" disabled={busy || !form.title.trim() || !form.sessionId || !running(form.sessionId)} title={form.sessionId && !running(form.sessionId) ? 'Start that channel first' : undefined} onClick={() => void submit(true)}><Send />Save and send</button><button className="button secondary" disabled={busy || !form.title.trim()}>{form.id ? 'Save' : 'Save to To do'}</button><button type="button" className="quiet-button" onClick={() => { setForm(EMPTY_FORM); setOpen(false); }}>Cancel</button></div>
    </form>}
    <div className="task-board">{TASK_COLUMNS.map((column) => { const inColumn = tasks.filter((task) => task.status === column.status); return <section key={column.status} className="ui-card task-column" onDragOver={(e) => e.preventDefault()} onDrop={drop(column.status)} aria-label={column.label}>
      <div className="ui-card-head"><h2>{column.label}</h2><span className={`ui-count ${inColumn.length ? 'accent' : 'neutral'}`}>{inColumn.length}</span></div>
      <p className="task-column-hint">{column.hint}</p>
      {!inColumn.length && (column.status === 'queued' && !tasks.length ? <div className="ui-empty task-column-empty"><ClipboardList aria-hidden="true" /><h3>{!loaded ? 'Loading tasks…' : error ? 'No tasks to show' : 'No tasks yet'}</h3>{!(loaded && error) && <p>{loaded ? 'Press New task, or Task on a channel.' : 'Reading your saved tasks.'}</p>}</div> : <div className="ui-empty task-column-empty"><Inbox aria-hidden="true" /><h3>No tasks here</h3></div>)}
      {inColumn.map((task) => {
        const changed = watch.changed[task.id] ?? []; const warnings = warningsFor(task.id); const files = limitedTo(task);
        const outcome = task.outcome && OUTCOME_BADGE[task.outcome];
        return <article key={task.id} id={`task-${task.id}`} tabIndex={-1} draggable onDragStart={(e) => e.dataTransfer.setData('text/task', task.id)} className={`ui-card task-card ${warnings.length ? 'warned' : ''}`}>
          <strong className="task-title">{task.title}</strong>
          <div className="task-badges"><span className={`ui-badge ${channelTone(task.sessionId)}`}>{channelLabel(task.sessionId)}</span>{outcome && <span className={`ui-badge dot ${outcome.tone}`}>{outcome.word}</span>}{warnings.length > 0 && <span className="ui-badge dot danger">{warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}</span>}</div>
          {files && <small>Only {files.join(', ')}</small>}
          {task.details && <p>{task.details}</p>}
          {changed.length > 0 && <details><summary>{changed.length} {changed.length === 1 ? 'file' : 'files'} changed</summary><ul>{changed.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>}
          {warnings.map((warning) => <p key={warning.text} className="error-message">{warning.text}</p>)}
          {task.outcome && OUTCOME_TEXT[task.outcome] && <p className={task.outcome === 'quiet' || task.outcome === 'unconfirmed' ? 'muted' : 'error-message'} role="status">{OUTCOME_TEXT[task.outcome]}{task.outcome === 'blocked' && task.outcomeNote ? ` It says: ${task.outcomeNote}` : ''}</p>}
          {task.verificationId && checkText(task) && <small className={fresh[task.verificationId] === 'current' ? '' : 'muted'}>{checkText(task)}</small>}
          {task.notes && <small className="task-notes">{task.notes}</small>}{task.pullRequest && <button className="quiet-button small" title={task.pullRequest} onClick={() => void workbench({ action: 'flow-open-pr', url: task.pullRequest! })}><GitPullRequest aria-hidden="true" />Pull request #{task.pullRequest.split('/').at(-1)}</button>}
          <TaskEverything task={task} channel={channelLabel(task.sessionId)} changed={changed} check={task.verificationId ? checkText(task) : ''} />
          <div className="task-actions">
            {/* A To do task's one primary action: Send when it has a channel, otherwise starting it in a worktree of its own. */}
            {(task.status === 'queued' || task.status === 'review' || task.status === 'active' && (task.outcome === 'stopped' || task.outcome === 'failed')) && task.sessionId && <button className={`button ${task.status === 'queued' ? 'primary' : 'secondary'} small`} disabled={busy || !running(task.sessionId)} title={running(task.sessionId) ? 'Type this task into its channel' : 'Start that channel first'} onClick={() => void run(() => sendTask(task.id), 'Sent.')}><Send />{task.status === 'queued' ? 'Send' : 'Send again'}</button>}
            {task.status === 'queued' && task.directory && <MenuButton className="task-worktree" buttonClassName={`button ${task.sessionId ? 'secondary' : 'primary'} small`} ariaLabel="Start in worktree" disabled={busy} title="A new branch and folder from the last commit, a new chat channel there, and the task sent to it" label={<><GitBranch aria-hidden="true" />Start in worktree</>}
              items={(['claude', 'codex', 'gemini'] as const).map((engine) => ({ label: `${({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const)[engine]} chat`, icon: <span className={`ui-avatar small ${engine}`} aria-hidden="true">{createElement(ENGINE_ICONS[engine])}</span>, onSelect: () => void run(async () => { const tree = await startTaskInWorktree(task.id, engine); setNote(`Started on ${tree.branch} in ${tree.directory}.${tree.rulesApplied ? ' Shared rules were applied there.' : ''} Uncommitted changes were not copied, and dependencies were not installed.`); }) }))} />}
            {task.status === 'active' && <button className="button secondary small" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'review'))}>Ready for review</button>}
            {task.status === 'review' && <button className="button secondary small" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'done'))}>Mark done</button>}
            {task.status === 'done' && <button className="quiet-button small" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'review'))}>Reopen</button>}
            <button className="quiet-button small" onClick={() => edit(task)}>Edit</button>
            {removing === task.id
              ? <ConfirmStep question={task.status === 'active' ? 'Remove this task while a channel works on it?' : 'Remove this task and its notes?'} action="Remove" busy={busy} onConfirm={() => { setRemoving(null); void run(() => removeTask(task.id)); }} onCancel={() => setRemoving(null)} />
              : <button className="quiet-button small" disabled={busy} onClick={() => setRemoving(task.id)}>Remove</button>}
          </div>
        </article>;
      })}
    </section>; })}</div>
  </section>;
}
