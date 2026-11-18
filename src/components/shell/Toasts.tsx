import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts } from '../../state/channel-state';
import { startSession } from '../../runtime/use-native-host';
import { jumpToChannel } from './StatusBar';
import { RestartNotice } from './RestartNotice';

/**
 * Where the notices stand: over the bottom-right corner, or at the top right (`raised`, under the tiles' header rows)
 * while the keyboard focus is in a tile that corner covers, so a notice never lies over the message box or the prompt
 * being typed in. Focus inside a notice changes nothing: its button would otherwise move away under the pointer that
 * is pressing it. `under` is set when that tile is a conversation that also reaches the top of that side (columns, or
 * one maximised): the top of its thread as a share of the window's height, so the notices start under its bars
 * (shell.css) and Stop both, Approve plan and Close stay in reach.
 */
function useClearOfFocus() {
  const column = useRef<HTMLElement>(null); const [raised, setRaised] = useState(false); const [under, setUnder] = useState<number | null>(null);
  useEffect(() => {
    let watched: Element | null = null;
    const place = () => {
      const box = column.current; const focused = document.activeElement; if (!box || box.contains(focused)) return;
      const tile = focused?.closest('.session-tile'); const at = tile?.getBoundingClientRect(); const bar = document.querySelector('.app-statusbar')?.getBoundingClientRect(); const own = box.getBoundingClientRect();
      // Its place at the bottom, wherever it stands now: the same sides, and its own height up from the status bar.
      const covered = Boolean(at && bar && own.height > 0 && at.right > own.left && at.left < own.right && at.bottom > bar.top - own.height && at.top < bar.top);
      setRaised(covered);
      // No tile above it on that side: the raised place is over this tile too. A share of the height, so it holds at any display scale.
      const thread = covered && tile && at && ![...document.querySelectorAll('.session-tile')].some((other) => { const rect = other.getBoundingClientRect(); return rect.right > own.left && rect.left < own.right && rect.top < at.top; }) ? tile.querySelector('.chat-thread') : null;
      // Its bars grow and wrap while the focus stays put, which moves the thread's top.
      if (thread !== watched) { if (watched) observer.unobserve(watched); if (thread) observer.observe(thread); watched = thread; }
      setUnder(thread ? Math.round(thread.getBoundingClientRect().top / window.innerHeight * 10000) / 100 : null);
    };
    // After the focus has left, it is on the page for a moment before the next element takes it.
    const later = () => { requestAnimationFrame(place); };
    // A notice that comes or goes changes the height, and so what the corner covers.
    const observer = new ResizeObserver(place); if (column.current) observer.observe(column.current);
    document.addEventListener('focusin', place); document.addEventListener('focusout', later); window.addEventListener('resize', place);
    return () => { observer.disconnect(); document.removeEventListener('focusin', place); document.removeEventListener('focusout', later); window.removeEventListener('resize', place); };
  }, []);
  return { column, raised, under };
}

/**
 * Bottom-right notices for channels that need the person (waiting) or have failed. They stay until the channel moves
 * on (answered, retried, closed) or the person dismisses them; a channel that needs them again gets a new notice.
 */
export function Toasts() {
  const { sessions, setView } = useWorkspaceStore(useShallow((s) => ({ sessions: s.sessions, setView: s.setView })));
  const usage = useHubStore((state) => state.usage);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const alerts = channelAlerts(sessions, usage).filter((alert) => alert.state !== 'limit');
  const active = alerts.map((alert) => {
    const session = sessions.find((item) => item.id === alert.sessionId)!;
    return { alert, session, key: `${alert.sessionId}:${alert.state}:${alert.state === 'waiting' ? session.attention?.at : session.runId}` };
  });
  const activeKeys = active.map(({ key }) => key).join('\n');
  // A dismissal lasts only while its notice is current: once the channel moves on (answered, retried, closed), it is
  // forgotten, so the next request or failure shows again even when a launch failed before it had a run ID.
  useEffect(() => { setDismissed((current) => { const kept = current.filter((key) => activeKeys.split('\n').includes(key)); return kept.length === current.length ? current : kept; }); }, [activeKeys]);
  const keyed = active.filter(({ key }) => !dismissed.includes(key));
  const { column, raised, under } = useClearOfFocus();
  // The restart notice shares the column, so notices never sit on top of each other (an empty column takes no space).
  return <section ref={column} className={`tr-toasts ${raised ? 'raised' : ''}`} style={under === null ? undefined : { '--tr-toasts-under': `${under}%` } as CSSProperties} aria-label="Channel notifications" aria-live="polite"><RestartNotice /><LoadNotice />
    {keyed.map(({ alert, session, key }) => {
      const meta = CHANNEL_STATES[alert.state]; const channel = `CH${alert.channel}`;
      // One line with an ellipsis, so the whole text is also its tooltip.
      const message = alert.state === 'waiting' ? session.attention?.message : session.error?.split('\n')[0] ?? `${session.title} stopped with an error.`;
      return <article key={key} className={`tr-toast ${alert.state}`}>
        <header><span aria-hidden="true">{meta.glyph}</span><strong>{alert.text}</strong>
          <button className="tr-toast-close icon-button small" aria-label={`Dismiss ${channel} notification`} onClick={() => setDismissed([...dismissed, key])}><X /></button></header>
        <p title={message}>{message}</p>
        {/* Actions sit at the right, the main one last. */}
        <footer>
          {alert.state === 'waiting'
            ? <button className="tr-toast-action button small waiting" aria-label={`Answer ${channel} in its terminal`} onClick={() => jumpToChannel(session.id)}>Answer<kbd aria-hidden="true">Alt {alert.channel}</kbd></button>
            : <><button className="tr-toast-action quiet-button small" aria-label={`Open log for ${channel}`} onClick={() => { useWorkspaceStore.setState({ workflowTab: 'recovery', recoverySessionId: session.id }); setView('workflow'); }}>Open log</button>
              <button className="tr-toast-action button small primary" aria-label={`Retry ${channel}`} onClick={() => { setView('workspace'); void startSession(session.id); }}>Retry</button></>}
        </footer>
      </article>;
    })}
  </section>;
}

/** What loading the saved workspace changed (Gemini channels removed, as Trace no longer runs Gemini), until dismissed. */
function LoadNotice() {
  const notice = useWorkspaceStore((state) => state.loadNotice);
  if (!notice) return null;
  return <article className="tr-toast" aria-label="Workspace loaded">
    <header><strong>Workspace loaded</strong><button className="tr-toast-close icon-button small" aria-label="Dismiss the workspace notice" onClick={() => useWorkspaceStore.setState({ loadNotice: null })}><X /></button></header>
    <p>{notice}</p>
  </article>;
}
