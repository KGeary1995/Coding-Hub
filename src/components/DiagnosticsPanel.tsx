import { useState } from 'react';
import { CircleAlert, Stethoscope } from 'lucide-react';
import type { DiagnosticReport } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { useWorkspaceStore } from '../state/workspace-store';
import { useAccountStore } from '../state/account-store';
const STATES: Record<DiagnosticReport['steps'][number]['state'], string> = { passed: 'success', failed: 'danger', unverified: 'warning' };
export function DiagnosticsPanel() {
  const root = useWorkspaceStore((s) => s.rootDirectory); const profiles = useAccountStore((s) => s.profiles);
  const [engine, setEngine] = useState<'claude' | 'codex'>('codex'); const [profileId, setProfileId] = useState(''); const [report, setReport] = useState<DiagnosticReport | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); setError(''); try { setReport(await workbench<DiagnosticReport>({ action: 'diagnose', engine, directory: root, ...(engine === 'claude' && profileId ? { profileId } : {}) })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <article className="storage-card ui-card settings-card"><div className="ui-card-head"><Stethoscope aria-hidden="true" /><h2>Connection diagnostics</h2></div><p>Check installation, authentication, configuration, directory access, and real terminal handles separately. No prompt or paid completion is sent.</p>
    <div className="ui-actions"><select aria-label="Diagnostic engine" value={engine} onChange={(e) => setEngine(e.target.value as 'claude' | 'codex')}><option value="codex">Codex</option><option value="claude">Claude</option></select>{engine === 'claude' && <select aria-label="Diagnostic Claude profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">Default</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}<button className="button secondary" disabled={busy} onClick={() => void run()}>{busy ? 'Diagnosing…' : 'Run connection diagnostics'}</button></div>
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
    {report && <ul className="ui-list" aria-label="Diagnostic results">{report.steps.map((step) => <li className={`ui-row diagnostic-row ${step.state}`} key={step.name}><div className="ui-row-main"><strong>{step.name}</strong><small>{step.message}</small>{step.state !== 'passed' && <small>{step.recovery}</small>}</div><span className={`ui-badge dot ${STATES[step.state]}`}>{step.state === 'passed' ? 'Passed' : step.state === 'failed' ? 'Failed' : 'Unverified'}</span></li>)}</ul>}</article>;
}
