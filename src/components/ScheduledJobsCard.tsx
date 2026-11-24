import { useEffect, useState } from 'react';
import { AlarmClock, FolderOpen, Pause, Play, Plus, Trash2 } from 'lucide-react';
import type { JobRun, JobSchedule, ScheduledJob, ScheduledJobData, WorkbenchRequest } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { loadTasks } from '../state/task-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { lookOf, useAgentStore } from '../state/agent-store';
import type { AgentEntry } from '../../shared/agents';
import { ConfirmStep } from './ConfirmStep';

type Engine = ScheduledJob['engine'];
export const JOB_AGENTS: Record<Exclude<Engine, 'custom'>, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
/** A job's agent by name: a custom agent's own (docs/custom-agents.md). */
const jobAgent = (job: Pick<ScheduledJob, 'engine' | 'agent'>, agents: AgentEntry[]) => job.engine === 'custom' ? lookOf(agents, job.agent ?? '').name : JOB_AGENTS[job.engine];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = [1, 2, 3, 4, 6, 8, 12];
/** Ready-made jobs to start from: the person can change any of it. */
export const JOB_EXAMPLES = [
  { name: 'Update dependencies and run the tests', prompt: 'Update this project’s dependencies to their latest compatible versions, then run the tests and the type checks. Fix what the update broke. If something cannot be fixed safely, undo that update and tell me why.' },
  { name: 'Fix warnings and tidy up', prompt: 'Run the project’s build, linter and type checks, and fix the warnings they report. Remove unused code and imports. Do not change how anything behaves.' },
  { name: 'Review the code for bugs', prompt: 'Review the code changed since yesterday for bugs, security problems and missing tests. Do not change any files: list what you found, most serious first, with the file and line.' },
];
/** A schedule in a sentence: "Every day at 08:00", "Mon, Wed and Fri at 09:30", "Every 6 hours (02:00, 08:00, 14:00, 20:00)". */
export function describeSchedule(plan: JobSchedule) {
  if (plan.kind === 'daily') return `Every day at ${plan.time}`;
  if (plan.kind === 'weekdays') { const names = [...plan.days].sort().map((day) => DAYS[day]); return `${names.length === 7 ? 'Every day' : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} at ${plan.time}`; }
  const [hour, minute] = plan.time.split(':'); const times = Array.from({ length: 24 / plan.every }, (_, index) => `${String(Number(hour) % plan.every + index * plan.every).padStart(2, '0')}:${minute}`);
  return plan.every === 1 ? `Every hour at :${minute}` : `Every ${plan.every} hours${times.length <= 6 ? ` (${times.join(', ')})` : ''}`;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** The last run's line: when, and what happened. */
export function lastRunText(run: JobRun) { return `${when(run.at)}: ${run.result === 'missed' ? `Missed. ${run.note}` : run.note}`; }
/** Brings a task's card on the board into view. */
function showTask(id: string) { const card = document.getElementById(`task-${id}`); card?.scrollIntoView({ behavior: 'smooth', block: 'center' }); card?.focus(); }

const EMPTY = { id: '', name: '', engine: 'claude' as Engine, agent: '', directory: '', prompt: '', kind: 'daily' as JobSchedule['kind'], time: '08:00', days: [1, 2, 3, 4, 5], every: 6 };

/**
 * Tasks → Scheduled jobs (1.39.0): a request an agent gets by itself at set times. The host keeps the clock and the jobs
 * (electron/services/workbench/scheduled-jobs.ts); each run opens a channel here and shows on the board as a task.
 */
export function ScheduledJobsCard() {
  const rootDirectory = useWorkspaceStore((state) => state.rootDirectory); const agents = useAgentStore((state) => state.agents);
  const [data, setData] = useState<ScheduledJobData>({ jobs: [] }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY); const [open, setOpen] = useState(false); const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () => workbench<ScheduledJobData>({ action: 'job-list' }).then(setData).catch((e: Error) => setError(e.message));
  // Runs happen on the host's clock: the list is read again when a run changes the board, and every 30 s for the next times.
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 30000); const unsubscribe = window.codingHub?.onTasksChanged(() => void refresh()); return () => { clearInterval(timer); unsubscribe?.(); }; }, []);
  const act = async (request: WorkbenchRequest, after?: () => void) => { setBusy(true); setError(''); try { setData(await workbench<ScheduledJobData>(request)); after?.(); await loadTasks(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const schedule = (): JobSchedule => form.kind === 'daily' ? { kind: 'daily', time: form.time } : form.kind === 'weekdays' ? { kind: 'weekdays', time: form.time, days: form.days } : { kind: 'hours', every: form.every, time: form.time };
  const edit = (job: ScheduledJob) => { setForm({ ...EMPTY, id: job.id, name: job.name, engine: job.engine, agent: job.agent ?? '', directory: job.directory, prompt: job.prompt, kind: job.schedule.kind, time: job.schedule.time, ...(job.schedule.kind === 'weekdays' ? { days: job.schedule.days } : {}), ...(job.schedule.kind === 'hours' ? { every: job.schedule.every } : {}) }); setOpen(true); };
  const close = () => { setForm(EMPTY); setOpen(false); };
  const submit = () => act({ action: 'job-save', ...(form.id ? { id: form.id } : {}), name: form.name, engine: form.engine, ...(form.engine === 'custom' ? { agent: form.agent } : {}), directory: form.directory, prompt: form.prompt, schedule: schedule() }, close);

  return <section className="ui-card scheduled-jobs" aria-labelledby="scheduled-jobs-title">
    <div className="ui-card-head"><AlarmClock aria-hidden="true" /><h2 id="scheduled-jobs-title">Scheduled jobs</h2><span className={`ui-count ${data.jobs.length ? 'accent' : 'neutral'}`}>{data.jobs.length}</span>
      {!open && <button type="button" className="button secondary small" onClick={() => { setForm({ ...EMPTY, directory: rootDirectory ?? '' }); setOpen(true); }}><Plus aria-hidden="true" />New scheduled job</button>}</div>
    <p className="ui-hint">An agent does a job by itself at the times you choose, such as every morning. Each run opens a new channel in the job’s folder and appears on this board as a task. Trace must be running at that time: closing its window keeps it running in the tray. A run that was missed while Trace was closed runs when Trace opens, if it was due in the last 12 hours. When a new run starts, the channel of the job’s last run is closed once that run’s task is finished.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {data.jobs.length > 0 && <ul className="ui-list">{data.jobs.map((job) => <li key={job.id} className="ui-row scheduled-job">
      <span className="ui-row-main"><strong>{job.name}</strong>
        <small>{jobAgent(job, agents)} · {describeSchedule(job.schedule)} · <code title={job.directory}>{job.directory}</code></small>
        <small>{job.paused ? 'Paused' : job.running ? 'Running now' : job.nextAt ? `Next run: ${when(job.nextAt)}` : ''}</small>
        {job.lastRun && <small className={job.lastRun.result === 'failed' ? 'error-message' : 'ui-hint'}>Last run {lastRunText(job.lastRun)}{job.lastRun.taskId && <> <button type="button" className="quiet-button small" onClick={() => showTask(job.lastRun!.taskId!)}>Show its task</button></>}</small>}</span>
      <span className="scheduled-job-actions">
        <button type="button" className="button secondary small" disabled={busy || job.running} title={job.running ? 'Its last run is still going' : 'Run it once now'} onClick={() => void act({ action: 'job-run', id: job.id })}><Play aria-hidden="true" />Run now</button>
        <button type="button" className="quiet-button small" disabled={busy} onClick={() => edit(job)}>Edit</button>
        <button type="button" className="quiet-button small" disabled={busy} onClick={() => void act({ action: 'job-pause', id: job.id, paused: !job.paused })}>{job.paused ? <><Play aria-hidden="true" />Resume</> : <><Pause aria-hidden="true" />Pause</>}</button>
        {removing === job.id ? <ConfirmStep question="Delete this scheduled job? Its past tasks stay." action="Delete job" busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => { setRemoving(null); void act({ action: 'job-delete', id: job.id }); }} /> : <button type="button" className="icon-button" aria-label={`Delete ${job.name}`} disabled={busy} onClick={() => setRemoving(job.id)}><Trash2 size={14} aria-hidden="true" /></button>}
      </span></li>)}</ul>}
    {open && <form className="scheduled-job-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {!form.id && <div className="scheduled-job-examples"><span className="ui-hint">Start from an example:</span>{JOB_EXAMPLES.map((example) => <button key={example.name} type="button" className="button secondary small" onClick={() => setForm({ ...form, name: example.name, prompt: example.prompt })}>{example.name}</button>)}</div>}
      <label className="ui-field">Name<input aria-label="Job name" required maxLength={150} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="For example: Update dependencies and run the tests" /></label>
      <label className="ui-field">What should the agent do?<textarea aria-label="Job request" required rows={3} maxLength={2000} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} /></label>
      <div className="task-form-pair">
        <label className="ui-field">Agent<select aria-label="Job agent" value={form.engine === 'custom' ? `custom:${form.agent}` : form.engine} onChange={(e) => { const value = e.target.value; setForm(value.startsWith('custom:') ? { ...form, engine: 'custom', agent: value.slice(7) } : { ...form, engine: value as Engine, agent: '' }); }}>{Object.entries(JOB_AGENTS).map(([engine, label]) => <option key={engine} value={engine}>{label}</option>)}{agents.filter((agent) => agent.active || agent.id === form.agent).map((agent) => <option key={agent.id} value={`custom:${agent.id}`}>{agent.look.name}</option>)}</select></label>
        <label className="ui-field">Project folder<div className="input-with-button"><input aria-label="Job folder" required value={form.directory} onChange={(e) => setForm({ ...form, directory: e.target.value })} /><button type="button" className="button secondary" onClick={() => void window.codingHub?.pickDirectory().then((value) => { if (value) setForm((current) => ({ ...current, directory: value })); })}><FolderOpen aria-hidden="true" />Choose folder</button></div></label>
      </div>
      <div className="scheduled-job-when">
        <label className="ui-field">When<select aria-label="Job schedule" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as JobSchedule['kind'] })}><option value="daily">Every day at</option><option value="weekdays">On these days at</option><option value="hours">Every few hours</option></select></label>
        {form.kind === 'hours' && <label className="ui-field">Every<select aria-label="Job hours" value={form.every} onChange={(e) => setForm({ ...form, every: Number(e.target.value) })}>{HOURS.map((hours) => <option key={hours} value={hours}>{hours === 1 ? '1 hour' : `${hours} hours`}</option>)}</select></label>}
        <label className="ui-field">{form.kind === 'hours' ? 'Starting at' : 'Time'}<input type="time" aria-label="Job time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
      </div>
      {form.kind === 'weekdays' && <fieldset className="scheduled-job-days"><legend>Days</legend>{DAYS.map((day, index) => <label key={day} className="ui-check"><input type="checkbox" checked={form.days.includes(index)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, index].sort() : form.days.filter((item) => item !== index) })} />{day}</label>)}</fieldset>}
      <small className="ui-hint">{describeSchedule(schedule())}, on this computer’s clock, while Trace is running.{form.engine === 'gemini' ? ' Trace cannot read Gemini’s replies, so you move its tasks on yourself.' : ''}</small>
      <div className="ui-actions"><button className="button primary" disabled={busy || !form.name.trim() || !form.prompt.trim() || !form.directory.trim() || form.kind === 'weekdays' && !form.days.length}>{form.id ? 'Save' : 'Add scheduled job'}</button><button type="button" className="quiet-button" onClick={close}>Cancel</button></div>
    </form>}
  </section>;
}
