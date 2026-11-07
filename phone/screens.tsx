import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlanLimits } from '../shared/plan-limits';
import { api } from './api';

/**
 * The phone's other screens (Usage, Tasks, History, More), in React on the desktop's tokens. Each reads this computer's
 * routes (remote-server.ts); acting (moving a task, resuming a conversation) needs Can start and stop agents, which the
 * computer checks and the screen says.
 */

// The routes' shapes (shared/remote.ts once merged).
export interface RemoteUsage { day: string; tokens: { claude: number; codex: number }; cost: number | null; complete: boolean; limits: PlanLimits[]; budget: { tokens: number | null; dollars: number | null; warnAt: number } | null }
export interface RemoteTask { id: string; title: string; status: 'todo' | 'working' | 'review' | 'done'; sessionId: string | null; channel: number | null; files: string[]; updatedAt: string }
export interface RemoteHistoryItem { key: string; engine: 'claude' | 'codex'; title: string; folder: string; modified: string }
export interface RemoteMemory { project: string; name: string; notes: { id: string; title: string; author: 'claude' | 'codex' | 'human'; createdAt: string; content: string }[] }

const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
const when = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** Loads a route, with a reload; `null` while loading. */
function useRoute<T>(path: string): [T | null, string, () => void] {
  const [value, setValue] = useState<T | null>(null); const [error, setError] = useState(''); const [load, setLoad] = useState(0);
  useEffect(() => { let active = true; setError(''); api(path).then((response) => response.json() as Promise<T>).then((data) => { if (active) setValue(data); }).catch((e) => { if (active) setError((e as Error).message); }); return () => { active = false; }; }, [path, load]);
  return [value, error, () => setLoad((count) => count + 1)];
}

/** A segmented gauge: 10 cells, filled to `ratio`, in `color` (the limit colour past 80%). */
function Gauge({ ratio, color, label }: { ratio: number; color: string; label: string }) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * 10);
  return <div className="gauge" role="img" aria-label={label}>{Array.from({ length: 10 }, (_, index) => <i key={index} style={{ background: index < filled ? (ratio >= 0.8 ? 'var(--tr-st-limit)' : color) : undefined }} />)}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="phone-card"><h2>{title}</h2>{children}</section>; }

function UsageScreen() {
  const [usage, error, reload] = useRoute<RemoteUsage>('/api/usage');
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!usage) return <p className="dim">Loading…</p>;
  const total = usage.tokens.claude + usage.tokens.codex;
  const budgetShare = usage.budget?.tokens ? total / usage.budget.tokens : usage.budget?.dollars && usage.cost !== null ? usage.cost / usage.budget.dollars : null;
  return <>
    <Section title="Σ Today">
      <p className="metric">{compact(total)} <small>tok</small>{usage.cost !== null && <span className="metric-side">${usage.cost.toFixed(2)}</span>}</p>
      <p className="dim mono"><span style={{ color: 'var(--tr-ch-claude)' }}>■</span> Claude {compact(usage.tokens.claude)} · <span style={{ color: 'var(--tr-ch-codex)' }}>■</span> Codex {compact(usage.tokens.codex)}{usage.complete ? '' : ' · still reading logs'}</p>
      {budgetShare !== null && <><p className="dim mono">Daily budget {Math.round(budgetShare * 100)}%{usage.budget?.dollars ? ` of $${usage.budget.dollars}` : usage.budget?.tokens ? ` of ${compact(usage.budget.tokens)} tok` : ''}</p><Gauge ratio={budgetShare} color="var(--tr-ch-codex)" label={`Daily budget ${Math.round(budgetShare * 100)}% used`} /></>}
    </Section>
    <Section title="Plan limits">
      {!usage.limits.length && <p className="dim">No limits reported yet.</p>}
      {usage.limits.map((limit) => <div key={`${limit.engine}-${limit.account}`} className="limit">
        <p><strong>{limit.engine === 'claude' ? 'Claude' : 'Codex'}{limit.account !== 'Default' ? ` · ${limit.account}` : limit.signedInAs ? ` · ${limit.signedInAs}` : ''}</strong>{limit.plan && <span className="dim"> {limit.plan}</span>}</p>
        {limit.error && <p className="dim">{limit.error}</p>}
        {limit.windows.map((window) => <div key={window.label} className="limit-row"><span className="mono">{window.label} {Math.round(window.usedPercent)}%</span><Gauge ratio={window.usedPercent / 100} color={limit.engine === 'claude' ? 'var(--tr-ch-claude)' : 'var(--tr-ch-codex)'} label={`${window.label} ${Math.round(window.usedPercent)}% used`} /></div>)}
      </div>)}
      <button type="button" className="quiet" onClick={reload}>Refresh</button>
    </Section>
  </>;
}

