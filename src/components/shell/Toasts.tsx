import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts } from '../../state/channel-state';
import { startSession } from '../../runtime/use-native-host';
import { jumpToChannel } from './StatusBar';

/**
 * Bottom-right notices for channels that need the person (waiting) or have failed. They stay until the channel moves
 * on (answered, retried, closed) or the person dismisses them; a channel that needs them again gets a new notice.
 */
export function Toasts() {
  const { sessions, setView } = useWorkspaceStore();
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
  if (!keyed.length) return null;
  return <section className="tr-toasts" aria-label="Channel notifications" aria-live="polite">
    {keyed.map(({ alert, session, key }) => {
      const meta = CHANNEL_STATES[alert.state]; const channel = `CH${alert.channel}`;
      return <article key={key} className={`tr-toast ${alert.state}`}>
        <header><span aria-hidden="true">{meta.glyph}</span><strong>{alert.text}</strong>
          <button className="tr-toast-close" aria-label={`Dismiss ${channel} notification`} onClick={() => setDismissed([...dismissed, key])}><X size={14} /></button></header>
        <p>{alert.state === 'waiting' ? session.attention?.message : session.error?.split('\n')[0] ?? `${session.title} stopped with an error.`}</p>
        <footer>
          {alert.state === 'waiting'
            ? <button className="tr-toast-action waiting" aria-label={`Answer ${channel} in its terminal`} onClick={() => jumpToChannel(session.id)}>Answer<kbd aria-hidden="true">Alt {alert.channel}</kbd></button>
            : <><button className="tr-toast-action" aria-label={`Retry ${channel}`} onClick={() => { setView('workspace'); void startSession(session.id); }}>Retry</button>
              <button className="tr-toast-action ghost" aria-label={`Open log for ${channel}`} onClick={() => { useWorkspaceStore.setState({ workflowTab: 'recovery', recoverySessionId: session.id }); setView('workflow'); }}>Open log</button></>}
        </footer>
      </article>;
    })}
  </section>;
}
