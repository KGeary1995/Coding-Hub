import { useEffect, useState, type DragEvent } from 'react';
import { ClipboardList, Send } from 'lucide-react';
import type { Task, VerificationData } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { channelNumber, channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { channelNameNow } from '../state/channel-names';
import { loadTasks, refreshTaskWatch, removeTask, saveTask, sendTask, setTaskStatus, TASK_COLUMNS, useTaskStore } from '../state/task-store';

const EMPTY_FORM = { id: '', title: '', details: '', sessionId: '', directory: '', files: '', notes: '', verificationId: '' };
/** "Only these files": blank means the whole project. */
const scopeOf = (files: string) => { const list = files.split('\n').map((line) => line.trim()).filter(Boolean); return list.length ? list : ['**']; };
const limitedTo = (task: Task) => task.scope.some((pattern) => pattern === '**' || pattern === '*') ? null : task.scope;

/**
 * Task coordination: give each agent a job and the files it may change. Trace types the task into the channel, moves it
 * along as the agent works (task-store), and warns when an agent changes files outside its task or the same files as
 * another task.
 */
export function TasksPanel() {
  const { sessions, rootDirectory } = useWorkspaceStore();
  const { tasks, watch, draftFor, error } = useTaskStore();
  const [form, setForm] = useState(EMPTY_FORM); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const [checks, setChecks] = useState<VerificationData>({ profiles: [], results: [], running: false });
  // A Round Table's hidden partner is not offered: tasks go to the channel that leads it.
  const agents = channelsOf(sessions).filter((session) => session.config.engine !== 'shell');
  const folderOf = (sessionId: string) => { const session = sessions.find((item) => item.id === sessionId); return session ? session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory) ?? '' : rootDirectory ?? ''; };
  const channelLabel = (sessionId: string | null) => { const number = channelNumber(sessions, sessionId); const session = sessions.find((item) => item.id === sessionId); return number && session ? `CH${number} · ${channelNameNow(session)}` : 'No channel'; };
  useEffect(() => { void loadTasks().then(() => refreshTaskWatch()); void workbench<VerificationData>({ action: 'verification-list' }).then(setChecks).catch(() => {}); }, []);
  // "Task" on a channel opens the form for it.
  useEffect(() => { if (!draftFor) return; setForm({ ...EMPTY_FORM, sessionId: draftFor, directory: folderOf(draftFor) }); setOpen(true); useTaskStore.setState({ draftFor: null }); }, [draftFor]);
  const run = async (work: () => Promise<unknown>, done = '') => { setBusy(true); setNote(''); useTaskStore.setState({ error: '' }); try { await work(); if (done) setNote(done); } catch (e) { useTaskStore.setState({ error: (e as Error).message }); } finally { setBusy(false); } };
  const submit = (send: boolean) => run(async () => {
    const saved = await saveTask({ ...(form.id ? { id: form.id } : {}), title: form.title, details: form.details, directory: form.directory || folderOf(form.sessionId), sessionId: form.sessionId || null, scope: scopeOf(form.files), status: form.id ? tasks.find((task) => task.id === form.id)?.status ?? 'queued' : 'queued', notes: form.notes, verificationId: form.verificationId || null });
    setForm(EMPTY_FORM); setOpen(false);
    if (send) await sendTask(saved.id);
  }, send ? 'Sent. The task moves to Ready for review when the agent finishes.' : 'Saved in To do.');
  const edit = (task: Task) => { setForm({ id: task.id, title: task.title, details: task.details ?? '', sessionId: task.sessionId ?? '', directory: task.directory, files: limitedTo(task)?.join('\n') ?? '', notes: task.notes, verificationId: task.verificationId ?? '' }); setOpen(true); };
  const drop = (status: Task['status']) => (event: DragEvent) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task'); if (id) void run(() => setTaskStatus(id, status)); };
  const running = (sessionId: string | null) => sessions.some((session) => session.id === sessionId && session.status === 'running');
  const warningsFor = (id: string) => watch.warnings.filter((warning) => warning.taskIds.includes(id));

  return <section className="feature-panel hub-panel task-panel">
    <div className="feature-panel-heading"><span className="eyebrow">COORDINATE YOUR AGENTS</span><h1><ClipboardList size={26} />Tasks</h1>
      <p>Give each agent a job, and if you like the files it may change. Trace types the task into the channel, moves it along as the agent works, and warns you when an agent changes files outside its task or the same files as another task.</p></div>
    {error && <p className="error-message" role="alert">{error}</p>}{note && <p className="muted" role="status">{note}</p>}
    {!tasks.length && !open && <ol className="task-howto"><li><strong>Write a task</strong> and pick the channel to do it, or press <strong>Task</strong> on a channel.</li><li><strong>Send it.</strong> Trace types it into that agent, with its files and a request to say what it changed.</li><li><strong>Check the result.</strong> When the agent finishes, the task moves to Ready for review with the files it changed. Look them over and mark it done.</li></ol>}
    {open ? <form className="hub-form task-form" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
      <label>What should the agent do?<input aria-label="Task title" required maxLength={150} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="For example: Add a dark mode switch to Settings" /></label>
      <label>More details (optional)<textarea aria-label="Task details" rows={3} maxLength={2000} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="What it should look like, what to avoid, how to check it" /></label>
      <label>Channel<select aria-label="Task agent session" value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value, directory: e.target.value ? folderOf(e.target.value) : form.directory })}><option value="">Choose later</option>{agents.map((session) => <option key={session.id} value={session.id}>{channelLabel(session.id)}{session.status === 'running' ? '' : ' (not running)'}</option>)}</select></label>
      <label>Project folder<div className="input-with-button"><input aria-label="Task directory" required value={form.directory || folderOf(form.sessionId)} onChange={(e) => setForm({ ...form, directory: e.target.value })} /><button type="button" className="button secondary" onClick={() => void window.codingHub?.pickDirectory().then((value) => { if (value) setForm({ ...form, directory: value }); })}>Browse</button></div></label>
      <label>Only these files or folders (optional, one per line; empty means the whole project)<textarea aria-label="Task file scope" rows={2} value={form.files} onChange={(e) => setForm({ ...form, files: e.target.value })} placeholder={'src/settings/**\nREADME.md'} /></label>
      <details><summary>Review notes and checks</summary>
        <label>Notes (optional)<textarea aria-label="Task review notes" rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <label>Passing check (from Verification profiles)<select aria-label="Task verification evidence" value={form.verificationId} onChange={(e) => setForm({ ...form, verificationId: e.target.value })}><option value="">None</option>{checks.results.filter((r) => r.passed && r.directory === (form.directory || folderOf(form.sessionId))).map((r) => <option key={r.id} value={r.id}>{r.profileName} · {new Date(r.endedAt).toLocaleString()}</option>)}</select></label>
      </details>
      <div className="hub-toolbar"><button className="button primary" type="button" disabled={busy || !form.title.trim() || !form.sessionId || !running(form.sessionId)} title={form.sessionId && !running(form.sessionId) ? 'Start that channel first' : undefined} onClick={() => void submit(true)}><Send size={13} />Save and send</button><button className="button secondary" disabled={busy || !form.title.trim()}>{form.id ? 'Save' : 'Save to To do'}</button><button type="button" className="quiet-button" onClick={() => { setForm(EMPTY_FORM); setOpen(false); }}>Cancel</button></div>
    </form> : <div className="hub-toolbar"><button className="button primary" onClick={() => { setForm({ ...EMPTY_FORM, directory: rootDirectory ?? '' }); setOpen(true); }}>New task</button></div>}
    {tasks.length > 0 && <div className="task-board">{TASK_COLUMNS.map((column) => <section key={column.status} onDragOver={(e) => e.preventDefault()} onDrop={drop(column.status)} aria-label={column.label}>
      <h2>{column.label} <small>{column.hint}</small></h2>
      {tasks.filter((task) => task.status === column.status).map((task) => {
        const changed = watch.changed[task.id] ?? []; const warnings = warningsFor(task.id); const files = limitedTo(task);
        return <article key={task.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/task', task.id)} className={warnings.length ? 'warned' : ''}>
          <strong>{task.title}</strong>
          <small>{channelLabel(task.sessionId)}{files ? ` · only ${files.join(', ')}` : ''}</small>
          {task.details && <p>{task.details}</p>}
          {changed.length > 0 && <details><summary>{changed.length} {changed.length === 1 ? 'file' : 'files'} changed</summary><ul>{changed.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>}
          {warnings.map((warning) => <p key={warning.text} className="error-message">{warning.text}</p>)}
          {task.notes && <small>{task.notes}</small>}
          <div className="task-actions">
            {(task.status === 'queued' || task.status === 'review') && task.sessionId && <button className="quiet-button" disabled={busy || !running(task.sessionId)} title={running(task.sessionId) ? 'Type this task into its channel' : 'Start that channel first'} onClick={() => void run(() => sendTask(task.id), 'Sent.')}><Send size={12} />{task.status === 'review' ? 'Send again' : 'Send'}</button>}
            {task.status === 'active' && <button className="quiet-button" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'review'))}>Ready for review</button>}
            {task.status === 'review' && <button className="quiet-button" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'done'))}>Mark done</button>}
            {task.status === 'done' && <button className="quiet-button" disabled={busy} onClick={() => void run(() => setTaskStatus(task.id, 'review'))}>Reopen</button>}
            <button className="quiet-button" onClick={() => edit(task)}>Edit</button>
            <button className="quiet-button" disabled={busy} onClick={() => void run(() => removeTask(task.id))}>Remove</button>
          </div>
        </article>;
      })}
    </section>)}</div>}
  </section>;
}
