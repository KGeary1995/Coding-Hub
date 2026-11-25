import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import { arrangeLinked, loadPlaces, ROW_HEIGHT, savePlaces } from '../../state/linked-layout';
import { CircleAlert, Download, GripVertical, History, LoaderCircle, MessagesSquare, Monitor, MonitorOff, MonitorPlay, OctagonPause, Play, RotateCcw, Square, X } from 'lucide-react';
import type { ChannelControl, ChannelTranscript, ChatReplay, LinkedComputer, RemoteChannel } from '../../../shared/remote';
import type { ChatRequest } from '../../../shared/chat';
import { TranscriptView } from '../chat/TranscriptView';
import { linkedChatKey, RemoteChat, receiveReplay } from '../chat/RemoteChat';
import { linkedTerminal } from '../../runtime/linked-terminals';
import { workbench } from '../../runtime/workbench';
import { useLinkedStore } from '../../state/linked-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { CHANNEL_STATES } from '../../state/channel-state';
import { LinkedScreen } from './LinkedScreen';
import { LinkedHistory } from './LinkedHistory';
import { LinkedTipStrip } from '../tile/LiveTipStrip';
import { ENGINE_ICONS } from '../tile/engine-icons';

/**
 * Restart and install on another computer, after asking: Trace there saves its workspace, installs the latest version
 * and restarts (a Mac that cannot update itself puts the old version back if the new one does not start).
 */
function UpdateThere({ computer }: { computer: LinkedComputer }) {
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  async function update() {
    setConfirm(false); setBusy(true); setNote(null);
    try { setNote({ text: (await workbench<{ message: string }>({ action: 'linked-update', id: computer.id })).message, error: false }); }
    catch (error) { setNote({ text: (error as Error).message, error: true }); }
    finally { setBusy(false); }
  }
  return <>
    {confirm ? <span className="linked-update-confirm">Restart Trace on {computer.name} to install the latest version?<button className="tr-detail-button stop" onClick={() => void update()}><span className="tr-detail-label">Restart and install</span></button><button className="tr-detail-button" onClick={() => setConfirm(false)}><span className="tr-detail-label">Cancel</span></button></span>
      : <button className="tr-detail-button" disabled={busy || !computer.connected} title={`Install the latest Trace on ${computer.name} and restart it there`} onClick={() => setConfirm(true)}>{busy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} className="tr-detail-icon" />}<span className="tr-detail-label">{busy ? 'Updating' : 'Update'}</span></button>}
    {note && <span className={note.error ? 'error-message' : 'muted'} role="status">{note.text}</span>}
  </>;
}

/**
 * Trace closed on that computer: its screen service (Windows, Share this screen) starts it in the tray, and the link
 * connects by itself. What went wrong, or what to do instead (a Mac, sharing off, asleep), is said beside the button.
 */
function OpenTraceThere({ computer }: { computer: LinkedComputer }) {
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  async function open() {
    setBusy(true); setNote(null);
    try { await workbench({ action: 'linked-open-trace', id: computer.id }); setNote({ text: `Opening Trace on ${computer.name}. It connects here by itself in a moment.`, error: false }); }
    catch (error) { setNote({ text: (error as Error).message, error: true }); }
    finally { setBusy(false); }
  }
  return <>
    <button className="button primary" disabled={busy} title={`Start Trace on ${computer.name} in its tray, through its screen sharing service`} onClick={() => void open()}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}Open Trace on {computer.name}</button>
    {note && <p className={note.error ? 'error-message' : 'muted'} role="status">{note.text}</p>}
  </>;
}

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', custom: 'Agent', shell: 'Terminal' } as const;

/**
 * A chat channel on another computer: its conversation, written to and answered from here. Its recent events are read
 * once as it opens (and for each new run); after that they arrive with the computer's other events.
 */
