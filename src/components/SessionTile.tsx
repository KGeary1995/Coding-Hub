import { useEffect, useState } from 'react';
import { ChevronDown, Copy, FolderOpen, Folder, GripVertical, Maximize2, Minimize2, Settings2, TerminalSquare, X, Play, Square, LoaderCircle, OctagonPause, AlertCircle, Asterisk } from 'lucide-react';
import { useAccountStore, refreshClaudeProfiles } from '../state/account-store';
import type { Session } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';
import { WorktreeControls } from './WorktreeControls';
import { EngineControls } from './EngineControls';
import { TerminalViewport } from './TerminalViewport';
import { startSession, stopSession } from '../runtime/use-native-host';
import { writeTerminal } from '../runtime/terminals';
import { useHubStore, tokens, formatNumber, dollars } from '../state/hub-store';

export function SessionTile({ session, index }: { session: Session; index: number }) {
  const profiles = useAccountStore((s) => s.profiles);
  useEffect(() => { if (session.config.engine === 'claude') void refreshClaudeProfiles(); }, [session.config.engine]);
  const profileId = session.config.engine === 'claude' ? session.config.accountProfileId : undefined;
  const profileName = profileId ? profiles.find((p) => p.id === profileId)?.name ?? 'Saved profile' : 'Default';
  const [controlsOpen, setControlsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const usage = useHubStore((s) => s.usage.find((u) => u.runId === session.runId));
  const { engines, rootDirectory, sessions, focusedSessionId, toggleFocus, removeSession, addSession, updateConfig, updateBinding } = useWorkspaceStore();
  const cwd = session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory);
  const claude = session.config.engine === 'claude';
  const setupView = !cwd || /working directory|absolute.*directory/i.test(session.error ?? '') ? 'projects' : /rules/i.test(session.error ?? '') ? 'rules' : 'accounts';
  const busy = session.status === 'running' || session.status === 'starting';
  async function stop() {
    setStopping(true);
    try { return await stopSession(session.id); } finally { setStopping(false); }
  }
  async function close() {
    if (session.status !== 'running' || await stop()) removeSession(session.id);
  }
  return (
    <article className={`session-tile ${claude ? 'claude' : 'codex'}`} aria-label={`${session.title} session ${index + 1}`}>
      <header className="tile-header">
        <span className="tile-drag-handle" title="Drag to reorder"><GripVertical size={16} /></span>
        <span className="engine-mark">{claude ? <Asterisk size={20} /> : <TerminalSquare size={17} />}</span>
        <strong>{session.title}</strong><span className="session-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="tile-actions">
          <button className={`icon-button ${controlsOpen ? 'selected' : ''}`} title="Engine settings" aria-label={`Engine settings for session ${index + 1}`} aria-expanded={controlsOpen} onClick={() => setControlsOpen(!controlsOpen)}><Settings2 size={15} /></button>
          <button className="icon-button" title="Duplicate session" aria-label={`Duplicate session ${index + 1}`} disabled={sessions.length >= 4} onClick={() => addSession(session.config.engine, session.id)}><Copy size={15} /></button>
          <button className="icon-button" title={focusedSessionId ? 'Restore grid' : 'Isolate session'} aria-label={focusedSessionId ? 'Restore grid' : `Isolate session ${index + 1}`} onClick={() => toggleFocus(session.id)}>{focusedSessionId ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button className="icon-button" title="Stop and close session (keep at least two)" aria-label={`Close session ${index + 1}`} disabled={sessions.length <= 2 || session.status === 'starting' || stopping} onClick={() => void close()}><X size={15} /></button>
        </span>
      </header>
      <div className="tile-model-row">{claude && <span className="account-profile-chip" title={`Claude account: ${profileName}`}>{profileName}</span>}<span className={`process-dot ${session.status}`} /><span className="process-status">{session.status}</span><span className="model-name" title={session.config.model || 'Model from local CLI configuration'}>{session.config.model || 'CLI default model'}</span><button className="quiet-button" onClick={() => setControlsOpen(!controlsOpen)}>{busy ? 'Settings' : 'Configure'} <ChevronDown size={12} /></button></div>
      {controlsOpen && <fieldset className="session-config" disabled={busy}>
        <EngineControls id={session.id} config={session.config} onChange={(config) => updateConfig(session.id, config)} />
        <label className="binding-control">Working directory<select aria-label="Working directory" value={session.binding.mode} onChange={(event) => updateBinding(session.id, event.target.value === 'workspace' ? { mode: 'workspace' } : { mode: 'independent', cwd: rootDirectory ?? '' })}><option value="workspace">Use workspace root</option><option value="independent">Independent repository</option></select></label>
        {session.binding.mode === 'independent' && <label className="binding-control">Repository path<input aria-label="Repository path" value={session.binding.cwd} placeholder="Absolute directory path" onChange={(event) => updateBinding(session.id, { mode: 'independent', cwd: event.target.value })} spellCheck={false} /><button className="button secondary" type="button" onClick={() => void window.codingHub?.pickDirectory().then((directory) => { if (directory) updateBinding(session.id, { mode: 'independent', cwd: directory }); }).catch(() => useWorkspaceStore.getState().setSessionError(session.id, 'Folder picker unavailable. Use Projects to enter a path.'))}><FolderOpen size={13} />Browse repository folder</button></label>}
        <WorktreeControls session={session} />
        {busy && <p className="control-note">Stop the session to change its next launch settings.</p>}
      </fieldset>}
      <div className="session-run-toolbar">
        <span className="process-detail">{stopping ? 'Stopping CLI and child processes…' : session.pid ? <><span className="mono">PTY</span> PID {session.pid}</> : session.status === 'starting' ? 'Checking local CLI…' : session.exitCode !== null ? `Process exited · code ${session.exitCode}` : 'Ready to launch locally'}</span>
        {session.status === 'running' ? <><button className="icon-button" title="Interrupt current operation (Ctrl+C)" aria-label={`Interrupt session ${index + 1}`} onClick={() => void writeTerminal(session.id, '\x03')} disabled={stopping}><OctagonPause size={14} /></button><button className="button stop-button" onClick={() => void stop()} disabled={stopping}>{stopping ? <LoaderCircle size={12} className="spin" /> : <Square size={11} />}{stopping ? 'Stopping' : 'Stop'}</button></> : <button className="button start-button" onClick={() => void startSession(session.id)} disabled={session.status === 'starting'}>{session.status === 'starting' ? <LoaderCircle size={12} className="spin" /> : <Play size={11} />}{session.status === 'starting' ? 'Starting' : session.status === 'exited' ? 'Restart' : 'Start session'}</button>}
      </div>
      {session.error && <div className="session-error" role="alert"><AlertCircle size={14} /><span>{session.error}</span>{!busy && <button className="quiet-button" onClick={() => useWorkspaceStore.getState().setView(setupView)}>{setupView === 'projects' ? 'Choose project' : setupView === 'rules' ? 'Apply shared rules' : 'Account setup'}</button>}</div>}
      {!busy && !profileId && engines.find((engine) => engine.engine === session.config.engine)?.authentication?.state === 'not-authenticated' && <div className="session-error" role="status"><AlertCircle size={14} /><span>CLI reports no login. Open Accounts & connections to sign in before starting.</span></div>}
      <div className="terminal-frame"><TerminalViewport session={session} /></div>
      <footer className="tile-footer"><span className="cwd-label" title={cwd ?? 'No workspace selected'}><Folder size={12} />{cwd || 'Choose a working directory'}</span><span className="token-label" title={usage ? 'Reported CLI usage · estimated cost' : 'Waiting for structured CLI usage'}>Tokens <b>{usage ? formatNumber(tokens(usage)) : '—'}</b><span>Cost <b>{dollars(usage?.cost ?? null)}</b></span>{usage?.context && <span>Context <b>{Math.round(usage.context.used / usage.context.limit * 100)}%</b></span>}</span></footer>
    </article>
  );
}
