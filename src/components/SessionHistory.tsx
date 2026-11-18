import { NativeHistory } from './NativeHistory';
import { useCallback, useEffect, useState } from 'react';
import { History, Info, RefreshCw, FileText, Rows3, TerminalSquare, TriangleAlert } from 'lucide-react';
import type { RunLog, SessionHistoryRun } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';

function date(value: string) { return new Date(value).toLocaleString(); }
function bytes(value: number) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`; }
/** A run's status as a badge: a word in sentence case and its state colour. */
const STATUS: Record<SessionHistoryRun['status'], { word: string; tone: string }> = { running: { word: 'Running', tone: 'accent' }, completed: { word: 'Completed', tone: 'success' }, interrupted: { word: 'Interrupted', tone: 'limit' } };

export function SessionHistory() {
  const [native, setNative] = useState(false);
  const [runs, setRuns] = useState<SessionHistoryRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState<RunLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const setView = useWorkspaceStore((state) => state.setView);
  const refresh = useCallback(async () => {
    if (!window.codingHub) { setError('Session history is available in the desktop app.'); return; }
    setLoading(true);
    try {
      const result = await window.codingHub.listHistory();
      if (!result.ok) { setError(result.error.message); return; }
      setError(null); setRuns(result.value);
      setSelected((current) => result.value.some((run) => run.runId === current) ? current : result.value[0]?.runId ?? null);
      setRevision((value) => value + 1);
    } catch { setError('Local session history could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selected || !window.codingHub) return;
    let cancelled = false;
    setLog(null); setLogError(null);
    void window.codingHub.readRunLog({ runId: selected }).then((result) => {
      if (cancelled) return;
      if (result.ok) setLog(result.value); else setLogError(result.error.message);
    }).catch(() => { if (!cancelled) setLogError('The saved output could not be loaded.'); });
    return () => { cancelled = true; };
  }, [selected, revision]);
  const run = runs.find((item) => item.runId === selected);
  if (native) return <NativeHistory onBack={() => setNative(false)} />;
  return <section className="ui-page wide history-panel">
    <header className="ui-page-head"><span className="ui-page-icon" aria-hidden="true"><History /></span><div><h1>Session history</h1><p>Review saved CLI output from previous runs. Restored workspace panels start idle.</p></div>
      <div className="ui-page-actions"><button className="button secondary" onClick={() => setNative(true)}>View native CLI conversations</button><button className="button secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} />Refresh history</button><button className="quiet-button" onClick={() => setView('workspace')}>Back to sessions</button></div></header>
    {error && <p className="ui-banner danger" role="alert">{error}</p>}
    {!runs.length ? <div className="ui-card ui-empty history-none"><FileText aria-hidden="true" /><h2>{loading ? 'Loading history…' : 'No recorded sessions yet'}</h2><p>Start a Claude Code or Codex session to save its terminal output locally.</p></div> : <div className="history-workbench">
      <div className="ui-card history-runs"><div className="ui-card-head"><Rows3 aria-hidden="true" /><h2>Recorded runs</h2><span className="ui-count neutral">{runs.length}</span></div>
        <div className="ui-list history-list" role="list" aria-label="Recorded CLI runs">{runs.map((item) => <button key={item.runId} className={`ui-row history-run ${item.runId === selected ? 'selected' : ''}`} onClick={() => { setSelected(item.runId); setConfirmRestore(false); }} aria-pressed={item.runId === selected}>
          <span className={`ui-avatar ${item.engine}`} aria-hidden="true"><TerminalSquare /></span>
          <span className="ui-row-main"><span className="history-run-title"><strong>{item.engine === 'claude' ? 'Claude Code' : 'Codex'}</strong><span className={`ui-badge ${STATUS[item.status].tone}`}>{STATUS[item.status].word}</span></span><small>{item.config.model || 'CLI default model'}</small><span className="history-path" title={item.cwd}>{item.cwd}</span><small>{date(item.startedAt)} · {bytes(item.recordedBytes)}</small></span>
        </button>)}</div></div>
      <article className="ui-card history-record">
        <div className="ui-card-head"><span className={`ui-avatar small ${run?.engine ?? 'neutral'}`} aria-hidden="true"><TerminalSquare /></span><h2>{run?.engine === 'claude' ? 'Claude Code' : 'Codex'} <span className="history-model">{run?.config.model || 'CLI default model'}</span></h2><span className="ui-badge neutral">{run?.exitCode !== null ? `Exit ${run?.exitCode}` : run && STATUS[run.status].word}</span></div>
        <code className="history-cwd">{run?.cwd}</code>
        <div className="history-metadata"><span>Started {run && date(run.startedAt)}</span><span>{run?.endedAt ? `Ended ${date(run.endedAt)}` : 'Run is active · Refresh to update'}</span>{run && run.status !== 'running' && !confirmRestore && <button className="button secondary small" onClick={() => setConfirmRestore(true)}>Restore launch settings to a session</button>}</div>
        {run?.status === 'interrupted' && <div className="ui-banner warning"><TriangleAlert aria-hidden="true" /><span>This process was interrupted. Its recorded output is history; no CLI process was recovered.</span></div>}
        {run && run.status !== 'running' && confirmRestore && <div className="ui-banner warning history-restore"><TriangleAlert aria-hidden="true" /><div><p>This creates an idle session with the recorded engine, parameters, and repository. If the workspace is full, the first idle panel is replaced. No process starts automatically. A recorded native conversation ID is retained when available; inspect the settings before starting.</p><div className="ui-actions"><button className="button primary small" onClick={() => { if (!useWorkspaceStore.getState().restoreRun(run)) setError('Every panel is running or starting. Stop a session before restoring.'); }}>Confirm restore</button><button className="button secondary small" onClick={() => setConfirmRestore(false)}>Cancel</button></div></div></div>}
        {(log?.tailOnly || log?.logTruncated) && <div className="ui-banner info"><Info aria-hidden="true" /><span>{log.tailOnly && 'Showing the final 1 MiB of saved output. '}{log.logTruncated && 'Part of this run’s output was not saved because it reached the per-run limit.'}</span></div>}
        {logError ? <p className="ui-banner danger" role="alert">{logError}</p> : <pre aria-label="Saved terminal output">{log ? log.text || 'This run produced no saved output.' : 'Loading saved output…'}</pre>}
      </article></div>}
  </section>;
}
