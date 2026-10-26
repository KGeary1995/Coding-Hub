import { RefreshCw } from 'lucide-react';
import { limitLevel, refreshPlanLimits, resetText, usePlanLimits } from '../../state/plan-limits-store';

/** Every account's subscription limits, as bars: Claude's session and weekly limits, and Codex's. */
export function PlanLimitsCard() {
  const { limits, loading } = usePlanLimits();
  return <section className="tr-plan-limits" aria-labelledby="plan-limits-title">
    <header><h2 id="plan-limits-title">Plan limits</h2><span className="tr-usage-meta">From each CLI · no tokens used{limits[0] ? ` · checked ${new Date(limits[0].checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
      <button className="tr-ghost-button" onClick={() => void refreshPlanLimits(true)} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''} />Check now</button></header>
    {!limits.length && <p className="tr-usage-meta">{loading ? 'Checking…' : 'No Claude Code or Codex found to check.'}</p>}
    <div className="tr-plan-accounts">{limits.map((item) => <div key={`${item.engine}-${item.account}`} className="tr-plan-account">
      <h3><i className="tr-engine-square" style={{ background: `var(--tr-ch-${item.engine})` }} aria-hidden="true" />{item.engine === 'claude' ? 'Claude' : 'Codex'}{item.account !== 'Default' ? ` · ${item.account}` : ''}{item.plan ? <span className="tr-usage-meta"> {item.plan}</span> : null}</h3>
      {item.error ? <p className="tr-usage-meta">{item.error}</p> : item.windows.map((window) => <div key={window.label} className={`tr-plan-window ${limitLevel(window.usedPercent)}`}>
        <span className="tr-plan-label">{window.label}</span>
        <span className="tr-plan-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-label={`${window.label} used`}><i style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></span>
        <span className="tnum">{Math.round(window.usedPercent)}%</span>
        <span className="tr-usage-meta">{resetText(window) ? `resets ${resetText(window)}` : ''}</span>
      </div>)}
    </div>)}</div>
  </section>;
}
