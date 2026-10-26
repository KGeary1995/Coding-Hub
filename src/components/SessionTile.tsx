import { SessionPreferences } from './SessionPreferences';
import { budgetAlerts } from '../../shared/productivity';
import { peekCoachingPrompt, takeCoachingPrompt } from '../runtime/coaching';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Folder, FolderOpen, GripVertical, OctagonPause, AlertCircle, Asterisk, TerminalSquare, LoaderCircle, Square, RotateCcw, Settings2, Copy, Maximize2, Minimize2, X, SquareChevronRight } from 'lucide-react';
import { useAccountStore, refreshClaudeProfiles } from '../state/account-store';
import type { Session } from '../../shared/types';
import { freshInput, type UsageRecord } from '../../shared/hub';
import { useWorkspaceStore } from '../state/workspace-store';
import { WorktreeControls } from './WorktreeControls';
import { EngineControls } from './EngineControls';
import { TerminalViewport } from './TerminalViewport';
import { useChannelName } from '../state/channel-names';
import { modelLabel } from '../../shared/model-name';
import { ChatView } from './chat/ChatView';
import { PastedImages } from './PastedImages';
import { startSession, stopSession } from '../runtime/use-native-host';
import { focusTerminal, writeTerminal } from '../runtime/terminals';
import { useHubStore, tokens, dollars } from '../state/hub-store';
import { CHANNEL_STATES, LIMIT_THRESHOLD, channelState, limitRatio, usageFor } from '../state/channel-state';
import { ScopeStrip } from './tile/ScopeStrip';
import { compact } from './shell/StatusBar';
import { MAX_CHANNELS } from '../../shared/schemas';

/** What "tok" counts, and the cache traffic it leaves out. */
const tokenDetail = (usage: UsageRecord) => `New tokens this run: ${freshInput(usage).toLocaleString()} input + ${usage.output.toLocaleString()} output. Not counted: ${usage.cached.toLocaleString()} cache reads${usage.cacheWrite ? `, ${usage.cacheWrite.toLocaleString()} cache writes` : ''}.`;
const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;

