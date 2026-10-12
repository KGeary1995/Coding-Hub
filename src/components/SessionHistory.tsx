import { NativeHistory } from './NativeHistory';
import { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw, FileText, TerminalSquare } from 'lucide-react';
import type { RunLog, SessionHistoryRun } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';

function date(value: string) { return new Date(value).toLocaleString(); }
function bytes(value: number) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`; }

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
  return <section className="history-panel"><div className="history-heading"><div><span className="eyebrow">SAVED ON THIS MACHINE</span><h1><History size={27} />Session history</h1><p>Review saved CLI output from previous runs. Restored workspace panels start idle.</p></div><button className="button secondary" onClick={() => setNative(true)}>View native CLI conversations</button><button className="button secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh history</button></div>{error && <p className="error-message" role="alert">{error}</p>}{!runs.length ? <div className="history-empty"><FileText size={32} /><h2>{loading ? 'Loading history…' : 'No recorded sessions yet'}</h2><p>Start a Claude Code or Codex session to save its terminal output locally.</p></div> : <div className="history-workbench"><div className="history-list" role="list" aria-label="Recorded CLI runs">{runs.map((item) => <button key={item.runId} className={`history-run ${item.runId === selected ? 'selected' : ''}`} onClick={() => { setSelected(item.runId); setConfirmRestore(false); }} aria-pressed={item.runId === selected}><span className="history-run-title"><TerminalSquare size={15} /><strong>{item.engine === 'claude' ? 'Claude Code' : 'Codex'}</strong><span className={`run-badge ${item.status}`}>{item.status}</span></span><span className="history-model">{item.config.model || 'CLI default model'}</span><span className="history-path" title={item.cwd}>{item.cwd}</span><span className="history-date">{date(item.startedAt)} · {bytes(item.recordedBytes)}</span></button>)}</div><article className="history-output"><header><div><span className="eyebrow">RECORDED OUTPUT</span><h2>{run?.engine === 'claude' ? 'Claude Code' : 'Codex'} <span className="history-model">{run?.config.model || 'CLI default model'}</span></h2><code>{run?.cwd}</code></div><span className="run-badge">{run?.exitCode !== null ? `Exit ${run?.exitCode}` : run?.status}</span></header><div className="history-metadata"><span>Started {run && date(run.startedAt)}</span><span>{run?.endedAt ? `Ended ${date(run.endedAt)}` : 'Run is active · Refresh to update'}</span></div>{run?.status === 'interrupted' && <div className="history-notice">This process was interrupted. Its recorded output is history; no CLI process was recovered.</div>}{run && run.status !== 'running' && <div className="history-notice"><button className="button secondary" onClick={() => setConfirmRestore(true)}>Restore launch settings to a session</button>{confirmRestore && <><p>This creates an idle session with the recorded engine, parameters, and repository. If four panels exist, the first idle panel is replaced. No process starts automatically. A recorded native conversation ID is retained when available; inspect the settings before starting.</p><button className="button primary" onClick={() => { if (!useWorkspaceStore.getState().restoreRun(run)) setError('All four panels are running or starting. Stop a session before restoring.'); }}>Confirm restore</button><button className="button secondary" onClick={() => setConfirmRestore(false)}>Cancel</button></>}</div>}{(log?.tailOnly || log?.logTruncated) && <div className="history-notice">{log.tailOnly && 'Showing the final 1 MiB of saved output. '}{log.logTruncated && 'Recording reached the per-run limit; later terminal output was not saved.'}</div>}{logError ? <p className="error-message" role="alert">{logError}</p> : <pre aria-label="Saved terminal output">{log ? log.text || 'This run produced no saved output.' : 'Loading saved output…'}</pre>}</article></div>}<button className="button secondary" onClick={() => setView('workspace')}>Back to sessions</button></section>;
}
