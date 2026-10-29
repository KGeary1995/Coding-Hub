import { useEffect, useRef, useState } from 'react';
import { Monitor, OctagonPause, Play, RotateCcw, Square } from 'lucide-react';
import type { ChannelControl, LinkedComputer, RemoteChannel } from '../../../shared/remote';
import { linkedTerminal } from '../../runtime/linked-terminals';
import { workbench } from '../../runtime/workbench';
import { useLinkedStore } from '../../state/linked-store';
import { useWorkspaceStore } from '../../state/workspace-store';

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' } as const;

/** One channel on a linked computer: its live terminal at that CLI's size, and start, stop, restart and interrupt. */
function LinkedTile({ computer, channel }: { computer: LinkedComputer; channel: RemoteChannel }) {
  const container = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<ChannelControl | null>(null); const [error, setError] = useState('');
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
  useEffect(() => { const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel); if (channel.runId && !entry.runId) entry.runId = channel.runId; }, [channel.runId]);
  const control = async (action: ChannelControl) => {
    setBusy(action); setError('');
    try { await workbench({ action: 'linked-control', id: computer.id, sessionId: channel.sessionId, control: action }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const interrupt = () => { if (channel.runId) void workbench({ action: 'linked-input', id: computer.id, sessionId: channel.sessionId, runId: channel.runId, data: '\x03' }).catch((e: Error) => setError(e.message)); };
  const state = !channel.running ? 'idle' : channel.attention ? 'waiting' : 'working';
  // Whose account it runs on there, coloured as on desktop tiles here (that computer numbers its own accounts).
  const tone = channel.account ? String(channel.account.tone % 4) : undefined;
  return <article className={`session-tile tr-tile linked-tile ${channel.engine} state-${state}`} data-account={tone} aria-label={`${computer.name} channel ${channel.channel}: ${channel.title}${channel.account ? `, ${channel.account.name} account` : ''}`}>
    <header className="tile-header tr-tile-head">
      <span className="tr-ch-badge" style={{ background: `var(--tr-ch-${channel.engine})` }} title={ENGINE_NAME[channel.engine]}>CH{channel.channel}</span>
      <strong className="tr-tile-name" title={channel.title}>{channel.title}</strong>
      <span className="tr-tile-model model-name">{computer.name}</span>
      {channel.account && <span className="tr-profile-chip account-profile-chip" data-account={tone} title={`Claude account on ${computer.name}: ${channel.account.name}`}>{channel.account.name}</span>}
      <span className="tr-spacer" />
      {channel.running
        ? <>{!channel.chat && <button className="tr-detail-button icon" title="Interrupt (Ctrl+C)" aria-label={`Interrupt channel ${channel.channel} on ${computer.name}`} disabled={Boolean(busy)} onClick={interrupt}><OctagonPause size={13} /></button>}
          <button className="tr-detail-button" disabled={Boolean(busy)} onClick={() => void control('restart')}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'restart' ? 'Restarting' : 'Restart'}</span></button>
          <button className="tr-detail-button stop" disabled={Boolean(busy)} onClick={() => void control('stop')}><Square size={12} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'stop' ? 'Stopping' : 'Stop'}</span></button></>
        : <button className="tr-action start" disabled={Boolean(busy)} onClick={() => void control('start')}><Play size={12} aria-hidden="true" /> {busy === 'start' ? 'Starting' : 'Start'}</button>}
      <span className="tr-state-chip" role="status">{state === 'idle' ? '○ IDLE' : state === 'waiting' ? '◆ HOLD' : '● RUN'}</span>
    </header>
    {channel.attention && <div className="session-attention" role="alert"><span aria-hidden="true">◆</span><span>{channel.attention}</span></div>}
    {error && <div className="session-error" role="alert"><span>{error}</span></div>}
    {channel.chat
      ? <p className="history-empty">This is a chat channel. Its conversation is shown on {computer.name}, and answered there.</p>
      : <div className="terminal-frame linked-frame"><div ref={container} className="terminal-viewport linked-viewport" role="region" aria-label={`${ENGINE_NAME[channel.engine]} terminal on ${computer.name}`} /></div>}
  </article>;
}

/** The channels running on one linked computer, live. */
export function LinkedComputerView() {
  const computerId = useWorkspaceStore((state) => state.computerId);
  const computer = useLinkedStore((state) => state.computers.find((item) => item.id === computerId));
  const addError = useLinkedStore((state) => state.addError);
  // Every channel's current screen, whenever the tab opens, reconnects, or a channel starts a new run.
  const runs = computer?.channels.map((channel) => `${channel.sessionId}:${channel.runId}`).join() ?? '';
  useEffect(() => { if (computer?.connected) void workbench({ action: 'linked-watch', id: computer.id }).catch(() => {}); }, [computer?.id, computer?.connected, runs]);
  // Leaving the tab stops the other computer's live output reaching this window (phones still get it).
  useEffect(() => { const id = computer?.id; return () => { useLinkedStore.setState({ addError: '' }); if (id) void workbench({ action: 'linked-unwatch', id }).catch(() => {}); }; }, [computer?.id]);
  if (!computer) return <section className="feature-panel"><p className="history-empty">That computer is no longer linked. Open Settings → Other computers.</p></section>;
  return <section className="linked-computer" aria-labelledby="linked-computer-title">
    <header className="linked-computer-head"><h1 id="linked-computer-title"><Monitor size={16} aria-hidden="true" />{computer.name}</h1>
      <span className={`storage-status ${computer.connected ? 'saved' : ''}`}>{computer.connected ? `${computer.channels.length} ${computer.channels.length === 1 ? 'channel' : 'channels'}` : computer.error ?? 'Connecting…'}</span></header>
    {addError && <p className="session-error" role="alert">{addError}</p>}
    {computer.connected && !computer.channels.length && <p className="history-empty">No channels on {computer.name}. Add one with + Channel.</p>}
    {!computer.connected && <p className="history-empty">{computer.name} is not reachable right now. Trace keeps trying; check that it is on, Trace is open there, and Tailscale is connected.</p>}
    <div className="linked-grid">{computer.channels.map((channel) => <LinkedTile key={channel.sessionId} computer={computer} channel={channel} />)}</div>
  </section>;
}
