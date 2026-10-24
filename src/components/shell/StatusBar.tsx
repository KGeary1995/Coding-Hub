import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore, tokens, formatNumber, dollars } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts, channelState, todayTotals, usageFor } from '../../state/channel-state';
import { focusTerminal } from '../../runtime/terminals';

/** Compact token counts for status cells: 812, 48.2k, 1.3M. */
export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();

/** The one global status layer: every channel's state, the project, today's usage, alerts and the host. */
export function StatusBar() {
  const { sessions, rootDirectory, persistenceStatus, setView } = useWorkspaceStore();
  const usage = useHubStore((state) => state.usage);
  const today = todayTotals(usage);
  const alerts = channelAlerts(sessions, usage);
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'no project';
  const jump = (id: string) => { setView('workspace'); requestAnimationFrame(() => focusTerminal(id)); };
  return <footer className="app-statusbar tr-statusbar">
    {sessions.map((session, index) => {
      const record = usageFor(session, usage); const state = channelState(session, record); const meta = CHANNEL_STATES[state];
      const color = meta.color === 'engine' ? `var(--tr-ch-${session.config.engine})` : meta.color;
      return <button key={session.id} className="tr-sb-cell tr-sb-channel" title={`${session.title}: ${meta.word.toLowerCase()}${session.attention ? ` · ${session.attention.message}` : ''}`} onClick={() => jump(session.id)}>
        <i className="tr-engine-square" style={{ background: `var(--tr-ch-${session.config.engine})` }} aria-hidden="true" />CH{index + 1}
        <span style={{ color }}><span aria-hidden="true">{meta.glyph}</span> {meta.word.toLowerCase()}</span>
        {record && <span className="tnum">{compact(tokens(record))} tok</span>}
      </button>;
    })}
    <span className="tr-sb-cell tr-sb-project" title={rootDirectory ?? undefined}>{project}</span>
    <span className="tr-spacer" />
    <span className="tr-sb-cell tnum" title="Input and output tokens reported today, cache excluded">Σ today {compact(today.tokens)} tok {today.cost === null ? '' : dollars(today.cost)}</span>
    {alerts.length
      ? <button className={`tr-sb-cell tr-sb-alert ${alerts.some((alert) => alert.state === 'failed') ? 'failed' : alerts[0].state}`} onClick={() => jump(alerts[0].sessionId)} title="Go to the first channel that needs you">
        <span aria-hidden="true">{CHANNEL_STATES[alerts[0].state].glyph}</span> {alerts.map((alert) => alert.text).join(' · ')}
      </button>
      : <span className="tr-sb-cell tr-sb-quiet">no alerts</span>}
    <span className={`tr-sb-cell storage-status ${persistenceStatus}`} data-testid="persistence-status">
      {persistenceStatus === 'saved' ? 'Workspace saved locally' : persistenceStatus === 'saving' ? 'Saving workspace…' : persistenceStatus === 'error' ? 'Storage needs attention' : persistenceStatus === 'loading' ? 'Loading workspace…' : 'Browser preview'}
    </span>
    <span className="tr-sb-cell tr-sb-host"><i className={window.codingHub ? 'online' : ''} aria-hidden="true" />{window.codingHub ? 'host · local' : 'browser preview'}</span>
  </footer>;
}

export { formatNumber };
