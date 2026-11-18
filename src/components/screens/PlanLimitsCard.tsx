import { Gauge, Info, RefreshCw } from 'lucide-react';
import { limitLevel, refreshPlanLimits, resetText, usePlanLimits } from '../../state/plan-limits-store';

/** A limit's meter colour: green with room, amber near it, red at it (plan-limits-store's levels). */
const TONE = { ok: 'success', warning: 'warning', critical: 'danger' } as const;

/** Every account's subscription limits, as meters: Claude's session and weekly limits, and Codex's. */
export function PlanLimitsCard() {
  const { limits, loading } = usePlanLimits();
  return <section className="ui-card tr-plan-limits" aria-labelledby="plan-limits-title">
    <div className="ui-card-head"><Gauge aria-hidden="true" /><h2 id="plan-limits-title">Plan limits</h2><span className="tr-plan-meta">From each CLI · no tokens used{limits[0] ? ` · checked ${new Date(limits[0].checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
      <div className="ui-card-actions"><button className="button secondary small" onClick={() => void refreshPlanLimits(true)} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} />Check now</button></div></div>
    {!limits.length && (loading ? <p className="tr-plan-meta tr-plan-checking"><RefreshCw className="spin" aria-hidden="true" />Checking…</p> : <div className="ui-empty"><Gauge aria-hidden="true" /><h3>No limits to show</h3><p>No Claude Code or Codex found to check.</p></div>)}
    <div className="tr-plan-accounts">{limits.map((item) => <div key={`${item.engine}-${item.account}`} className="tr-plan-account">
      <h3><i className={`tr-engine-square ${item.engine}`} aria-hidden="true" />{item.engine === 'claude' ? 'Claude' : 'Codex'}{item.account !== 'Default' ? ` · ${item.account}` : item.signedInAs ? ` · ${item.signedInAs}` : ''}{item.plan ? <span className="ui-badge neutral">{item.plan}</span> : null}</h3>
      {item.error ? <p className="ui-banner info"><Info aria-hidden="true" /><span>{item.error}</span></p> : item.windows.map((window, index) => <div key={`${index}:${window.label}`} className={`tr-plan-window ${limitLevel(window.usedPercent)}`}>
        <span className="tr-plan-label">{window.label}</span>
        <span className={`ui-meter ${TONE[limitLevel(window.usedPercent)]}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-label={`${window.label} used`}><i style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></span>
        <span className="tnum">{Math.round(window.usedPercent)}%</span>
        <span className="tr-plan-meta">{resetText(window) ? `resets ${resetText(window)}` : ''}</span>
      </div>)}
    </div>)}</div>
  </section>;
}
