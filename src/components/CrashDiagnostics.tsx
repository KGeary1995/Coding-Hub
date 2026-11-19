import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { HostHealthReport } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
/** One stall as the host keeps it (StallRecord). Optional in the report: an older host sends none. */
export type Stall = NonNullable<HostHealthReport['stalls']>[number];
const SIDES: Record<Stall['side'], string> = { main: 'Main process', window: 'Window', gpu: 'GPU' };
/** Newest first, one line each: when, which side, what, how long and the job's label when known. */
export function stallLines(stalls: Stall[] | undefined): string[] {
  return [...stalls ?? []].reverse().map((stall) => [new Date(stall.time).toLocaleString(), SIDES[stall.side] ?? stall.side, stall.kind, ...(stall.ms === null ? [] : [`${stall.ms} ms`]), ...(stall.job ? [stall.job] : [])].join(' · '));
}
/** Stalls are kept apart from the lifecycle events, so they are listed on their own below them; nothing when there are none. */
export function StallList({ stalls }: { stalls: Stall[] | undefined }) {
  const lines = stallLines(stalls); if (!lines.length) return null;
  return <><p className="ui-hint">Stalls, newest first: times when the main process, the window or the GPU stopped answering for a while.</p><pre className="check-output" aria-label="Stalls">{lines.join('\n')}</pre></>;
}
export function CrashDiagnostics({ storagePath }: { storagePath?: string }) {
  const [report, setReport] = useState<HostHealthReport | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(''); try { setReport(await workbench<HostHealthReport>({ action: 'host-health' })); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }
  return <details className="workflow-record settings-details" onToggle={(event) => { if (event.currentTarget.open && !report && !busy) void refresh(); }}>
    <summary>Application stability & crash diagnostics</summary>
    <p className="ui-hint">Lifecycle records help distinguish an application crash from a normal CLI exit. They exclude prompts, terminal output, account details and raw exception messages.</p>
    {busy && !report && <p className="ui-hint">Reading the lifecycle records…</p>}
    {report && <><p className="ui-hint">Previous application shutdown: <strong>{report.previousShutdown}</strong>{report.previousShutdown === 'unclean' && ' · This can mean a crash, force quit or power loss; it does not identify the cause.'}</p><pre className="check-output" aria-label="Application lifecycle report">{JSON.stringify({ previousShutdown: report.previousShutdown, events: report.events }, null, 2)}</pre><StallList stalls={report.stalls} /></>}
    <div className="ui-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh crash diagnostics</button></div>
    <p className="ui-hint">Native crash dumps stay under {storagePath ? <code>{storagePath}/crash-dumps</code> : 'the local data folder'} and are never uploaded automatically. Dumps may contain process memory; they are excluded from shared memory, support exports and backups.</p>
    {error && <p className="ui-banner danger" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
  </details>;
}