function LinkedChat({ computer, channel, engine }: { computer: LinkedComputer; channel: RemoteChannel; engine: 'claude' | 'codex' | 'gemini' }) {
  const keyOf = linkedChatKey(computer.id);
  useEffect(() => { void workbench<ChatReplay>({ action: 'linked-chat-history', id: computer.id, sessionId: channel.sessionId }).then((replay) => receiveReplay(replay, keyOf)).catch(() => {}); }, [computer.id, channel.sessionId, channel.runId]);
  return <RemoteChat sessionId={channel.sessionId} runId={channel.runId} engine={engine} running={channel.running} keyOf={keyOf} className="linked-chat"
    send={async (request: ChatRequest) => { await workbench({ action: 'linked-chat', id: computer.id, request }); }} />;
}
/** One channel on a linked computer: its live terminal at that CLI's size, and start, stop, restart and interrupt. */
function LinkedTile({ computer, channel }: { computer: LinkedComputer; channel: RemoteChannel }) {
  const container = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<ChannelControl | null>(null); const [error, setError] = useState(''); const [confirmClose, setConfirmClose] = useState(false); const [conversation, setConversation] = useState(false);
  useEffect(() => {
    if (!container.current || channel.chat) return;
    const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel);
    container.current.appendChild(entry.element);
    return () => { entry.element.remove(); };
  }, [computer.id, channel.sessionId]);
  // While the tile is shown, it asks for the channel at the tile's size; the other computer applies it while nobody
  // uses it there, and keeps its own size while someone does.
  useEffect(() => {
    const view = container.current; const runId = channel.runId; if (!view || channel.chat || !runId) return;
    const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel); let sent = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const screen = entry.element.querySelector<HTMLElement>('.xterm-screen'); const { cols, rows } = entry.terminal;
      if (!screen?.offsetWidth || !screen.offsetHeight || !view.clientWidth || !view.clientHeight) return;
      // Less the terminal's own scrollbar, as xterm's fit add-on leaves room for it.
      const fit = { cols: Math.max(20, Math.min(300, Math.floor((view.clientWidth - 14) * cols / screen.offsetWidth))), rows: Math.max(6, Math.min(200, Math.floor(view.clientHeight * rows / screen.offsetHeight))) };
      if (`${fit.cols}x${fit.rows}` === sent) return; sent = `${fit.cols}x${fit.rows}`;
      void workbench({ action: 'linked-fit', id: computer.id, sessionId: channel.sessionId, runId, ...fit }).catch(() => {});
    };
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(measure, 200); }); observer.observe(view);
    return () => { observer.disconnect(); clearTimeout(timer); void workbench({ action: 'linked-fit', id: computer.id, sessionId: channel.sessionId, runId }).catch(() => {}); };
  }, [computer.id, channel.sessionId, channel.runId]);
  // Typing needs the current run; a channel that has not drawn anything yet still takes input.
  useEffect(() => { if (channel.chat) return; const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel); if (channel.runId && !entry.runId) entry.runId = channel.runId; }, [channel.runId]);
  const control = async (action: ChannelControl) => {
    setBusy(action); setError('');
    try { await workbench({ action: 'linked-control', id: computer.id, sessionId: channel.sessionId, control: action }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const interrupt = () => { if (channel.runId) void workbench({ action: 'linked-input', id: computer.id, sessionId: channel.sessionId, runId: channel.runId, data: '\x03' }).catch((e: Error) => setError(e.message)); };
  // A channel that stopped with an error there is Failed here too, with why (it read as Idle before 1.31.1).
  const state = !channel.running ? (channel.failed ? 'failed' : 'idle') : channel.attention ? 'waiting' : 'working';
  // Whose account it runs on there, coloured as on desktop tiles here (that computer numbers its own accounts).
  const tone = channel.account ? String(channel.account.tone % 4) : undefined; const EngineIcon = ENGINE_ICONS[channel.engine];
  return <article className={`session-tile tr-tile linked-tile ${channel.engine} state-${state}`} data-account={tone} aria-label={`${computer.name} channel ${channel.channel}: ${channel.title}${channel.account ? `, ${channel.account.name} account` : ''}`}>
    <header className="tile-header tr-tile-head">
      <span className="tile-drag-handle" title="Drag to move (only here)"><GripVertical size={14} /></span>
      <span className={`ui-avatar small ${channel.engine}`} title={ENGINE_NAME[channel.engine]} aria-hidden="true"><EngineIcon /></span>
      {/* The engine's name stays in the badge for screen readers; the avatar shows it. */}
      <span className="tr-ch-badge" title={ENGINE_NAME[channel.engine]}>CH{channel.channel}<span className="tr-ch-engine">{ENGINE_NAME[channel.engine]}</span></span>
      <strong className="tr-tile-name" title={channel.title}>{channel.title}</strong>
      {channel.account && <span className="tr-profile-chip account-profile-chip ui-badge" data-account={tone} title={`Claude account on ${computer.name}: ${channel.account.name}`}>{channel.account.name}</span>}
      <span className="tr-spacer" />
      {channel.running
        ? <>{!channel.chat && <button className="tr-detail-button icon" title="Interrupt (Ctrl+C)" aria-label={`Interrupt channel ${channel.channel} on ${computer.name}`} disabled={Boolean(busy)} onClick={interrupt}><OctagonPause size={13} /></button>}
          <button className="tr-detail-button" disabled={Boolean(busy)} onClick={() => void control('restart')}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'restart' ? 'Restarting' : 'Restart'}</span></button>
          <button className="tr-detail-button stop" disabled={Boolean(busy)} onClick={() => void control('stop')}><Square size={12} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'stop' ? 'Stopping' : 'Stop'}</span></button></>
        : <button className="tr-action start" disabled={Boolean(busy)} onClick={() => void control('start')}><Play size={12} aria-hidden="true" /> {busy === 'start' ? 'Starting' : 'Start'}</button>}
      {channel.engine !== 'shell' && channel.engine !== 'gemini' && !channel.chat && <button className={`tr-detail-button ${conversation ? 'selected' : ''}`} title="The whole conversation, including what was said before restarts" aria-pressed={conversation} aria-label={`Conversation of channel ${channel.channel} on ${computer.name}`} onClick={() => setConversation(!conversation)}><MessagesSquare size={13} className="tr-detail-icon" /><span className="tr-detail-label">Conversation</span></button>}
      {confirmClose
        ? <span className="linked-close-confirm" role="group" aria-label={`Close channel ${channel.channel} on ${computer.name}?`}><span className="tr-detail-label">{channel.running ? 'Stop and close?' : 'Close?'}</span>
          <button className="tr-detail-button stop" disabled={Boolean(busy)} onClick={() => { setConfirmClose(false); void control('close'); }}><span className="tr-detail-label">{busy === 'close' ? 'Closing' : 'Close'}</span></button>
          <button className="tr-detail-button" disabled={Boolean(busy)} onClick={() => setConfirmClose(false)}><span className="tr-detail-label">Keep</span></button></span>
        : <button className="tr-detail-button icon" title={`Close this channel on ${computer.name}`} aria-label={`Close channel ${channel.channel} on ${computer.name}`} disabled={Boolean(busy)} onClick={() => setConfirmClose(true)}><X size={13} /></button>}
      <span className="tr-state-chip ui-badge" role="status"><i className="dot" aria-hidden="true" />{CHANNEL_STATES[state].word}</span>
    </header>
    {channel.attention && <div className="session-attention" role="alert"><span aria-hidden="true">◆</span><span>{channel.attention}</span></div>}
    {state === 'failed' && <div className="session-error failure" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{channel.failed}</span></div>}
    {error && <div className="session-error" role="alert"><span>{error}</span></div>}
    {channel.chat && channel.engine !== 'shell' && channel.engine !== 'custom'
      ? <LinkedChat computer={computer} channel={channel} engine={channel.engine} />
      : <div className="terminal-frame linked-frame"><div ref={container} className="terminal-viewport linked-viewport" role="region" aria-label={`${ENGINE_NAME[channel.engine]} terminal on ${computer.name}`} />
        {conversation && <div className="transcript-overlay"><TranscriptView agent={ENGINE_NAME[channel.engine]} where={computer.name} load={() => workbench<ChannelTranscript>({ action: 'linked-transcript', id: computer.id, sessionId: channel.sessionId })} /></div>}</div>}
    {channel.coaching && <LinkedTipStrip computerId={computer.id} computerName={computer.name} coaching={channel.coaching} />}
  </article>;
}

