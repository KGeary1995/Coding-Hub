import { Check, ChevronDown, CircleAlert, RefreshCw, TerminalSquare, Asterisk } from 'lucide-react';
import { useWorkspaceStore } from '../state/workspace-store';
import { refreshEngines } from '../runtime/use-native-host';

export function EngineHealth({ detailed = false }: { detailed?: boolean }) {
  const { engines, discovering, discoveryError, sessions } = useWorkspaceStore();
  const active = sessions.filter((session) => session.status === 'running').length;
  return <section className={`engine-health ${detailed ? 'detailed' : ''}`} aria-label="Local CLI health">
    <div className="engine-health-title"><TerminalSquare size={14} /><span>LOCAL ENGINES</span><button className="quiet-button" onClick={() => useWorkspaceStore.getState().setView('accounts')}>Connect accounts</button><button className="icon-button" aria-label="Refresh CLI detection" title="Refresh installed CLI detection" disabled={discovering || !window.codingHub} onClick={() => void refreshEngines()}><RefreshCw size={13} className={discovering ? 'spin' : ''} /></button></div>
    <div className="engine-health-items">{(['claude', 'codex'] as const).map((engine) => {
      const info = engines.find((item) => item.engine === engine);
      return <details key={engine} className={`engine-health-item ${info?.available ? 'available' : ''}`}><summary><span className={`engine-glyph ${engine}`}>{engine === 'claude' ? <Asterisk size={15} /> : <TerminalSquare size={14} />}</span><strong>{engine === 'claude' ? 'Claude Code' : 'Codex CLI'}</strong><span className="engine-detection">{discovering ? 'Checking' : !window.codingHub ? 'Desktop required' : info?.available ? info.version : 'Not detected'}</span>{info?.available ? <Check size={13} /> : <CircleAlert size={13} />}<ChevronDown size={11} /></summary><div className="engine-diagnostic">{info?.executable && <code>{info.executable}</code>}<p>{info?.error ?? (info?.available ? 'CLI discovered. Authentication and model access are managed by your local CLI.' : 'Run the Electron app from a terminal where this CLI is installed and authenticated.')}</p>{info?.available && <>
        <p className={info.authentication?.state === 'not-authenticated' ? 'error-message' : 'muted'}><strong>Authentication: {info.authentication?.state ?? 'unknown'}</strong><br />{info.authentication?.message ?? 'The CLI manages authentication when it starts.'}</p>
        <dl className="engine-capabilities"><dt>Model flag</dt><dd>{info.supportsModel ? 'Supported' : 'Use CLI default'}</dd><dt>Config overrides</dt><dd>{info.supportsConfig ? 'Supported' : 'Not advertised'}</dd>{engine === 'claude' && <><dt>Session ID / usage limit</dt><dd>{info.supportsSessionId ? 'Supported' : 'Not advertised'}</dd></>}</dl>
        {info.checkedAt && <small className="muted">Checked {new Date(info.checkedAt).toLocaleString()}</small>}
        <p className="control-note">A local login does not verify subscription, model availability, or provider access. Launch validates your exact settings against fresh CLI discovery.</p>
      </>}</div></details>;
    })}</div>
    <span className="active-process-count"><i className={active ? 'online' : ''} />{active} running</span>
    {discoveryError && <p role="alert" className="error-message">{discoveryError}</p>}
  </section>;
}
