import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { PLAN_NAME, type PlanLimits } from '../shared/plan-limits';
import type { RemoteHistoryItem, RemoteMemory, RemoteTask, RemoteUsage } from '../shared/remote';
import { api } from './api';

/**
 * The phone's other screens (Usage, Tasks, History, More), in React on the desktop's tokens. Each reads this computer's
 * routes (remote-server.ts); acting (moving a task, resuming a conversation) needs Can start and stop agents, which the
 * computer checks and the screen says.
 */

const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
const when = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** Loads a route, with a reload; `null` while loading. */
function useRoute<T>(path: string): [T | null, string, () => void] {
  const [value, setValue] = useState<T | null>(null); const [error, setError] = useState(''); const [load, setLoad] = useState(0);
  useEffect(() => { let active = true; setError(''); api(path).then((response) => response.json() as Promise<T>).then((data) => { if (active) setValue(data); }).catch((e) => { if (active) setError((e as Error).message); }); return () => { active = false; }; }, [path, load]);
  return [value, error, () => setLoad((count) => count + 1)];
}

/** An engine's mark, as on the desktop's tiles (lucide's Asterisk, SquareTerminal, Sparkle and SquareChevronRight). Fixed markup, not data. */
export const ENGINE_ICON: Record<'claude' | 'codex' | 'gemini' | 'custom' | 'shell', string> = {
  claude: '<path d="M12 6v12"/><path d="M17.196 9 6.804 15"/><path d="m6.804 9 10.392 6"/>',
  codex: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  gemini: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  shell: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 8 4 4-4 4"/>',
  // lucide's Bot, for a custom agent wherever its initials are not shown.
  custom: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
export const iconSvg = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
function EngineMark({ engine }: { engine: 'claude' | 'codex' | 'gemini' | 'shell' }) { return <span className={`avatar small ${engine}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(ENGINE_ICON[engine]) }} />; }

/** A meter: a 6 px track filled to `ratio` in `tone` (an engine), or in the limit colour from 80%. */
function Meter({ ratio, tone, label }: { ratio: number; tone: string; label: string }) {
  const share = Math.max(0, Math.min(1, ratio));
  return <div className={`meter ${ratio >= 0.8 ? 'near' : tone}`} role="img" aria-label={label}><i style={{ width: `${share * 100}%` }} /></div>;
}

/** Why a reading has no windows: a failed check in the danger colour, a fact dim. An older Trace's reading has no mark: a fact. */
export function LimitNote({ limit }: { limit: Pick<PlanLimits, 'error' | 'failed'> }) { return limit.error ? <p className={limit.failed === true ? 'limit-failed' : 'dim'}>{limit.error}</p> : null; }

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) { return <section className="phone-card"><h2>{title}{count !== undefined && <span className="count neutral">{count}</span>}</h2>{children}</section>; }
/** No data yet: the card keeps its place, with a title and one line saying why. */
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg><strong>{title}</strong><p>{children}</p></div>; }

function UsageScreen() {
  const [usage, error, reload] = useRoute<RemoteUsage>('/api/usage');
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!usage) return <p className="dim">Loading…</p>;
  const gemini = usage.tokens.gemini ?? 0; const total = usage.tokens.claude + usage.tokens.codex + gemini;
  const budgetShare = usage.budget?.tokens ? total / usage.budget.tokens : usage.budget?.dollars && usage.cost !== null ? usage.cost / usage.budget.dollars : null;
  return <>
    <Section title="Σ Today">
      <div className="metrics"><p className="metric">{compact(total)} <small>tok</small></p>{usage.cost !== null && <span className="metric-side">${usage.cost.toFixed(2)}</span>}</div>
      <p className="split"><span className="claude"><i />Claude {compact(usage.tokens.claude)}</span><span className="codex"><i />Codex {compact(usage.tokens.codex)}</span>{gemini > 0 && <span className="gemini"><i />Gemini {compact(gemini)}</span>}{!usage.complete && <span className="dim">Still reading logs</span>}</p>
      {budgetShare !== null && <div className="budget"><p className="measure"><span>Daily budget{usage.budget?.dollars ? ` of $${usage.budget.dollars}` : usage.budget?.tokens ? ` of ${compact(usage.budget.tokens)} tok` : ''}</span><b>{Math.round(budgetShare * 100)}%</b></p><Meter ratio={budgetShare} tone="accent" label={`Daily budget ${Math.round(budgetShare * 100)}% used`} /></div>}
    </Section>
    <Section title="Plan limits">
      {!usage.limits.length && <Empty title="No plan limits yet">Shown once an agent reports them.</Empty>}
      {usage.limits.map((limit) => <div key={`${limit.engine}-${limit.account}`} className="limit">
        <p className="limit-head"><EngineMark engine={limit.engine} /><strong>{PLAN_NAME[limit.engine]}{limit.account !== 'Default' ? ` · ${limit.account}` : limit.signedInAs ? ` · ${limit.signedInAs}` : ''}</strong>{limit.plan && <span className="badge neutral">{limit.plan}</span>}</p>
        <LimitNote limit={limit} />
        {limit.windows.map((window) => <div key={window.label}><p className="measure"><span>{window.label}</span><b>{Math.round(window.usedPercent)}%</b></p><Meter ratio={window.usedPercent / 100} tone={limit.engine} label={`${window.label} ${Math.round(window.usedPercent)}% used`} /></div>)}
      </div>)}
      <div className="card-actions"><button type="button" className="quiet" onClick={reload}>Refresh</button></div>
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
    {!tasks.length && <Empty title="No tasks">Give a channel a task on the computer (Task on its tile).</Empty>}
    {COLUMNS.map((column) => { const list = tasks.filter((task) => task.status === column.status); return list.length ? <Section key={column.status} title={column.label} count={list.length}>
      <div className="rows">{list.map((task) => <article key={task.id} className="task"><div>
        <strong>{task.title}</strong>
        <p className="meta">{task.channel ? `CH${task.channel} · ` : ''}{when(task.updatedAt)}{task.files.length ? ` · ${task.files.length} file${task.files.length === 1 ? '' : 's'}` : ''}</p>
        {canRun && (column.status === 'review' || column.status === 'todo') && <div className="row">{column.status === 'review' && <button type="button" className="primary small" onClick={() => void move(task, 'done')}>Mark done</button>}{column.status === 'todo' && <button type="button" className="small" onClick={() => void move(task, 'working')}>Start working</button>}</div>}
      </div></article>)}</div>
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
    {!items.length && <Empty title="No conversations yet">Claude Code, Codex and Gemini conversations on this computer show here.</Empty>}
    {items.length > 0 && <ul className="history rows">{items.map((item) => <li key={item.key} className={`history-item engine-${item.engine}`}>
      <EngineMark engine={item.engine} />
      <div><strong>{item.title || 'Untitled conversation'}</strong><p className="meta">{({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' } as const)[item.engine]} · <span className="mono">{item.folder}</span> · {when(item.modified)}</p></div>
      {canRun && <button type="button" className="small" onClick={() => void resume(item)}>Resume</button>}
    </li>)}</ul>}
    {!canRun && items.length > 0 && <p className="dim">Resuming needs Can start and stop agents (Settings → Phone access on the computer).</p>}
  </>;
}

function MemoryScreen() {
  const [projects, error, reload] = useRoute<RemoteMemory[]>('/api/memory'); const [project, setProject] = useState(''); const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [note, setNote] = useState('');
  useEffect(() => { if (projects?.length && !projects.some((item) => item.project === project)) setProject(projects[0].project); }, [projects]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!projects) return <p className="dim">Loading…</p>;
  if (!projects.length) return <Empty title="No projects yet">Projects with channels on this computer show here.</Empty>;
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
    {shown.notes.map((item) => <details key={item.id} className="phone-card note"><summary><strong>{item.title}</strong><span className="meta">{item.author} · {when(item.createdAt)}</span></summary><p className="note-body">{item.content}</p></details>)}
  </>;
}

export type PhoneScreen = 'usage' | 'tasks' | 'history' | 'memory';
/** Shows one of the phone's screens in `container`; returns the function that removes it. */
export function mountScreen(container: HTMLElement, screen: PhoneScreen, canRun: boolean) {
  const root = createRoot(container);
  root.render(screen === 'usage' ? <UsageScreen /> : screen === 'tasks' ? <TasksScreen canRun={canRun} /> : screen === 'history' ? <HistoryScreen canRun={canRun} /> : <MemoryScreen />);
  return () => root.unmount();
}
