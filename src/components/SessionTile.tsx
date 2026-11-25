import { useShallow } from 'zustand/react/shallow';
import { SessionPreferences } from './SessionPreferences';
import { StartStepSettings } from './StartStepSettings';
import { AutoCheckLine } from './AutoCheckLine';
import { UndoTurnLine } from './UndoTurnLine';
import { useUndoStore } from '../state/undo-store';
import { budgetAlerts } from '../../shared/productivity';
import { peekCoachingPrompt, takeCoachingPrompt } from '../runtime/coaching';
import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Folder, FolderOpen, GripVertical, OctagonPause, CircleAlert, TriangleAlert, LoaderCircle, Play, Square, Ellipsis, RotateCcw, Settings2, Copy, Maximize2, Minimize2, MessagesSquare, X, ClipboardList, ChevronDown, Undo2, AppWindow } from 'lucide-react';
import { accountLabel, useAccountStore, refreshClaudeProfiles } from '../state/account-store';
import type { Session } from '../../shared/types';
import { freshInput, type UsageRecord } from '../../shared/hub';
import { channelsOf, hiddenSeats, useWorkspaceStore } from '../state/workspace-store';
import { WorktreeControls } from './WorktreeControls';
import { EngineControls } from './EngineControls';
import { TerminalViewport } from './TerminalViewport';
import { useChannelName } from '../state/channel-names';
import { modelLabel } from '../../shared/model-name';
import { ChatView } from './chat/ChatView';
import { TranscriptView } from './chat/TranscriptView';
import { workbench } from '../runtime/workbench';
import type { ChannelTranscript } from '../../shared/remote';
import { chatFailed, chatSent, useChatStore } from '../state/chat-store';
import { tableRequest } from '../runtime/round-table';
import { PastedImages } from './PastedImages';
import { closeChannel, startSession, stopSession } from '../runtime/use-native-host';
import { focusTerminal, submitTerminal, writeTerminal } from '../runtime/terminals';
import { useHubStore, dollars } from '../state/hub-store';
import { HANDOFF_DETAIL, HANDOFF_LABEL, handoffPhase, handoffShown, useHandoffStore } from '../state/handoff-store';
import { CHANNEL_STATES, channelState, channelTokensToday, limitRatio, usageFor } from '../state/channel-state';
import { ScopeStrip } from './tile/ScopeStrip';
import { EngineAvatar } from './tile/EngineAvatar';
import { useAgentLook } from '../state/agent-store';
import { LiveTipStrip } from './tile/LiveTipStrip';
import { TaskStrip } from './tile/TaskStrip';
import { errorLines, errorText, setupTarget, SETUP_TARGETS, useErrorStrip } from './tile/error-strip';
import { useTerminalRow } from './tile/terminal-row';
import { newTaskFor } from '../state/task-store';
import { compact } from './shell/StatusBar';
import { MAX_CHANNELS } from '../../shared/schemas';
import { isAgentConfig, isChatEngineConfig, isChatRun } from '../../shared/types';
import { closeAsks, ConfirmStep } from './ConfirmStep';
import { openPreview, usePreviewStore } from '../state/preview-store';
import { previewLabel } from '../../shared/app-preview';

/** What "tok" counts, and the cache traffic it leaves out. */
const tokenDetail = (usage: UsageRecord) => `New tokens this run: ${freshInput(usage).toLocaleString()} input${usage.engine === 'claude' && usage.cacheWrite ? ` (including ${usage.cacheWrite.toLocaleString()} written to the cache)` : ''} + ${usage.output.toLocaleString()} output. Not counted: ${usage.cached.toLocaleString()} cache reads.`;
const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;