/** One channel: header, scope strip, a detail row on hover or keyboard focus, notices and the terminal (docs/design/trace, sheet 08). */
export function SessionTile({ session, index, dense = false }: { session: Session; index: number; dense?: boolean }) {
  const profiles = useAccountStore((s) => s.profiles);
  useEffect(() => { if (session.config.engine === 'claude') void refreshClaudeProfiles(); }, [session.config.engine]);
  const profileId = session.config.engine === 'claude' ? session.config.accountProfileId : undefined;
  const profileName = profileId ? profiles.find((p) => p.id === profileId)?.name ?? 'Saved profile' : null;
  const { name, topic } = useChannelName(session);
  const [coachingSent, setCoachingSent] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const usage = useHubStore((s) => usageFor(session, s.usage));
  const reportedModel = session.status === 'running' && usage?.model && usage.model !== 'CLI default' ? usage.model : null;
  // Before a run's first reply, the model this channel last used (a resumed or restarted channel usually keeps it).
  const lastModel = useHubStore((s) => { let found: { model: string; timestamp: string } | null = null; for (const record of s.usage) if (record.sessionId === session.id && record.model && record.model !== 'CLI default' && (!found || record.timestamp > found.timestamp)) found = record; return found?.model ?? null; });
  const alerts = budgetAlerts(session.budget, usage);
  const { engines, rootDirectory, sessions, focusedSessionId, toggleFocus, removeSession, addSession, updateConfig, updateBinding, setView } = useWorkspaceStore();
  const cwd = session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory);
  const engine = session.config.engine;
  const claude = engine === 'claude';
  const shell = engine === 'shell';
  const chat = session.config.engine !== 'shell' && session.config.chat === true;
  // A chat channel's input is its conversation: prompts go in as messages, interruptions through the chat.
  const chatRun = () => session.runId && window.codingHub ? { codingHub: window.codingHub, runId: session.runId } : null;
  const sendPrompt = async (text: string) => { if (!chat) return writeTerminal(session.id, text + '\r'); const run = chatRun(); return Boolean(run && (await run.codingHub.chat({ action: 'send', sessionId: session.id, runId: run.runId, text, images: [] })).ok); };
  const interrupt = () => { if (!chat) { void writeTerminal(session.id, '\x03'); return; } const run = chatRun(); if (run) void run.codingHub.chat({ action: 'interrupt', sessionId: session.id, runId: run.runId }); };
  const engineName = chat ? (claude ? 'Claude chat' : 'Codex chat') : claude ? 'Claude Code' : shell ? 'Terminal' : 'Codex CLI';
  const resumeId = session.config.engine === 'shell' ? undefined : session.config.resumeId;
  const model = session.config.engine === 'shell' ? '' : session.config.model;
  const channel = index + 1;
  const setupView = !cwd || /working directory|absolute.*directory/i.test(session.error ?? '') ? 'projects' : /rules/i.test(session.error ?? '') ? 'rules' : 'accounts';
  const busy = session.status === 'running' || session.status === 'starting';
  const state = channelState(session, usage); const meta = CHANNEL_STATES[state];
  const context = usage?.context && usage.context.limit > 0 ? usage.context : null;
  // The bar and ctx readout show the context window when the CLI reports one; the budget fills the bar only otherwise.
  // The channel state still uses the larger of the two (limitRatio).
  const contextRatio = context ? context.used / context.limit : null;
  const barRatio = contextRatio ?? (session.budget ? limitRatio(session, usage) : null);
  const hot = contextRatio !== null && contextRatio >= LIMIT_THRESHOLD;
  async function stop() {
    setStopping(true);
    try { return await stopSession(session.id); } finally { setStopping(false); }
  }
  async function close() {
    if (session.status !== 'running' || await stop()) removeSession(session.id);
  }
  const start = () => void startSession(session.id);
  const openLog = () => { useWorkspaceStore.setState({ workflowTab: 'recovery', recoverySessionId: session.id }); setView('workflow'); };
  // The tile is a focus target: Enter starts an idle channel, otherwise moves into its terminal.
  const onTileKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.key !== 'Enter') return;
    event.preventDefault();
    if (state === 'idle') start(); else focusTerminal(session.id);
  };
  const action = state === 'idle' ? <button className="tr-action start" aria-label="Start session" title="Start session (Enter on the tile)" onClick={start}><span aria-hidden="true">▶</span> Start<kbd aria-hidden="true">⏎</kbd></button>
    : state === 'waiting' ? <button className="tr-action waiting" aria-label="Answer in terminal" title="Go to this channel's terminal to answer the CLI" onClick={() => focusTerminal(session.id)}>Answer</button>
    : state === 'failed' ? <><button className="tr-action retry" onClick={start}>Retry</button><button className="tr-action ghost" onClick={openLog}>Open log</button></>
    : state === 'limit' ? <button className="tr-action limit" title="Write a handoff in Shared memory before the context runs out" onClick={() => setView('memory')}>Write handoff</button>
    : state === 'finished' && !shell ? <button className="tr-action ghost" onClick={() => { useWorkspaceStore.setState({ reviewSessionId: session.id }); setView('diff'); }}>Review changes<kbd aria-hidden="true">G C</kbd></button>
    : null;
  const facts = [
    stopping ? 'stopping CLI and child processes…' : session.pid ? `pid ${session.pid}` : session.status === 'starting' ? 'checking local CLI…' : session.exitCode !== null ? `exit ${session.exitCode}` : 'ready to launch',
    cwd ? `cwd ${folderName(cwd)}` : 'no working directory',
    usage ? `cost ${dollars(usage.cost)}` : null,
    context ? `ctx ${compact(context.used)} / ${compact(context.limit)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <article className={`session-tile tr-tile ${engine} state-${state} ${dense ? 'dense' : ''} ${controlsOpen ? 'config-open' : ''} ${focusedSessionId === session.id ? 'selected' : ''}`}
      data-status={session.status} data-state={state} aria-label={`${name} session ${channel}`} tabIndex={0} onKeyDown={onTileKey}>
      <div className="tr-tile-top">
        <header className="tile-header tr-tile-head">
          <span className="tile-drag-handle" title="Drag to reorder"><GripVertical size={14} /></span>
          <span className="tr-ch-badge" style={{ background: `var(--tr-ch-${engine})` }} title={engineName}>CH{channel}</span>
          <strong className="tr-tile-name" title={topic ? `${name}: ${topic}` : name}>{name}</strong>
          {shell ? <span className="tr-tile-model model-name" title="Your login shell, or PowerShell on Windows">shell</span> : <span className="tr-tile-model model-name" title={reportedModel ? `Model in use: ${reportedModel}${model ? ` (chosen in this channel's settings: ${model})` : ''}` : model ? `Model chosen in this channel's settings: ${model}` : lastModel ? `Last used: ${lastModel}. The CLI's own default applies until this run reports its model.` : 'The CLI’s own default model (shown once the channel reports it)'}>{modelLabel(reportedModel || model || lastModel || '') || 'CLI default'}</span>}
          {topic && <span className="tr-tile-topic" title={topic}>{topic}</span>}
          {profileName && <span className="tr-profile-chip account-profile-chip" title={`Claude account: ${profileName}`}>{profileName}</span>}
          <span className="tr-spacer" />
          {!shell && <><span className="tr-tile-metric tnum" title={context ? 'Context window in use' : claude ? 'Claude Code does not report its context window' : 'No context report yet'}>ctx <b className={hot ? 'hot' : ''}>{context ? `${Math.round(context.used / context.limit * 100)}%` : '—'}</b></span>
          <span className="tr-tile-metric tnum" title={usage ? tokenDetail(usage) : 'Waiting for structured CLI usage'}>tok <b>{usage ? compact(tokens(usage)) : '—'}</b></span></>}
          {action}
          <span className={`tr-state-chip ${meta.solid ? 'solid' : ''}`} style={{ ['--chip' as string]: meta.color === 'engine' ? `var(--tr-ch-${engine})` : meta.color }} role="status" aria-label={`Channel ${channel} ${meta.word.toLowerCase()}`}>
            <span aria-hidden="true">{meta.glyph}</span>{meta.word}
          </span>
        </header>
        <ScopeStrip sessionId={session.id} state={state} engine={engine} limit={barRatio} limitLabel={contextRatio !== null ? `Context ${Math.round(contextRatio * 100)}% (marker at 80%)` : `Session budget ${Math.round((barRatio ?? 0) * 100)}% used (marker at 80%)`} />
        <div className="tr-tile-detail">
          <span className="tr-detail-facts" title={cwd ?? undefined}>{facts}</span>
          {session.status === 'running' && <button className="tr-detail-button icon" title="Interrupt current operation (Ctrl+C)" aria-label={`Interrupt session ${channel}`} onClick={interrupt} disabled={stopping}><OctagonPause size={13} /></button>}
          {session.status === 'running'
            ? <button className="tr-detail-button stop" title="Stop the CLI and its child processes" onClick={() => void stop()} disabled={stopping}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Square size={12} className="tr-detail-icon" />}<span className="tr-detail-label">{stopping ? 'Stopping' : 'Stop'}</span></button>
            : state === 'finished' && <button className="tr-detail-button" title="Start this channel again" onClick={start}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">Restart</span></button>}
          <button className={`tr-detail-button ${controlsOpen ? 'selected' : ''}`} title="Engine settings" aria-label={`Engine settings for session ${channel}`} aria-expanded={controlsOpen} onClick={() => setControlsOpen(!controlsOpen)}><Settings2 size={13} className="tr-detail-icon" /><span className="tr-detail-label">Settings</span></button>
          <button className="tr-detail-button" title="Duplicate" aria-label={`Duplicate session ${channel}`} disabled={sessions.length >= MAX_CHANNELS} onClick={() => addSession(engine, session.id)}><Copy size={13} className="tr-detail-icon" /><span className="tr-detail-label">Duplicate</span></button>
          <button className="tr-detail-button" title={focusedSessionId ? 'Restore grid' : 'Maximize'} aria-label={focusedSessionId ? 'Restore grid' : `Isolate session ${channel}`} onClick={() => toggleFocus(session.id)}>{focusedSessionId ? <Minimize2 size={13} className="tr-detail-icon" /> : <Maximize2 size={13} className="tr-detail-icon" />}<span className="tr-detail-label">{focusedSessionId ? 'Restore' : 'Maximize'}</span></button>
          <button className="tr-detail-button" title="Stop and close (keep at least two channels)" aria-label={`Close session ${channel}`} disabled={sessions.length <= 2 || session.status === 'starting' || stopping} onClick={() => void close()}><X size={13} className="tr-detail-icon" /><span className="tr-detail-label">Close</span></button>
        </div>
      </div>
      {controlsOpen && <fieldset className="session-config" disabled={busy}>
        {session.config.engine !== 'shell' && <EngineControls id={session.id} config={session.config} directory={cwd} onChange={(config) => updateConfig(session.id, config)} />}
        <label className="binding-control">Working directory<select aria-label="Working directory" value={session.binding.mode} onChange={(event) => updateBinding(session.id, event.target.value === 'workspace' ? { mode: 'workspace' } : { mode: 'independent', cwd: rootDirectory ?? '' })}><option value="workspace">Use workspace root</option><option value="independent">Independent repository</option></select></label>
        {session.binding.mode === 'independent' && <label className="binding-control">Repository path<input aria-label="Repository path" value={session.binding.cwd} placeholder="Absolute directory path" onChange={(event) => updateBinding(session.id, { mode: 'independent', cwd: event.target.value })} spellCheck={false} /><button className="button secondary" type="button" onClick={() => void window.codingHub?.pickDirectory().then((directory) => { if (directory) updateBinding(session.id, { mode: 'independent', cwd: directory }); }).catch(() => useWorkspaceStore.getState().setSessionError(session.id, 'Folder picker unavailable. Use Projects to enter a path.'))}><FolderOpen size={13} />Browse repository folder</button></label>}
        <SessionPreferences session={session} />
        <WorktreeControls session={session} />
        {busy && <p className="control-note">Stop the session to change its next launch settings.</p>}
      </fieldset>}
      {session.status === 'running' && peekCoachingPrompt(session.id) && <div className="session-error"><span>Finish any CLI trust or setup prompts first. This request asks the agent to read your prepared report.</span><button className="button secondary" onClick={() => { const prompt = peekCoachingPrompt(session.id)?.prompt; if (prompt) { setCoachingSent(true); void sendPrompt(prompt).then((sent) => { if (sent) takeCoachingPrompt(session.id); else setCoachingSent(false); }); } }} disabled={coachingSent}>{peekCoachingPrompt(session.id)?.label ?? 'Send prepared request'}</button></div>}
      {session.status === 'running' && session.attention && <div className="session-attention" role="alert"><span aria-hidden="true">◆</span><span>{session.attention.message}</span></div>}
      {session.error && <div className="session-error" role="alert"><AlertCircle size={14} /><span>{session.error}</span>{!busy && session.exitCode !== null && session.exitCode !== 0 && engine === 'codex' && <button className="quiet-button" onClick={() => { useWorkspaceStore.getState().resetCodexConfig(session.id); useWorkspaceStore.getState().setSessionError(session.id, 'Model and reasoning overrides cleared. The next launch starts a fresh conversation using local CLI defaults; the old conversation remains in native history.'); }}>Use Codex CLI defaults</button>}{!busy && <button className="quiet-button" onClick={() => setView(setupView)}>{setupView === 'projects' ? 'Choose project' : setupView === 'rules' ? 'Apply shared rules' : 'Account setup'}</button>}</div>}
      {!busy && !profileId && engines.find((item) => item.engine === engine)?.authentication?.state === 'not-authenticated' && <div className="session-error" role="status"><AlertCircle size={14} /><span>CLI reports no login. Open Accounts & connections to sign in before starting.</span></div>}
      {alerts.length > 0 && <details className="budget-notice"><summary>Usage target notice · {alerts.length} {alerts.length === 1 ? 'threshold' : 'thresholds'}</summary>{alerts.map((alert) => <p key={alert}>{alert}</p>)}<p>Reported usage and estimates can lag. These alerts do not enforce provider billing limits.</p></details>}
      <div className={`terminal-frame ${session.status === 'idle' && !session.runId ? 'terminal-idle' : ''} ${chat ? 'chat-frame' : ''}`}>{chat ? <ChatView session={session} /> : <TerminalViewport session={session} />}{session.status === 'idle' && !session.runId && !controlsOpen && <div className="session-welcome"><span className="welcome-engine">{claude ? <Asterisk size={28} /> : shell ? <SquareChevronRight size={25} /> : <TerminalSquare size={25} />}</span><span className="welcome-eyebrow">CH{channel} · {resumeId ? 'RESUME CONVERSATION' : shell ? 'LOCAL SHELL' : 'LOCAL CLI'}</span><h3>{chat ? engineName : claude ? 'Claude Code' : shell ? 'Terminal' : 'OpenAI Codex'}</h3><p>{resumeId ? 'Continue your saved conversation with its original context.' : shell ? 'Your shell, in this folder. Nothing it prints is recorded.' : chat ? `${claude ? 'Claude Code' : 'Codex'} as a conversation: images, formatted replies and approvals as buttons.` : 'Your account. Your tools. Your working directory.'}</p><div className="welcome-directory"><Folder size={14} /><span title={cwd ?? undefined}>{cwd ? folderName(cwd) : 'Choose a project to get started'}</span></div><div className="welcome-actions">{!cwd && <button className="quiet-button" aria-label={`Choose project for session ${channel}`} onClick={() => setView('projects')}>Choose project<ArrowUpRight size={13} /></button>}<button className="quiet-button" aria-label={`Configure idle session ${channel}`} onClick={() => setControlsOpen(true)}>Session settings<ArrowUpRight size={13} /></button></div><small>Press Start in the channel header{resumeId ? ' to resume' : ''}.{shell ? '' : ' CLI permissions and approvals apply.'}</small></div>}</div>
      {!chat && <PastedImages sessionId={session.id} />}
    </article>
  );
}
