import { useState } from 'react';
import type { HostHealthReport } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
export function CrashDiagnostics({ storagePath }: { storagePath?: string }) {
  const [report, setReport] = useState<HostHealthReport | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(''); try { setReport(await workbench<HostHealthReport>({ action: 'host-health' })); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }
  return <details className="workflow-record" onToggle={(event) => { if (event.currentTarget.open && !report && !busy) void refresh(); }}>
    <summary>Application stability & crash diagnostics</summary>
    <p>Lifecycle records help distinguish an application crash from a normal CLI exit. They exclude prompts, terminal output, account details and raw exception messages.</p>
    {report && <><p>Previous application shutdown: <strong>{report.previousShutdown}</strong>{report.previousShutdown === 'unclean' && ' · This can mean a crash, force quit or power loss; it does not identify the cause.'}</p><pre className="check-output" aria-label="Application lifecycle report">{JSON.stringify(report, null, 2)}</pre></>}
    <button type="button" className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh crash diagnostics</button>
    <p className="control-note">Reports begin with this release. Native crash dumps stay under {storagePath ? <code>{storagePath}/crash-dumps</code> : 'the local data folder'} and are never uploaded automatically. Dumps may contain process memory; they are excluded from shared memory, support exports and backups.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
  </details>;
}
