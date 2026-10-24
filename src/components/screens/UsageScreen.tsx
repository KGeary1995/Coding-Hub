import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { UsageRecord } from '../../../shared/hub';
import { useHubStore, dollars } from '../../state/hub-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { CHANNEL_STATES, LIMIT_THRESHOLD, channelState } from '../../state/channel-state';
import { USAGE_WINDOWS, axisMax, lastContext, dailySeries, delta, inWindow, median, usageTotals, type UsageWindow } from '../../state/usage-summary';
import { compact } from '../shell/StatusBar';

type EngineFilter = 'all' | 'claude' | 'codex';
const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex' } as const;
const time = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;

/** Reported CLI usage for a window: totals, daily tokens by engine and one row per session (docs/design/trace, sheet 05). */
export function UsageScreen() {
  const usage = useHubStore((state) => state.usage); const setUsage = useHubStore((state) => state.setUsage);
  const sessions = useWorkspaceStore((state) => state.sessions);
  const [days, setDays] = useState<UsageWindow>(14);
  const [engine, setEngine] = useState<EngineFilter>('all');
  const [hovered, setHovered] = useState<number | null>(null);
  const [updated, setUpdated] = useState(() => new Date());
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  // Windows end today: re-anchored whenever usage changes or is refreshed, so a screen left open over midnight moves on.
  const now = useMemo(() => new Date(), [updated, usage]);
  const filtered = useMemo(() => engine === 'all' ? usage : usage.filter((record) => record.engine === engine), [usage, engine]);
  const current = useMemo(() => inWindow(filtered, days, now), [filtered, days, now]);
  const totals = usageTotals(current); const prior = usageTotals(inWindow(filtered, days, now, 1));
  const series = useMemo(() => dailySeries(current, days, now), [current, days, now]);
  const top = axisMax(Math.max(...series.map((day) => day.claude + day.codex)));
  const focus = series[hovered ?? series.length - 1];
  const contexts = current.map(lastContext).filter((value): value is number => value !== null);
  const byEngine = (['claude', 'codex'] as const).map((name) => { const records = current.filter((record) => record.engine === name); const sum = usageTotals(records); return { name, tokens: sum.input + sum.output, cost: sum.cost, unpriced: sum.unpriced, runs: records.length }; });
  const engineTotal = Math.max(1, byEngine.reduce((sum, item) => sum + item.tokens, 0));
  const windowLabel = days === 1 ? 'today' : `${days} d`;
  async function refresh() {
    setBusy(true); setError('');
    try { const result = await window.codingHub?.hub({ action: 'usage' }); if (result && !result.ok) throw new Error(result.error.message); if (result?.ok) setUsage(result.value as UsageRecord[]); setUpdated(new Date()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Usage could not be refreshed.'); }
    finally { setBusy(false); }
  }
  const change = (current: number, previous: number) => { const value = delta(current, previous); return value === null ? `no prior ${windowLabel}` : `${value >= 0 ? '▲' : '▼'} ${Math.abs(value)}% vs prior ${windowLabel}`; };
  const kpis = [
    { label: 'input tokens', value: compact(totals.input), sub: change(totals.input, prior.input) },
    { label: 'output tokens', value: compact(totals.output), sub: totals.reasoning ? `incl. ${compact(totals.reasoning)} reasoning` : change(totals.output, prior.output) },
    { label: 'cache reads', value: compact(totals.cached), sub: 'not counted in totals' },
    { label: 'sessions', value: String(totals.sessions), sub: `${totals.overContext} at 80%+ context, last report` },
    { label: 'estimated cost', value: dollars(totals.cost), sub: totals.unpriced ? `${totals.unpriced} unpriced · configured rates` : 'configured rates' },
  ];
  return <section className="tr-usage">
    <header className="tr-usage-head">
      <h1>Usage</h1>
      <div className="tr-seg" role="group" aria-label="Window">{USAGE_WINDOWS.map((item) => <button key={item.id} className={days === item.id ? 'active' : ''} aria-pressed={days === item.id} onClick={() => { setDays(item.id); setHovered(null); }}>{item.label}</button>)}</div>
      <div className="tr-seg" role="group" aria-label="Engine">{(['all', 'claude', 'codex'] as const).map((item) => <button key={item} className={engine === item ? 'active' : ''} aria-pressed={engine === item} onClick={() => setEngine(item)}>{item !== 'all' && <i className="tr-engine-square" style={{ background: `var(--tr-ch-${item})` }} aria-hidden="true" />}{item === 'all' ? 'All engines' : ENGINE_LABEL[item]}</button>)}</div>
      <span className="tr-spacer" />
      <span className="tr-usage-meta">CLI-reported · local · updated {time(updated)}</span>
      <button className="tr-ghost-button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={13} className={busy ? 'spin' : ''} />Refresh</button>
    </header>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="tr-kpis" role="list" aria-label={`Totals for ${windowLabel}`}>{kpis.map((kpi) => <div key={kpi.label} role="listitem" className="tr-kpi"><span className="tr-kpi-label">{kpi.label}</span><strong className="tnum">{kpi.value}</strong><span className="tr-kpi-sub">{kpi.sub}</span></div>)}</div>
    <div className="tr-usage-mid">
      <article className="tr-chart" aria-label="Daily tokens">
        <div className="tr-chart-readout"><strong>{focus.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</strong><span className="tnum">{compact(focus.claude + focus.codex)} tok</span>
          <span className="tnum"><i className="tr-engine-square" style={{ background: 'var(--tr-ch-claude)' }} aria-hidden="true" /> {compact(focus.claude)}</span><span className="tnum"><i className="tr-engine-square" style={{ background: 'var(--tr-ch-codex)' }} aria-hidden="true" /> {compact(focus.codex)}</span>
          <span className="tnum">{dollars(focus.cost)}</span><span className="tr-chart-caption">input + output · cache excluded</span></div>
        <div className="tr-chart-plot">
          <div className="tr-chart-axis" aria-hidden="true">{[1, 0.5, 0].map((step) => <span key={step} style={{ bottom: `${step * 100}%` }}>{compact(top * step)}</span>)}</div>
          <div className="tr-chart-bars" onMouseLeave={() => setHovered(null)}>
            {series.map((day, index) => { const total = day.claude + day.codex; return <button key={day.key} className={`tr-chart-col ${index === (hovered ?? series.length - 1) ? 'hot' : ''}`} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} aria-label={`${day.date.toLocaleDateString()}: ${total} tokens, Claude ${day.claude}, Codex ${day.codex}`}>
              <span className="tr-chart-stack" style={{ height: `${total / top * 100}%` }}>{day.codex > 0 && <i className="codex" style={{ flexGrow: day.codex }} />}{day.claude > 0 && <i className="claude" style={{ flexGrow: day.claude }} />}</span>
              <span className="tr-chart-x">{day.date.getDate()}</span>
            </button>; })}
          </div>
        </div>
      </article>
      <aside className="tr-usage-side">
        <h2>By engine · {windowLabel}</h2>
        <div className="tr-split" aria-hidden="true">{byEngine.map((item) => <i key={item.name} style={{ flexGrow: item.tokens, background: `var(--tr-ch-${item.name})` }} />)}</div>
        {byEngine.map((item) => <div key={item.name} className="tr-side-row"><span><i className="tr-engine-square" style={{ background: `var(--tr-ch-${item.name})` }} aria-hidden="true" />{ENGINE_LABEL[item.name]}</span><span className="tnum">{compact(item.tokens)} · {Math.round(item.tokens / engineTotal * 100)}%</span><span className="tnum">{dollars(item.cost)}</span></div>)}
        <h2>Context at last report</h2>
        <div className="tr-side-row"><span>Sessions at 80% or more</span><span className={`tnum ${totals.overContext ? 'hot' : ''}`}>{totals.overContext}</span></div>
        <div className="tr-side-row"><span>Median</span><span className="tnum">{percent(median(contexts))}</span></div>
        <p className="tr-side-note">Only Codex reports its context window.</p>
      </aside>
    </div>
    <div className="tr-usage-table-wrap">
      <table className="usage-table tr-table">
        <thead><tr><th>Channel</th><th>Session</th><th>Model</th><th>Started</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache</th><th title="Context window in use at the session's latest report">Context</th><th className="num">Cost</th></tr></thead>
        <tbody>{[...current].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((record) => {
          const index = sessions.findIndex((session) => session.runId === record.runId); const session = sessions[index];
          const state = session ? CHANNEL_STATES[channelState(session, record)] : null; const context = lastContext(record);
          return <tr key={record.runId}>
            <td><span className="tr-cell-channel"><i className="tr-engine-square" style={{ background: `var(--tr-ch-${record.engine})` }} aria-hidden="true" />{session ? `CH${index + 1}` : ENGINE_LABEL[record.engine]}{state && <span aria-label={state.word.toLowerCase()}>{state.glyph}</span>}</span></td>
            <td className="tr-cell-session" title={record.cwd}>{session?.title ?? folderName(record.cwd)}{record.machine && <span className="tr-cell-machine"> · {record.machine}</span>}</td>
            <td className="tr-cell-mono">{record.model}</td>
            <td className="tr-cell-mono">{new Date(record.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
            <td className="num">{compact(record.input)}</td><td className="num">{compact(record.output)}</td><td className="num">{compact(record.cached)}</td>
            <td>{context === null ? <span className="tr-cell-mono dim">—</span> : <span className="tr-peak"><span className={`tr-peak-bar ${context >= LIMIT_THRESHOLD ? 'hot' : ''}`}><i style={{ width: `${Math.min(100, context * 100)}%` }} /></span><span className="tnum">{percent(context)}</span></span>}</td>
            <td className="num">{dollars(record.cost)}</td>
          </tr>;
        })}</tbody>
      </table>
      {!current.length && <p className="tr-empty-note">No reported usage in this window. Usage appears after a CLI writes its session log.</p>}
    </div>
    <p className="control-note">Token totals come from local CLI records, not provider billing. Costs use your configured rates (Settings) and need an exact model match. Claude cache reads and writes are separate from input; Codex cached input and reasoning are already inside its totals. Days follow each session's start.</p>
  </section>;
}
