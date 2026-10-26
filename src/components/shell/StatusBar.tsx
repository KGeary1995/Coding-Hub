import { useEffect } from 'react';
import { channelNameNow } from '../../state/channel-names';
import { limitLevel, refreshPlanLimits, resetText, usePlanLimits } from '../../state/plan-limits-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore, tokens, formatNumber, dollars } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts, channelState, todayTotals, usageFor } from '../../state/channel-state';
import { focusTerminal } from '../../runtime/terminals';

/** Compact token counts for status cells: 812, 48.2k, 1.3M. */
export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();

/** Shows a channel in the workspace and focuses its terminal, isolating it if another channel is isolated (as Alt+1–8 does). */
export function jumpToChannel(id: string) {
  const state = useWorkspaceStore.getState();
  // Only the isolated tile's terminal is mounted; isolate the requested one instead.
  if (state.focusedSessionId && state.focusedSessionId !== id) state.toggleFocus(id);
  state.setView('workspace'); requestAnimationFrame(() => focusTerminal(id));
}

const SHORT: Record<string, string> = { Session: '5h', Week: 'wk' };
/**
 * Each agent's subscription limits, always in view: the 5-hour session and the week, as used percentages that turn
 * amber and then red as they fill. Hover for every limit, account and reset; click for Usage.
 */
function PlanLimitCells() {
  const limits = usePlanLimits((state) => state.limits);
  useEffect(() => {
    if (!window.codingHub) return;
    void refreshPlanLimits();
    const timer = setInterval(() => void refreshPlanLimits(), 5 * 60000);
    const focus = () => void refreshPlanLimits();
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, []);
  return <>{(['claude', 'codex'] as const).map((engine) => {
    const all = limits.filter((item) => item.engine === engine); const main = all.find((item) => item.account === 'Default') ?? all[0];
    if (!main) return null;
    const shown = main.windows.filter((window) => window.label in SHORT);
    const worst = Math.max(0, ...shown.map((window) => window.usedPercent));
    const title = all.map((item) => `${engine === 'claude' ? 'Claude' : 'Codex'}${all.length > 1 || item.account !== 'Default' ? ` · ${item.account}` : ''}${item.plan ? ` (${item.plan})` : ''}\n${item.error ?? item.windows.map((window) => `  ${window.label}: ${window.usedPercent}% used${resetText(window) ? `, resets ${resetText(window)}` : ''}`).join('\n')}`).join('\n\n');
    return <button key={engine} className={`tr-sb-cell tr-sb-limits ${limitLevel(worst)}`} title={title} onClick={() => useWorkspaceStore.getState().setView('usage')}>
      <i className="tr-engine-square" style={{ background: `var(--tr-ch-${engine})` }} aria-hidden="true" />{engine === 'claude' ? 'Claude' : 'Codex'}
      <span className="tnum">{shown.length ? shown.map((window) => `${SHORT[window.label]} ${Math.round(window.usedPercent)}%`).join(' · ') : '—'}</span>
    </button>;
  })}</>;
}

/** The one global status layer: every channel's state, the project, today's usage, alerts and the host. */
export function StatusBar() {
  const { sessions, rootDirectory, persistenceStatus } = useWorkspaceStore();
  const usage = useHubStore((state) => state.usage);
  const today = todayTotals(usage);
  const alerts = channelAlerts(sessions, usage);
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'no project';
  const jump = jumpToChannel;
  return <footer className="app-statusbar tr-statusbar">
    {sessions.map((session, index) => {
      const record = usageFor(session, usage); const state = channelState(session, record); const meta = CHANNEL_STATES[state];
      const color = meta.color === 'engine' ? `var(--tr-ch-${session.config.engine})` : meta.color;
      return <button key={session.id} className="tr-sb-cell tr-sb-channel" title={`${channelNameNow(session)}: ${meta.word.toLowerCase()}${session.attention ? ` · ${session.attention.message}` : ''}`} onClick={() => jump(session.id)}>
        <i className="tr-engine-square" style={{ background: `var(--tr-ch-${session.config.engine})` }} aria-hidden="true" />CH{index + 1}
        <span style={{ color }}><span aria-hidden="true">{meta.glyph}</span> {meta.word.toLowerCase()}</span>
        {record && <span className="tnum" title={`New tokens (input outside the cache, plus output); ${compact(record.cached)} cache reads not counted`}>{compact(tokens(record))} tok</span>}
      </button>;
    })}
    <span className="tr-sb-cell tr-sb-project" title={rootDirectory ?? undefined}><span className="tr-sb-text">{project}</span></span>
    <span className="tr-spacer" />
    <PlanLimitCells />
    <span className="tr-sb-cell tnum" title="New tokens reported today on this computer: input outside the cache, plus output">Σ today {compact(today.tokens)} tok {today.cost === null ? '' : dollars(today.cost)}</span>
    {alerts.length
      ? <button className={`tr-sb-cell tr-sb-alert ${alerts.some((alert) => alert.state === 'failed') ? 'failed' : alerts[0].state}`} onClick={() => jump(alerts[0].sessionId)} title="Go to the first channel that needs you">
        <span aria-hidden="true">{CHANNEL_STATES[alerts[0].state].glyph}</span><span className="tr-sb-text">{alerts.map((alert) => alert.text).join(' · ')}</span>
      </button>
      : <span className="tr-sb-cell tr-sb-quiet">no alerts</span>}
    <span className={`tr-sb-cell storage-status ${persistenceStatus}`} data-testid="persistence-status">
      {persistenceStatus === 'saved' ? 'Workspace saved locally' : persistenceStatus === 'saving' ? 'Saving workspace…' : persistenceStatus === 'error' ? 'Storage needs attention' : persistenceStatus === 'loading' ? 'Loading workspace…' : 'Browser preview'}
    </span>
    <span className="tr-sb-cell tr-sb-host"><i className={window.codingHub ? 'online' : ''} aria-hidden="true" />{window.codingHub ? 'host · local' : 'browser preview'}</span>
  </footer>;
}

export { formatNumber };
