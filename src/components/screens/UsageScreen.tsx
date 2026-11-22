import { PlanLimitsCard } from './PlanLimitsCard';
import { useEffect, useMemo, useState } from 'react';
import { ChartColumn, ChartPie, RefreshCw, Rows3, CircleAlert } from 'lucide-react';
import type { UsageRecord } from '../../../shared/hub';
import { useHubStore, dollars } from '../../state/hub-store';
import { channelNumber, useWorkspaceStore } from '../../state/workspace-store';
import { CHANNEL_STATES, LIMIT_THRESHOLD, channelState, type ChannelState } from '../../state/channel-state';
import { USAGE_WINDOWS, axisMax, lastContext, dailySeries, delta, inWindow, logRecords, median, usageTotals, type UsageWindow } from '../../state/usage-summary';
import { refreshUsageDays, useDayUsage } from '../../state/day-usage-store';
import { compact } from '../shell/StatusBar';

type EngineFilter = 'all' | 'claude' | 'codex';
const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex' } as const;
/** A channel's state as the tile's badge shows it; working takes the engine's colour (docs/design/midnight, section 5). */
const STATE_TONE: Record<ChannelState, string> = { idle: 'neutral', starting: 'neutral', working: '', waiting: 'waiting', finished: 'success', failed: 'danger', limit: 'limit' };
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
  const logs = useDayUsage((state) => state.days);
  useEffect(() => { void refreshUsageDays(); }, [updated, usage]);
  const filtered = useMemo(() => engine === 'all' ? usage : usage.filter((record) => record.engine === engine), [usage, engine]);
  // Tokens and cost: this computer's from the CLIs' logs, by the day they were used (in Trace or not), and other
  // computers' synced runs. The session rows, counts and context stay Trace's own runs.
  const measured = useMemo(() => logs ? [...logRecords(logs).filter((record) => engine === 'all' || record.engine === engine), ...filtered.filter((record) => record.machine)] : filtered, [logs, filtered, engine]);
  const current = useMemo(() => inWindow(filtered, days, now), [filtered, days, now]);
  const counted = useMemo(() => inWindow(measured, days, now), [measured, days, now]);
  const sessionTotals = usageTotals(current);
  const totals = { ...usageTotals(counted), sessions: sessionTotals.sessions, overContext: sessionTotals.overContext, unpriced: sessionTotals.unpriced }; const prior = usageTotals(inWindow(measured, days, now, 1));
  const series = useMemo(() => dailySeries(counted, days, now), [counted, days, now]);
  const top = axisMax(Math.max(...series.map((day) => day.claude + day.codex)));
  const focus = series[hovered ?? series.length - 1];
  const contexts = current.map(lastContext).filter((value): value is number => value !== null);
  const byEngine = (['claude', 'codex'] as const).map((name) => { const records = counted.filter((record) => record.engine === name); const sum = usageTotals(records); return { name, tokens: sum.input + sum.output, cost: sum.cost, unpriced: sum.unpriced, runs: current.filter((record) => record.engine === name).length }; });
  const engineTotal = Math.max(1, byEngine.reduce((sum, item) => sum + item.tokens, 0));
  const windowLabel = days === 1 ? 'today' : `${days} d`;
  async function refresh() {
    setBusy(true); setError('');
    try { const result = await window.codingHub?.hub({ action: 'usage' }); if (result && !result.ok) throw new Error(result.error.message); if (result?.ok) setUsage(result.value as UsageRecord[]); setUpdated(new Date()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Usage could not be refreshed.'); }
    finally { setBusy(false); }
  }
  const change = (current: number, previous: number) => changeText(delta(current, previous), windowLabel);
  const kpis = [
    { label: 'Input tokens', value: compact(totals.input), sub: change(totals.input, prior.input) },
    { label: 'Output tokens', value: compact(totals.output), sub: totals.reasoning ? `incl. ${compact(totals.reasoning)} reasoning` : change(totals.output, prior.output) },
    { label: 'Cache reads', value: compact(totals.cached), sub: 'not counted in totals' },
    { label: 'Sessions', value: String(totals.sessions), sub: `${totals.overContext} at 80%+ context` },
    { label: 'Estimated cost', value: dollars(totals.cost), sub: totals.unpriced ? `${totals.unpriced} unpriced · published prices` : 'published prices' },
  ];
  return <section className="ui-page wide tr-usage">
    <header className="ui-page-head">
      <span className="ui-page-icon" aria-hidden="true"><ChartColumn /></span>
      <div><h1>Usage</h1><p>From local CLI records, not provider billing · updated {time(updated)}</p></div>
      <div className="ui-page-actions">
        <div className="tr-seg" role="group" aria-label="Window">{USAGE_WINDOWS.map((item) => <button key={item.id} className={days === item.id ? 'active' : ''} aria-pressed={days === item.id} onClick={() => { setDays(item.id); setHovered(null); }}>{item.label}</button>)}</div>
        <div className="tr-seg" role="group" aria-label="Engine">{(['all', 'claude', 'codex'] as const).map((item) => <button key={item} className={engine === item ? 'active' : ''} aria-pressed={engine === item} onClick={() => setEngine(item)}>{item !== 'all' && <i className={`tr-engine-square ${item}`} aria-hidden="true" />}{item === 'all' ? 'All engines' : ENGINE_LABEL[item]}</button>)}</div>
        <button className="button secondary" onClick={() => void refresh()} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} />Refresh</button>
      </div>
    </header>
    <div className="ui-grid">
      {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
      <PlanLimitsCard />
      <div className="tr-kpis" role="list" aria-label={`Totals for ${windowLabel}`}>{kpis.map((kpi) => <div key={kpi.label} role="listitem" className="ui-card ui-stat"><span>{kpi.label}</span><strong>{kpi.value}</strong><small>{kpi.sub}</small></div>)}</div>
      <article className="ui-card span-8 tr-chart" aria-label="Daily tokens">
        <div className="ui-card-head"><ChartColumn aria-hidden="true" /><h2>Daily tokens</h2><span className="ui-card-actions ui-caption">input + output · cache excluded</span></div>
        <div className="tr-chart-readout"><strong>{focus.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</strong><span className="tnum">{compact(focus.claude + focus.codex)} tok</span>
          <span className="tnum"><i className="tr-engine-square claude" aria-hidden="true" /> {compact(focus.claude)}</span><span className="tnum"><i className="tr-engine-square codex" aria-hidden="true" /> {compact(focus.codex)}</span>
          <span className="tnum">{dollars(focus.cost)}</span></div>
        <div className="tr-chart-plot">
          {/* A window with no tokens shows the empty state alone: axis lines behind it would cross its words. */}
          {!series.some((day) => day.claude + day.codex > 0) ? <div className="ui-empty tr-chart-empty"><ChartColumn aria-hidden="true" /><h3>No tokens in this window</h3><p>Days fill in as Claude Code or Codex report their use.</p></div> : <>
          <div className="tr-chart-axis" aria-hidden="true">{[1, 0.5, 0].map((step) => <span key={step} style={{ bottom: `${step * 100}%` }}>{compact(top * step)}</span>)}</div>
          <div className="tr-chart-bars" onMouseLeave={() => setHovered(null)}>
            {series.map((day, index) => { const total = day.claude + day.codex; return <button key={day.key} className={`tr-chart-col ${index === (hovered ?? series.length - 1) ? 'hot' : ''}`} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} aria-label={`${day.date.toLocaleDateString()}: ${total} tokens, Claude ${day.claude}, Codex ${day.codex}`}>
              <span className="tr-chart-stack" style={{ height: `${total / top * 100}%` }}>{day.codex > 0 && <i className="codex" style={{ flexGrow: day.codex }} />}{day.claude > 0 && <i className="claude" style={{ flexGrow: day.claude }} />}</span>
              <span className="tr-chart-x">{day.date.getDate()}</span>
            </button>; })}
          </div></>}
        </div>
        <p className="ui-hint tr-chart-hint">{logs ? "This computer's CLI logs for the last 60 days, in Trace or not, plus other computers' synced sessions." : "Days follow each session's start."}</p>
      </article>
      <aside className="ui-card span-4 tr-usage-side">
        <div className="ui-card-head"><ChartPie aria-hidden="true" /><h2>By engine · {windowLabel}</h2></div>
        <div className="tr-split" aria-hidden="true">{byEngine.map((item) => <i key={item.name} className={item.name} style={{ flexGrow: item.tokens }} />)}</div>
        <div className="ui-list">{byEngine.map((item) => <div key={item.name} className="ui-row tr-side-row"><span><i className={`tr-engine-square ${item.name}`} aria-hidden="true" />{ENGINE_LABEL[item.name]}</span><span className="tnum">{compact(item.tokens)} · {Math.round(item.tokens / engineTotal * 100)}%</span><span className="tnum">{dollars(item.cost)}</span></div>)}</div>
        <h3>Context at last report</h3>
        <div className="ui-list"><div className="ui-row tr-side-row"><span>Sessions at 80% or more</span><span className={`ui-count ${totals.overContext ? 'limit' : 'neutral'}`}>{totals.overContext}</span></div>
          <div className="ui-row tr-side-row"><span>Median</span><span className="tnum">{percent(median(contexts))}</span></div></div>
        <p className="ui-hint">Only Codex reports its context window.</p>
      </aside>
      <section className="ui-card tr-usage-sessions" aria-labelledby="usage-sessions-title">
        <div className="ui-card-head"><Rows3 aria-hidden="true" /><h2 id="usage-sessions-title">Sessions</h2><span className="ui-count neutral">{current.length}</span><span className="ui-card-actions"><span className="ui-caption">Trace's own sessions</span><button type="button" className="ui-help" aria-label="Help: how sessions are counted" title="Costs use your configured rates (Settings) and need an exact model match. Claude cache reads and writes are separate from input; Codex cached input and reasoning are inside its totals." /></span></div>
        {current.length ? <div className="tr-usage-table-wrap">
          <table className="usage-table ui-table">
            <thead><tr><th>Channel</th><th>Session</th><th>Model</th><th>Started</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache</th><th title="Context window in use at the session's latest report">Context</th><th className="num">Cost</th></tr></thead>
            <tbody>{[...current].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((record) => {
              const session = sessions.find((item) => item.runId === record.runId); const number = session ? channelNumber(sessions, session.id) : 0;
              const state = session ? channelState(session, record) : null; const context = lastContext(record);
              return <tr key={record.runId}>
                <td><span className="tr-cell-channel"><span className={`ui-badge ${record.engine}`}>{number ? `CH${number}` : ENGINE_LABEL[record.engine]}</span>{state && <span className={`ui-badge dot ${STATE_TONE[state] || record.engine}`}>{CHANNEL_STATES[state].word}</span>}</span></td>
                <td className="tr-cell-session" title={record.cwd}>{session?.title ?? folderName(record.cwd)}{record.machine && <span className="tr-cell-machine"> · {record.machine}</span>}</td>
                <td className="tr-cell-mono">{record.model}{record.incomplete && <span className="dim" title="Trace could not read all of this run's usage log, so its totals may be low."> · incomplete</span>}</td>
                <td className="tr-cell-date">{new Date(record.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="num">{compact(record.input)}</td><td className="num">{compact(record.output)}</td><td className="num">{compact(record.cached)}</td>
                <td>{context === null ? <span className="tr-cell-date">—</span> : <span className="tr-peak"><span className={`ui-meter ${context >= LIMIT_THRESHOLD ? 'limit' : 'accent'}`}><i style={{ width: `${Math.min(100, context * 100)}%` }} /></span><span className="tnum">{percent(context)}</span></span>}</td>
                <td className="num">{dollars(record.cost)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <div className="ui-empty"><ChartColumn aria-hidden="true" /><h3>No reported usage in this window</h3><p>Usage appears after a CLI writes its session log.</p></div>}
      </section>
    </div>
  </section>;
}

/** The sub-line under a total: its change on the window before. 1000% or more (an earlier window near zero) reads as words, not a five-digit figure. */
export function changeText(value: number | null, windowLabel: string) {
  if (value === null) return `no prior ${windowLabel}`;
  if (value >= 1000) return `more than 10× the prior ${windowLabel}`;
  return `${value >= 0 ? '▲' : '▼'} ${Math.abs(value)}% vs prior ${windowLabel}`;
}