/** The channels running on one linked computer, live. */
export function LinkedComputerView() {
  const computerId = useWorkspaceStore((state) => state.computerId);
  const computer = useLinkedStore((state) => state.computers.find((item) => item.id === computerId));
  const addError = useLinkedStore((state) => state.addError);
  // The tab shows its channels, its screen or its conversations (History), one at a time.
  const [screenOf, setScreenOf] = useState<string | null>(null); const showScreen = Boolean(computer && screenOf === computer.id);
  const [historyOf, setHistoryOf] = useState<string | null>(null); const showHistory = Boolean(computer && historyOf === computer.id) && !showScreen;
  // Every channel's current screen, whenever the tab opens, reconnects, or a channel starts a new run.
  const runs = computer?.channels.map((channel) => `${channel.sessionId}:${channel.runId}`).join() ?? '';
  useEffect(() => { if (computer?.connected) void workbench({ action: 'linked-watch', id: computer.id }).catch(() => {}); }, [computer?.id, computer?.connected, runs]);
  // Leaving the tab stops the other computer's live output reaching this window (phones still get it).
  useEffect(() => { const id = computer?.id; return () => { useLinkedStore.setState({ addError: '' }); if (id) void workbench({ action: 'linked-unwatch', id }).catch(() => {}); }; }, [computer?.id]);
  if (!computer) return <section className="linked-computer"><div className="ui-empty linked-empty"><MonitorOff aria-hidden="true" /><h3>That computer is no longer linked</h3><p>Open Settings → Other computers.</p></div></section>;
  return <section className="linked-computer" aria-labelledby="linked-computer-title">
    <header className="linked-computer-head"><h1 id="linked-computer-title"><Monitor size={16} aria-hidden="true" />{computer.name}</h1>
      <span className={`linked-computer-status ${!computer.connected && computer.error ? 'off' : ''}`}>{computer.connected ? `${computer.channels.length} ${computer.channels.length === 1 ? 'channel' : 'channels'}` : computer.error ?? 'Connecting…'}</span>
      <span className="tr-spacer" />
      <UpdateThere computer={computer} />
      <button className="tr-detail-button" aria-pressed={showHistory} disabled={!computer.connected && !showHistory} title={`${computer.name}'s Claude Code, Codex and Gemini conversations, to resume there`} onClick={() => { setScreenOf(null); setHistoryOf(showHistory ? null : computer.id); }}><History size={13} className="tr-detail-icon" /><span className="tr-detail-label">{showHistory ? 'Channels' : 'History'}</span></button>
      {/* Its own screen-sharing server answers even while Trace there is closed. */}
      <button className="tr-detail-button" aria-pressed={showScreen} title={`Show and control ${computer.name}'s screen (macOS Screen Sharing)`} onClick={() => { setHistoryOf(null); setScreenOf(showScreen ? null : computer.id); }}><MonitorPlay size={13} className="tr-detail-icon" /><span className="tr-detail-label">{showScreen ? 'Channels' : 'Screen'}</span></button></header>
    {addError && <div className="ui-banner danger" role="alert"><CircleAlert aria-hidden="true" /><span>{addError}</span><button className="icon-button small" aria-label="Dismiss this notice" onClick={() => useLinkedStore.setState({ addError: '' })}><X /></button></div>}
    {showScreen ? <LinkedScreen key={computer.id} computer={computer} onClose={() => setScreenOf(null)} /> : showHistory ? <LinkedHistory key={computer.id} computer={computer} onChannels={() => setHistoryOf(null)} /> : <>
      {computer.connected && !computer.channels.length && <div className="ui-empty linked-empty"><Monitor aria-hidden="true" /><h3>No channels on {computer.name}</h3><p>Add one with + Channel.</p></div>}
      {/* Not connected and no reason yet: still connecting, which is not a failure. */}
      {!computer.connected && !computer.error && computer.linked && <div className="ui-empty linked-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" /><h3>Connecting to {computer.name}…</h3></div>}
      {/* Its screen-sharing server answers even while Trace there is closed, so the screen is the one action offered. */}
      {!computer.connected && (computer.error || !computer.linked) && <div className="ui-empty linked-empty danger"><MonitorOff aria-hidden="true" /><h3>{computer.name} is not reachable; Trace keeps trying</h3><p>Check that it is on, with Trace open and Tailscale connected.</p>
        {computer.linked && <OpenTraceThere computer={computer} />}
        {/* The header's Screen does the same; this one is named apart so each name stays unique. */}<button className="button secondary" aria-label={`Screen of ${computer.name}`} title={`If Trace has closed on ${computer.name}, its screen still answers`} onClick={() => setScreenOf(computer.id)}><MonitorPlay aria-hidden="true" />Screen</button></div>}
      {computer.channels.length > 0 && <LinkedGrid computer={computer} />}</>}
  </section>;
}

