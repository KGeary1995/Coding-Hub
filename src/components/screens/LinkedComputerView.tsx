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
    if (!container.current) return;
    const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel);
    container.current.appendChild(entry.element);
    return () => { entry.element.remove(); };
  }, [computer.id, channel.sessionId]);
  // Typing needs the current run; a channel that has not drawn anything yet still takes input.
  useEffect(() => { const entry = linkedTerminal(computer.id, channel.sessionId, channel.engine, channel); if (channel.runId && !entry.runId) entry.runId = channel.runId; }, [channel.runId]);
  const control = async (action: ChannelControl) => {
    setBusy(action); setError('');
    try { await workbench({ action: 'linked-control', id: computer.id, sessionId: channel.sessionId, control: action }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const interrupt = () => { if (channel.runId) void workbench({ action: 'linked-input', id: computer.id, sessionId: channel.sessionId, runId: channel.runId, data: '\x03' }).catch((e: Error) => setError(e.message)); };
  const state = !channel.running ? 'idle' : channel.attention ? 'waiting' : 'working';
  return <article className={`session-tile tr-tile linked-tile ${channel.engine} state-${state}`} aria-label={`${computer.name} channel ${channel.channel}: ${channel.title}`}>
    <header className="tile-header tr-tile-head">
      <span className="tr-ch-badge" style={{ background: `var(--tr-ch-${channel.engine})` }} title={ENGINE_NAME[channel.engine]}>CH{channel.channel}</span>
      <strong className="tr-tile-name" title={channel.title}>{channel.title}</strong>
      <span className="tr-tile-model model-name">{computer.name}</span>
      <span className="tr-spacer" />
      {channel.running
        ? <><button className="tr-detail-button icon" title="Interrupt (Ctrl+C)" aria-label={`Interrupt channel ${channel.channel} on ${computer.name}`} disabled={Boolean(busy)} onClick={interrupt}><OctagonPause size={13} /></button>
          <button className="tr-detail-button" disabled={Boolean(busy)} onClick={() => void control('restart')}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'restart' ? 'Restarting' : 'Restart'}</span></button>
          <button className="tr-detail-button stop" disabled={Boolean(busy)} onClick={() => void control('stop')}><Square size={12} className="tr-detail-icon" /><span className="tr-detail-label">{busy === 'stop' ? 'Stopping' : 'Stop'}</span></button></>
        : <button className="tr-action start" disabled={Boolean(busy)} onClick={() => void control('start')}><Play size={12} aria-hidden="true" /> {busy === 'start' ? 'Starting' : 'Start'}</button>}
      <span className="tr-state-chip" role="status">{state === 'idle' ? '○ IDLE' : state === 'waiting' ? '◆ HOLD' : '● RUN'}</span>
    </header>
    {channel.attention && <div className="session-attention" role="alert"><span aria-hidden="true">◆</span><span>{channel.attention}</span></div>}
    {error && <div className="session-error" role="alert"><span>{error}</span></div>}
    <div className="terminal-frame linked-frame"><div ref={container} className="terminal-viewport linked-viewport" role="region" aria-label={`${ENGINE_NAME[channel.engine]} terminal on ${computer.name}`} /></div>
  </article>;
}

/** The channels running on one linked computer, live. */
export function LinkedComputerView() {
  const computerId = useWorkspaceStore((state) => state.computerId);
  const computer = useLinkedStore((state) => state.computers.find((item) => item.id === computerId));
  // Every channel's current screen, whenever the tab opens, reconnects, or a channel starts a new run.
  const runs = computer?.channels.map((channel) => `${channel.sessionId}:${channel.runId}`).join() ?? '';
  useEffect(() => { if (computer?.connected) void workbench({ action: 'linked-watch', id: computer.id }).catch(() => {}); }, [computer?.id, computer?.connected, runs]);
  // Leaving the tab stops the other computer's live output reaching this window (phones still get it).
  useEffect(() => { const id = computer?.id; return () => { if (id) void workbench({ action: 'linked-unwatch', id }).catch(() => {}); }; }, [computer?.id]);
  if (!computer) return <section className="feature-panel"><p className="history-empty">That computer is no longer linked. Open Settings → Other computers.</p></section>;
  return <section className="linked-computer" aria-labelledby="linked-computer-title">
    <header className="linked-computer-head"><h1 id="linked-computer-title"><Monitor size={16} aria-hidden="true" />{computer.name}</h1>
      <span className={`storage-status ${computer.connected ? 'saved' : ''}`}>{computer.connected ? `${computer.channels.length} ${computer.channels.length === 1 ? 'channel' : 'channels'}` : computer.error ?? 'Connecting…'}</span></header>
    {computer.connected && !computer.channels.length && <p className="history-empty">No channels on {computer.name}.</p>}
    {!computer.connected && <p className="history-empty">{computer.name} is not reachable right now. Trace keeps trying; check that it is on, Trace is open there, and Tailscale is connected.</p>}
    <div className="linked-grid">{computer.channels.map((channel) => <LinkedTile key={channel.sessionId} computer={computer} channel={channel} />)}</div>
  </section>;
}