/** One channel: header, a controls row its button opens, notices, the terminal and the footer (docs/design/midnight/README.md, section 5). */
export const SessionTile = memo(function SessionTile({ session, index }: { session: Session; index: number }) {
  const profiles = useAccountStore((s) => s.profiles);
  useEffect(() => { if (session.config.engine === 'claude') void refreshClaudeProfiles(); }, [session.config.engine]);
  const profileId = session.config.engine === 'claude' ? session.config.accountProfileId : undefined;
  // Whose account the channel runs on, named and coloured: its profile, or the account the default sign-in is.
  const labels = useAccountStore((s) => s.labels);
  const account = session.config.engine !== 'claude' ? null : accountLabel(labels, profileId) ?? (profileId ? { name: profiles.find((p) => p.id === profileId)?.name ?? 'Saved profile', tone: -1 } : null);
  const tone = account && account.tone >= 0 ? String(account.tone % 4) : undefined;
  const { name, topic } = useChannelName(session);
  const [coachingSent, setCoachingSent] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  /** The controls row, opened and closed by its button in the header. */
  const [detailPinned, setDetailPinned] = useState(false);
  const [conversation, setConversation] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Close on a running channel asks first: it stops the agent mid-task, and the tile cannot be brought back. */
  const [confirmClose, setConfirmClose] = useState(false);
  const usage = useHubStore((s) => usageFor(session, s.usage));
  // A Round Table is one channel running several agents: its tokens are every agent's, as in the status bar.
  const atTable = useWorkspaceStore((s) => hiddenSeats(s.sessions, session.id).length > 0);
  const today = { tokens: useHubStore((s) => channelTokensToday(useWorkspaceStore.getState().sessions, session.id, s.usage)) };
  /** Whether anything is recorded for this channel: a Gemini CLI channel has nothing until its conversation's first request is read. */
  const measured = useHubStore((s) => s.usage.some((record) => record.sessionId === session.id));
  const reportedModel = session.status === 'running' && usage?.model && usage.model !== 'CLI default' ? usage.model : null;
  // Before a run's first reply, the model this channel last used (a resumed or restarted channel usually keeps it).
  const lastModel = useHubStore((s) => { let found: { model: string; timestamp: string } | null = null; for (const record of s.usage) if (record.sessionId === session.id && record.model && record.model !== 'CLI default' && (!found || record.timestamp > found.timestamp)) found = record; return found?.model ?? null; });
  const alerts = budgetAlerts(session.budget, usage);
  /** The app this channel's run printed the address of (1.39.0): Preview opens it beside the channels. */
  const offer = usePreviewStore((s) => s.offers[session.id]); const preview = session.status === 'running' ? offer : undefined;
  const { engines, rootDirectory, focusedSessionId, toggleFocus, addSession, updateConfig, updateBinding, setView } = useWorkspaceStore(useShallow((s) => ({ engines: s.engines, rootDirectory: s.rootDirectory, focusedSessionId: s.focusedSessionId, toggleFocus: s.toggleFocus, addSession: s.addSession, updateConfig: s.updateConfig, updateBinding: s.updateBinding, setView: s.setView })));
  const cwd = session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory);
  const engine = session.config.engine;
  const claude = engine === 'claude';
  const shell = engine === 'shell';
  // A custom agent (docs/custom-agents.md) goes by its own name and colour.
  const agentId = session.config.engine === 'custom' ? session.config.agentId : ''; const look = useAgentLook(agentId); const custom = engine === 'custom';
  // Claude Code or Codex: usage, context, tasks and coaching. Terminal channels have none of these.
  /** Tasks and live coaching read Claude Code's and Codex's transcripts only; Gemini's tasks are read from its screen. */
  const tasked = isChatEngineConfig(session.config);
  // A Gemini chat too (one that leads a Round Table, from 1.39).
  const chat = isChatRun(session.config);
  // A chat channel's input is its conversation: prompts go in as messages, interruptions through the chat.
  const chatRun = () => session.runId && window.codingHub ? { codingHub: window.codingHub, runId: session.runId } : null;
  const sendPrompt = async (text: string) => { if (!chat) return submitTerminal(session.id, text); const run = chatRun(); if (!run) return false; chatSent(session.id, text, []); /* Shown at once and marked busy, as when typed in the chat. */ const result = await run.codingHub.chat({ action: 'send', sessionId: session.id, runId: run.runId, text, images: [] }).catch(() => null); if (!result?.ok) chatFailed(session.id, result && !result.ok ? result.error.message : 'The message could not be sent.'); return Boolean(result?.ok); };
  // A chat leading a Round Table stops the discussion quietly, as the table bar's Stop does; a plain interrupt would end it with a notice.
  const leadsTable = useChatStore((s) => Boolean(s.threads[session.id]?.table));
  const interrupt = () => { if (!chat) { void writeTerminal(session.id, '\x03'); return; } if (leadsTable) { void tableRequest(session.id, { action: 'table-stop' }); return; } const run = chatRun(); if (run) void run.codingHub.chat({ action: 'interrupt', sessionId: session.id, runId: run.runId }); };
  const engineName = atTable ? 'Round Table' : chat ? (claude ? 'Claude chat' : engine === 'gemini' ? 'Gemini chat' : custom ? `${look.name} chat` : 'Codex chat') : claude ? 'Claude Code' : shell ? 'Terminal' : engine === 'gemini' ? 'Gemini' : custom ? look.name : 'Codex CLI';
  const resumeId = !isAgentConfig(session.config) ? undefined : session.config.resumeId;
  const model = !isAgentConfig(session.config) ? '' : session.config.model;
  const channel = index + 1;
  // The setup page the error names, if it names one: a plain failure has Retry and Open log in the header.
  const setupView = session.error ? setupTarget(session.error, Boolean(cwd)) : null;
  // Closed, the error strip shows three lines and never scrolls; Show all opens the whole text (tile/error-strip.ts).
  const strip = useErrorStrip(session.error); const closedError = errorLines(session.error ?? '');
  // One terminal line's height, for what lies over the terminal's top (tile.css, --term-cover).
  const tile = useRef<HTMLElement>(null); useTerminalRow(tile, session.id, !chat);
  const busy = session.status === 'running' || session.status === 'starting';
  /** Undo last turn cannot keep copies here (not a Git folder): the controls row says why. */
  const undoUnavailable = useUndoStore((s) => { const status = s.bySession[session.id]; return status && !status.available ? status.reason ?? 'Undo last turn is unavailable here.' : null; });
  // A Round Table's hidden seat waiting on an approval holds this tile: its card is in this thread.
  const seatWaiting = useWorkspaceStore((s) => hiddenSeats(s.sessions, session.id).some((seat) => seat.status === 'running' && seat.attention));
  // Counts, not the list: a change to another channel then does not draw this tile again.
  const sessionCount = useWorkspaceStore((s) => s.sessions.length); const channelCount = useWorkspaceStore((s) => channelsOf(s.sessions).length);
  const state = session.status === 'running' && seatWaiting ? 'waiting' as const : channelState(session, usage); const meta = CHANNEL_STATES[state];
  // Near its limit: what Trace is doing about the handoff, or (where it cannot ask) the person's button to write one.
  const handoff = useHandoffStore((s) => handoffPhase(s.bySession, session)); const automaticMemory = useHubStore((s) => s.preferences.automaticMemory);
  const shown = state === 'limit' ? handoffShown(session, useWorkspaceStore.getState().sessions, usage, { automaticMemory }, handoff) : 'manual';
  const context = usage?.context && usage.context.limit > 0 ? usage.context : null;
  // Claude reports the tokens in context but not its window, so only the amount can be shown.
  const contextUsed = !context && usage?.context && usage.context.used > 0 ? usage.context.used : null;
  // The bar and ctx readout show the context window when the CLI reports one; the budget fills the bar only otherwise.
  // The channel state still uses the larger of the two (limitRatio).
  const contextRatio = context ? context.used / context.limit : null;
  const barRatio = contextRatio ?? (session.budget ? limitRatio(session, usage) : null);
  async function stop() {
    setStopping(true);
    try { return await stopSession(session.id); } finally { setStopping(false); }
  }
  async function close() {
    // A Round Table's hidden seats are stopped and closed with it.
    setStopping(true);
    try { await closeChannel(session.id); } finally { setStopping(false); }
  }
  const start = () => void startSession(session.id);
  // Over a terminal channel's terminal rather than above it: in the flow it would shrink the terminal, and the CLI would
  // be resized and redraw as each approval prompt appears and again when it is answered.
  const attention = session.status === 'running' && session.attention ? <div className={`session-attention ${chat ? '' : 'over-terminal'}`} role="alert"><span aria-hidden="true">◆</span><span>{session.attention.message}</span></div> : null;
  const openLog = () => { useWorkspaceStore.setState({ historyMode: 'failed', recoverySessionId: session.id }); setView('history'); };
  // The tile is a focus target: Enter starts an idle channel, otherwise moves into its terminal.
  const onTileKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.key !== 'Enter') return;
    event.preventDefault();
    if (state === 'idle') start(); else focusTerminal(session.id);
  };
  const action = state === 'idle' ? <button className="tr-action start" aria-label="Start channel" title="Start channel (Enter on the tile)" onClick={start}><Play size={12} aria-hidden="true" />Start<kbd aria-hidden="true">⏎</kbd></button>
    : state === 'waiting' ? <button className="tr-action waiting" aria-label="Answer in terminal" title="Go to this channel's terminal to answer the CLI" onClick={() => focusTerminal(session.id)}>Answer</button>
    : state === 'failed' ? <><button className="tr-action retry" onClick={start}>Retry</button><button className="tr-action ghost" onClick={openLog}>Open log</button></>
    : state === 'limit' ? <button className="tr-action limit" title={shown === 'manual' ? 'Write a handoff in Shared memory before the context runs out.' : `${HANDOFF_DETAIL[shown]} Opens Shared memory.`} onClick={() => setView('memory')}>{HANDOFF_LABEL[shown]}</button>
    : state === 'finished' && !shell ? <button className="tr-action ghost" onClick={() => { useWorkspaceStore.setState({ reviewSessionId: session.id }); setView('diff'); }}>Review changes<kbd aria-hidden="true">G C</kbd></button>
    : null;
  // The channel's numbers: in its header when the tile is wide enough, else in its footer (tile.css).
  const scope = (place: 'head' | 'foot') => <ScopeStrip place={place} sessionId={session.id} state={state} engine={engine} limit={barRatio} limitName={contextRatio !== null ? 'Context' : 'Budget'} chat={chat} tokens={custom || engine === 'gemini' && !measured ? null : today.tokens} contextUsed={contextUsed}
        tokensTitle={custom ? 'Trace does not count a custom agent’s tokens.' : engine === 'gemini' && !measured ? 'Not measured yet. Gemini records a request when it ends, and Trace reads it within a few seconds; two Gemini channels started in one folder are counted when they quit.' : today.tokens > 0 ? `New tokens in this channel today, across restarts: ${today.tokens.toLocaleString()}.${usage ? ' ' + tokenDetail(usage) : ''}` : usage ? tokenDetail(usage) : 'Waiting for structured CLI usage'} limitLabel={contextRatio !== null ? `Context ${Math.round(contextRatio * 100)}% (near its limit from 80%)` : `Channel budget ${Math.round((barRatio ?? 0) * 100)}% used (near its limit from 80%)`} />;
  const facts = [
    stopping ? 'Stopping the CLI and what it started…' : session.pid ? 'Running' : session.status === 'starting' ? 'Checking the CLI…' : session.exitCode !== null ? (session.exitCode === 0 ? 'Ended normally' : `Ended with exit code ${session.exitCode}`) : 'Ready to start',
    cwd ? `Folder ${folderName(cwd)}` : 'No folder chosen',
    usage ? `Cost ${dollars(usage.cost)}` : null,
    context ? `Context ${compact(context.used)} of ${compact(context.limit)}` : contextUsed !== null ? `Context ${compact(contextUsed)}` : null,
    handoff === 'compacted' ? 'Handoff saved, then compacted' : null,
  ].filter(Boolean);
  // The row stands open while what it opened is in use: the settings, a conversation, the question Close asks.
  const detailOpen = detailPinned || controlsOpen || conversation || confirmClose;
  return (
    <article ref={tile} style={custom ? { '--ch': look.color } as CSSProperties : undefined} className={`session-tile tr-tile ${engine} state-${state} ${controlsOpen ? 'config-open' : ''} ${detailOpen ? 'detail-open' : ''} ${focusedSessionId === session.id ? 'selected' : ''} ${confirmClose ? 'closing' : ''}`}
      data-session={session.id} onFocusCapture={() => { if (session.unseen) useWorkspaceStore.getState().markSeen(session.id); /* The desktop leads this channel's size again (1.35.2). */ if (session.status === 'running') void window.codingHub?.focusChannel?.({ sessionId: session.id }).catch(() => {}); }} onPointerDownCapture={() => { if (session.unseen) useWorkspaceStore.getState().markSeen(session.id); }} data-status={session.status} data-state={state} data-account={tone} aria-label={`${name} channel ${channel}${account ? `, ${account.name} account` : ''}`} tabIndex={0} onKeyDownCapture={() => { /* Typing in it (focus already there, so no focus event) is looking at it too. */ if (session.unseen) useWorkspaceStore.getState().markSeen(session.id); }} onKeyDown={onTileKey}>
      <div className="tr-tile-top">
        <header className="tile-header tr-tile-head">
          <span className="tile-drag-handle" title="Drag to reorder"><GripVertical size={14} /></span>
          <EngineAvatar engine={engine} agentId={agentId} title={engineName} />
          {/* The engine's name stays in the badge for screen readers; the avatar shows it. */}
          <span className="tr-ch-badge" title={engineName}>CH{channel}<span className="tr-ch-engine">{engineName}</span></span>
          <strong className="tr-tile-name" title={topic ? `${name}: ${topic}` : name}>{name}</strong>
          {topic && <span className="tr-tile-topic" title={topic}>{topic}</span>}
          <span className="tr-spacer" />
          {scope('head')}
          {shell ? <span className="tr-tile-model model-name" title="Your login shell, or PowerShell on Windows">shell</span> : <span className="tr-tile-model model-name" title={reportedModel ? `Model in use: ${reportedModel}${model ? ` (chosen in this channel's settings: ${model})` : ''}` : model ? `Model chosen in this channel's settings: ${model}` : lastModel ? `Last used: ${lastModel}. The CLI's own default applies until this run reports its model.` : 'The CLI’s own default model (shown once the channel reports it)'}>{modelLabel(reportedModel || model || lastModel || '') || 'CLI default'}</span>}
          {account && <span className="tr-profile-chip account-profile-chip ui-badge" data-account={tone} title={`Claude account: ${account.name}`}>{account.name}</span>}
          {preview && <button className="tr-action ghost" title={`Open the app at ${previewLabel(preview.url)}`} aria-label={`Open the app at ${previewLabel(preview.url)} from channel ${channel}`} onClick={() => void openPreview(session.id)}><AppWindow size={12} aria-hidden="true" />Preview</button>}
          {action}
          <button className={`tr-detail-button icon tr-tile-more ${detailOpen ? 'selected' : ''}`} title={detailOpen ? 'Hide this channel’s controls' : 'Show this channel’s controls: Stop, Settings, Maximize and more'} aria-label={`Controls of channel ${channel}`} aria-expanded={detailOpen} onClick={() => { /* Closing it closes what holds it open too (the settings, the conversation, the close question), or the press would do nothing. */ if (detailOpen) { setControlsOpen(false); setConversation(false); setConfirmClose(false); } setDetailPinned(!detailOpen); }}><Ellipsis size={14} aria-hidden="true" /></button>
          <span className="tr-state-chip ui-badge" role="status" aria-label={`Channel ${channel} ${meta.word.toLowerCase()}`}><i className="dot" aria-hidden="true" /><span className="tr-state-word">{meta.word}</span></span>
        </header>
        <div className="tr-tile-detail">
          {/* One span a fact, each after the first with its separator: a fact with no room leaves whole (tile.css). */}
          <span className="tr-detail-facts" title={[cwd, session.pid ? `Process ID ${session.pid}` : null].filter(Boolean).join(' · ') || undefined}>{facts.map((fact, index) => <span key={index}>{index ? ' · ' : ''}{fact}</span>)}</span>
          {session.status === 'running' && <button className="tr-detail-button icon" title="Interrupt current operation (Ctrl+C)" aria-label={`Interrupt channel ${channel}`} onClick={interrupt} disabled={stopping}><OctagonPause size={13} /></button>}
          {session.status === 'running'
            ? <button className="tr-detail-button stop" title="Stop the CLI and its child processes" onClick={() => void stop()} disabled={stopping}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Square size={12} className="tr-detail-icon" />}<span className="tr-detail-label">{stopping ? 'Stopping' : 'Stop'}</span></button>
            : state === 'finished' && <button className="tr-detail-button" title="Start this channel again" onClick={start}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">Restart</span></button>}
          {!shell && !chat && resumeId && <button className={`tr-detail-button ${conversation ? 'selected' : ''}`} title="The whole conversation, including what was said before restarts" aria-label={`Conversation of channel ${channel}`} aria-pressed={conversation} onClick={() => setConversation(!conversation)}><MessagesSquare size={13} className="tr-detail-icon" /><span className="tr-detail-label">Conversation</span></button>}
          <button className={`tr-detail-button ${controlsOpen ? 'selected' : ''}`} title="Engine settings" aria-label={`Engine settings for channel ${channel}`} aria-expanded={controlsOpen} onClick={() => setControlsOpen(!controlsOpen)}><Settings2 size={13} className="tr-detail-icon" /><span className="tr-detail-label">Settings</span></button>
          {tasked && <button className="tr-detail-button" title="Give this channel a task" aria-label={`Give channel ${channel} a task`} onClick={() => newTaskFor(session.id)}><ClipboardList size={13} className="tr-detail-icon" /><span className="tr-detail-label">Task</span></button>}
          {!shell && undoUnavailable && <button className="tr-detail-button" aria-disabled="true" title={undoUnavailable} aria-label={`Undo last turn is unavailable: ${undoUnavailable}`}><Undo2 size={13} className="tr-detail-icon" /><span className="tr-detail-label">Undo last turn</span></button>}
          <button className="tr-detail-button" title="Duplicate" aria-label={`Duplicate channel ${channel}`} disabled={sessionCount >= MAX_CHANNELS} onClick={() => addSession(engine, session.id)}><Copy size={13} className="tr-detail-icon" /><span className="tr-detail-label">Duplicate</span></button>
          <button className="tr-detail-button" title={focusedSessionId ? 'Restore grid' : 'Maximize'} aria-label={focusedSessionId ? 'Restore grid' : `Isolate channel ${channel}`} onClick={() => toggleFocus(session.id)}>{focusedSessionId ? <Minimize2 size={13} className="tr-detail-icon" /> : <Maximize2 size={13} className="tr-detail-icon" />}<span className="tr-detail-label">{focusedSessionId ? 'Restore' : 'Maximize'}</span></button>
          {confirmClose
            ? <ConfirmStep question={`Stop ${engineName} and close channel ${channel}?`} action="Stop and close" busy={stopping} onConfirm={() => { setConfirmClose(false); void close(); }} onCancel={() => setConfirmClose(false)} />
            : <button className="tr-detail-button" title="Stop and close (keep at least one channel)" aria-label={`Close channel ${channel}`} disabled={channelCount <= 1 || session.status === 'starting' || stopping} onClick={() => { if (closeAsks(session.status)) setConfirmClose(true); else void close(); }}><X size={13} className="tr-detail-icon" /><span className="tr-detail-label">Close</span></button>}
        </div>
      </div>
      {controlsOpen && <fieldset className="session-config" disabled={busy}>
        {isAgentConfig(session.config) && <EngineControls id={session.id} config={session.config} directory={cwd} onChange={(config) => updateConfig(session.id, config)} />}
        <label className="binding-control ui-field">Working folder<select aria-label="Working folder" value={session.binding.mode} onChange={(event) => updateBinding(session.id, event.target.value === 'workspace' ? { mode: 'workspace' } : { mode: 'independent', cwd: rootDirectory ?? '' })}><option value="workspace">Use workspace root</option><option value="independent">Independent repository</option></select></label>
        {session.binding.mode === 'independent' && <label className="binding-control ui-field">Repository path<input aria-label="Repository path" value={session.binding.cwd} placeholder="Absolute folder path" onChange={(event) => updateBinding(session.id, { mode: 'independent', cwd: event.target.value })} spellCheck={false} /><button className="button secondary" type="button" onClick={() => void window.codingHub?.pickDirectory().then((directory) => { if (directory) updateBinding(session.id, { mode: 'independent', cwd: directory }); }).catch(() => useWorkspaceStore.getState().setSessionError(session.id, 'Folder picker unavailable. Use Projects to enter a path.'))}><FolderOpen size={13} />Choose folder</button></label>}
        <SessionPreferences session={session} />
        <StartStepSettings session={session} />
        <WorktreeControls session={session} />
        {busy && <p className="control-note">Stop the channel to change its next launch settings.</p>}
      </fieldset>}
      {session.status === 'running' && peekCoachingPrompt(session.id) && <div className="session-error notice"><span>{peekCoachingPrompt(session.id)?.label === 'Send first request' ? 'Its first request from Start in order. Finish any CLI trust or setup prompts first.' : 'Finish any CLI trust or setup prompts first. This request asks the agent to read your prepared report.'}</span><button className="button secondary small" onClick={() => { const prompt = peekCoachingPrompt(session.id)?.prompt; if (prompt) { setCoachingSent(true); void sendPrompt(prompt).then((sent) => { if (sent) takeCoachingPrompt(session.id); else setCoachingSent(false); }); } }} disabled={coachingSent}>{peekCoachingPrompt(session.id)?.label ?? 'Send prepared request'}</button></div>}
      {/* One row for the check result and Undo last turn, wrapping only when the tile is too narrow for both: each was a row of its own, which a laptop's tiles could not spare. */}
      <div className="tile-bars"><AutoCheckLine sessionId={session.id} />{!shell && <UndoTurnLine sessionId={session.id} channel={channel} folder={cwd} />}</div>
      {chat && attention}
      {session.error && <div className={`session-error failure ${strip.open ? 'open' : ''}`} role="alert"><CircleAlert size={14} />{strip.open ? <span>{errorText(session.error)}</span> : <span className="session-error-lines" ref={strip.lines}>{closedError.lines.map((line, at) => <span key={at} title={line}>{line}</span>)}</span>}{!busy && session.exitCode !== null && session.exitCode !== 0 && engine === 'codex' && <button className="quiet-button small" onClick={() => { useWorkspaceStore.getState().resetCodexConfig(session.id); useWorkspaceStore.getState().setSessionError(session.id, 'Model and reasoning overrides cleared. The next launch starts a fresh conversation using local CLI defaults; the old conversation remains in native history.'); }}>Use Codex CLI defaults</button>}{!busy && setupView && <button className="quiet-button small" onClick={() => setView(setupView)}>{SETUP_TARGETS[setupView]}</button>}{(closedError.more || strip.cut || strip.open) && <button className="quiet-button small session-error-more" aria-expanded={strip.open} aria-label={`${strip.open ? 'Show less' : 'Show all'} of channel ${channel}'s error`} onClick={() => strip.setOpen(!strip.open)}>{strip.open ? 'Show less' : 'Show all'}<ChevronDown size={16} aria-hidden="true" /></button>}{/* A narrow tile's header has no room for Open log (tile.css, 400 px), and a tile on screen has no notice to carry it. */}{state === 'failed' && <button className="quiet-button small session-error-log" onClick={openLog}>Open log</button>}</div>}
      {!busy && !profileId && engines.find((item) => item.engine === engine)?.authentication?.state === 'not-authenticated' && <div className="session-error warning" role="status"><TriangleAlert size={14} /><span>CLI reports no login. Open Accounts & connections to sign in before starting.</span></div>}
      {alerts.length > 0 && <details className="budget-notice"><summary>Usage target notice · {alerts.length} {alerts.length === 1 ? 'threshold' : 'thresholds'}</summary>{alerts.map((alert) => <p key={alert}>{alert}</p>)}<p>Reported usage and estimates can lag. These alerts do not enforce provider billing limits.</p></details>}
      <div className={`terminal-frame ${session.status === 'idle' && !session.runId ? 'terminal-idle' : ''} ${chat ? 'chat-frame' : ''}`}>{chat ? <ChatView session={session} /> : <><TerminalViewport session={session} />{attention}</>}{conversation && !chat && resumeId && <div className="transcript-overlay"><TranscriptView agent={claude ? 'Claude Code' : engine === 'gemini' ? 'Gemini' : 'Codex'} load={() => workbench<ChannelTranscript>({ action: 'channel-transcript', sessionId: session.id })} /></div>}{session.status === 'idle' && !session.runId && !controlsOpen && <div className="session-welcome">
        <EngineAvatar engine={engine} agentId={agentId} size="large" className="welcome-engine" />
        <h3>{chat ? engineName : claude ? 'Claude Code' : shell ? 'Terminal' : engine === 'gemini' ? 'Gemini' : custom ? look.name : 'Codex'}</h3>
        <p>{resumeId ? 'Continues your saved conversation.' : shell ? 'Your shell, in this folder. Nothing it prints is recorded.' : chat ? `${claude ? 'Claude Code' : engine === 'gemini' ? 'Gemini' : custom ? look.name : 'Codex'} as a conversation.` : 'Your account, tools and folder.'}{shell ? '' : ' CLI permissions and approvals apply.'}</p>
        {/* The folder opens the channel's settings, where its folder is chosen; with no project yet, it opens Projects. */}
        <div className="welcome-actions">
          {cwd ? <button className="button secondary welcome-directory" aria-label={`${folderName(cwd)} · channel ${channel} settings`} title={`Channel settings · ${cwd}`} onClick={() => setControlsOpen(true)}><Folder size={14} /><span>{folderName(cwd)}</span></button>
            : <button className="button secondary welcome-directory" aria-label={`Choose project for channel ${channel}`} onClick={() => setView('projects')}><Folder size={14} /><span>Choose project</span></button>}
          <button className="button primary" aria-label={`Start channel ${channel}`} title="Start this channel (Enter on the tile)" onClick={start}><Play size={14} aria-hidden="true" />Start</button>
        </div>
      </div>}</div>
      {scope('foot')}
      {tasked && <TaskStrip sessionId={session.id} />}
      {tasked && <LiveTipStrip sessionId={session.id} />}
      {!chat && <PastedImages sessionId={session.id} />}
    </article>
  );
});
