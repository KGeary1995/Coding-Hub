import { Check, ChevronDown, CircleAlert, RefreshCw, TerminalSquare } from 'lucide-react';
import { ENGINE_ICONS } from './tile/engine-icons';
import { useWorkspaceStore } from '../state/workspace-store';
import { refreshEngines } from '../runtime/use-native-host';

export function EngineHealth({ detailed = false }: { detailed?: boolean }) {
  const { engines, discovering, discoveryError, sessions } = useWorkspaceStore();
  const active = sessions.filter((session) => session.status === 'running').length;
  return <section className={`ui-card engine-health ${detailed ? 'detailed' : ''}`} aria-label="Local CLI health">
    <div className="ui-card-head"><TerminalSquare aria-hidden="true" /><h3>Local engines</h3><span className={`ui-badge dot ${active ? 'success' : 'neutral'}`}>{active} running</span><div className="ui-card-actions"><button className="button secondary small" onClick={() => useWorkspaceStore.getState().setView('accounts')}>Connect accounts</button><button className="icon-button small" aria-label="Refresh CLI detection" title="Refresh installed CLI detection" disabled={discovering || !window.codingHub} onClick={() => void refreshEngines()}><RefreshCw size={14} className={discovering ? 'spin' : ''} /></button></div></div>
    <div className="engine-health-items">{(['claude', 'codex'] as const).map((engine) => {
      const info = engines.find((item) => item.engine === engine); const Glyph = ENGINE_ICONS[engine];
      return <details key={engine} className={`engine-health-item ${info?.available ? 'available' : ''}`}><summary className="ui-row"><span className={`ui-avatar engine-glyph ${engine}`} aria-hidden="true"><Glyph /></span><span className="ui-row-main"><strong>{engine === 'claude' ? 'Claude Code' : 'Codex CLI'}</strong><small className="engine-detection">{discovering ? 'Checking' : !window.codingHub ? 'Desktop required' : info?.available ? info.version : 'Not detected'}</small></span>{info?.available ? <Check className="engine-ok" size={16} aria-hidden="true" /> : <CircleAlert className="engine-missing" size={16} aria-hidden="true" />}<ChevronDown size={16} aria-hidden="true" /></summary><div className="engine-diagnostic">{info?.executable && <code>{info.executable}</code>}<p className={info?.error ? 'error-message' : undefined}>{info?.error ?? (info?.available ? 'CLI discovered. Authentication and model access are managed by your local CLI.' : 'Start Trace from a terminal where this CLI is installed and signed in.')}</p>{info?.available && <>
        <p className={info.authentication?.state === 'not-authenticated' ? 'error-message' : 'muted'}><strong>Authentication: {info.authentication?.state ?? 'unknown'}</strong><br />{info.authentication?.message ?? 'The CLI manages authentication when it starts.'}</p>
        <dl className="engine-capabilities"><dt>Model flag</dt><dd>{info.supportsModel ? 'Supported' : 'Use CLI default'}</dd><dt>Config overrides</dt><dd>{info.supportsConfig ? 'Supported' : 'Not advertised'}</dd>{engine === 'claude' && <><dt>Session ID / usage limit</dt><dd>{info.supportsSessionId ? 'Supported' : 'Not advertised'}</dd></>}</dl>
        {info.checkedAt && <small className="muted">Checked {new Date(info.checkedAt).toLocaleString()}</small>}
        <p className="control-note">A local login does not verify subscription, model availability, or provider access. Launch validates your exact settings against fresh CLI discovery.</p>
      </>}</div></details>;
    })}</div>
    {discoveryError && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{discoveryError}</span></p>}
  </section>;
}