/** The other computer's channels as tiles that move and resize like this computer's own, by their header grip and corner. */
function LinkedGrid({ computer }: { computer: LinkedComputer }) {
  const container = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(0);
  const [saved, setSaved] = useState(() => loadPlaces(computer.id));
  useEffect(() => setSaved(loadPlaces(computer.id)), [computer.id]);
  useLayoutEffect(() => {
    const element = container.current; if (!element) return;
    const measure = () => setWidth(element.clientWidth); measure();
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  const ids = computer.channels.map((channel) => channel.sessionId);
  const layout = arrangeLinked(ids, saved);
  const change = (next: Layout[]) => {
    const places = Object.fromEntries(next.filter((tile) => ids.includes(tile.i)).map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));
    if (JSON.stringify(places) === JSON.stringify(Object.fromEntries(layout.map(({ i, x, y, w, h }) => [i, { x, y, w, h }])))) return;
    setSaved(places); savePlaces(computer.id, places);
  };
  return <div ref={container} className="linked-grid">
    {width > 0 && <GridLayout className="session-grid" width={width} cols={12} rowHeight={ROW_HEIGHT} margin={[8, 8]} containerPadding={[0, 0]} layout={layout}
      draggableHandle=".tile-drag-handle" draggableCancel="button,input,select,.terminal-viewport" compactType="vertical" resizeHandles={['se']} onLayoutChange={change}>
      {computer.channels.map((channel) => <div key={channel.sessionId}><LinkedTile computer={computer} channel={channel} /></div>)}
    </GridLayout>}
  </div>;
}