const COLUMNS: { status: RemoteTask['status']; label: string }[] = [{ status: 'todo', label: 'To do' }, { status: 'working', label: 'Working' }, { status: 'review', label: 'Ready for review' }, { status: 'done', label: 'Done' }];
function TasksScreen({ canRun }: { canRun: boolean }) {
  const [tasks, error, reload] = useRoute<RemoteTask[]>('/api/tasks'); const [note, setNote] = useState('');
  const move = async (task: RemoteTask, status: RemoteTask['status']) => { setNote(''); try { await post('/api/task-status', { id: task.id, status }); reload(); } catch (e) { setNote((e as Error).message); } };
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!tasks) return <p className="dim">Loading…</p>;
  return <>
    {note && <p className="error" role="alert">{note}</p>}
    {!tasks.length && <p className="dim">No tasks. Give a channel a task on the computer (Task on its tile).</p>}
    {COLUMNS.map((column) => { const list = tasks.filter((task) => task.status === column.status); return list.length ? <Section key={column.status} title={`${column.label} · ${list.length}`}>
      {list.map((task) => <article key={task.id} className="task">
        <p><strong>{task.title}</strong></p>
        <p className="dim mono">{task.channel ? `CH${task.channel} · ` : ''}{when(task.updatedAt)}{task.files.length ? ` · ${task.files.length} file${task.files.length === 1 ? '' : 's'}` : ''}</p>
        {canRun && column.status !== 'done' && <div className="row">{column.status === 'review' && <button type="button" className="primary small" onClick={() => void move(task, 'done')}>Mark done</button>}{column.status === 'todo' && <button type="button" className="small" onClick={() => void move(task, 'working')}>Start working</button>}</div>}
      </article>)}
    </Section> : null; })}
  </>;
}

function HistoryScreen({ canRun }: { canRun: boolean }) {
  const [items, error] = useRoute<RemoteHistoryItem[]>('/api/history'); const [note, setNote] = useState('');
  const resume = async (item: RemoteHistoryItem) => { setNote(''); try { await post('/api/history-resume', { key: item.key }); setNote(`Resumed in a new channel. Open it from Channels to start it.`); } catch (e) { setNote((e as Error).message); } };
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!items) return <p className="dim">Loading…</p>;
  return <>
    {note && <p className="dim" role="status">{note}</p>}
    {!items.length && <p className="dim">No conversations yet.</p>}
    <ul className="history">{items.map((item) => <li key={item.key} className={`history-item engine-${item.engine}`}>
      <div><strong>{item.title || 'Untitled conversation'}</strong><p className="dim mono">{item.engine === 'claude' ? 'Claude Code' : 'Codex'} · {item.folder} · {when(item.modified)}</p></div>
      {canRun && <button type="button" className="small" onClick={() => void resume(item)}>Resume</button>}
    </li>)}</ul>
    {!canRun && items.length > 0 && <p className="dim">To resume a conversation from this phone, turn on Can start and stop agents for it on the computer (Settings → Phone access).</p>}
  </>;
}

function MemoryScreen() {
  const [projects, error, reload] = useRoute<RemoteMemory[]>('/api/memory'); const [project, setProject] = useState(''); const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [note, setNote] = useState('');
  useEffect(() => { if (projects?.length && !projects.some((item) => item.project === project)) setProject(projects[0].project); }, [projects]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!projects) return <p className="dim">Loading…</p>;
  if (!projects.length) return <p className="dim">No projects with channels on this computer yet.</p>;
  const shown = projects.find((item) => item.project === project) ?? projects[0];
  const save = async () => { setNote(''); try { await post('/api/memory', { project: shown.project, title: title.trim(), content: content.trim() }); setTitle(''); setContent(''); setNote('Handoff saved. Both agents see it in their next session.'); reload(); } catch (e) { setNote((e as Error).message); } };
  return <>
    <label className="field">Project<select value={shown.project} onChange={(event) => setProject(event.target.value)}>{projects.map((item) => <option key={item.project} value={item.project}>{item.name}</option>)}</select></label>
    <Section title="Leave a handoff">
      <label className="field">Title<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field">Note<textarea rows={4} value={content} maxLength={20000} onChange={(event) => setContent(event.target.value)} /></label>
      <button type="button" className="primary" disabled={!title.trim() || !content.trim()} onClick={() => void save()}>Save handoff</button>
      {note && <p className="dim" role="status">{note}</p>}
    </Section>
    {shown.notes.map((item) => <details key={item.id} className="phone-card note"><summary><strong>{item.title}</strong><span className="dim mono"> {item.author} · {when(item.createdAt)}</span></summary><p className="note-body">{item.content}</p></details>)}
  </>;
}

export type PhoneScreen = 'usage' | 'tasks' | 'history' | 'memory';
/** Shows one of the phone's screens in `container`; returns the function that removes it. */
export function mountScreen(container: HTMLElement, screen: PhoneScreen, canRun: boolean) {
  const root = createRoot(container);
  root.render(screen === 'usage' ? <UsageScreen /> : screen === 'tasks' ? <TasksScreen canRun={canRun} /> : screen === 'history' ? <HistoryScreen canRun={canRun} /> : <MemoryScreen />);
  return () => root.unmount();
}
