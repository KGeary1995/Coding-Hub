import { useEffect, useState } from 'react';
import { MonitorSmartphone, RefreshCw } from 'lucide-react';
import type { DeviceSyncStatus, SyncedDocument } from '../../shared/hub';
import { hubCall } from '../state/hub-store';
import { refreshSynced } from '../runtime/use-native-host';

const DOCUMENT_LABEL: Record<SyncedDocument, string> = { settings: 'Settings', rules: 'Shared rules' };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Status of the sync between computers: which computers share the Drive folder, the last sync, and conflicts to settle. */
export function DeviceSyncCard() {
  const [status, setStatus] = useState<DeviceSyncStatus | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const run = async (request: Parameters<typeof hubCall>[0]) => {
    setBusy(true); setError('');
    try { setStatus(await hubCall<DeviceSyncStatus>(request)); await refreshSynced(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void hubCall<DeviceSyncStatus>({ action: 'device-sync-status' }).then(setStatus).catch((e) => setError(e.message)); }, []);
  if (!status) return error ? <p role="alert" className="error-message">{error}</p> : null;
  return <article className="storage-card device-sync" aria-labelledby="device-sync-title">
    <header><h2 id="device-sync-title"><MonitorSmartphone size={16} aria-hidden="true" />Sync between computers</h2>
      <span className={`storage-status ${status.enabled && status.connected ? 'saved' : ''}`}>{!status.enabled ? 'Off' : status.connected ? 'On' : 'Drive folder unavailable'}</span></header>
    <p>Settings, shared rules, project templates and usage history follow you through the Drive folder above. Running sessions, recorded output and the project list stay on each computer.</p>
    {status.enabled && <>
      <dl>
        <dt>This computer</dt><dd>{status.machine.name}</dd>
        <dt>Other computers</dt><dd>{status.computers.length ? status.computers.map((item) => `${item.name} (${when(item.updatedAt)})`).join(', ') : 'None seen yet'}</dd>
        <dt>Last sync</dt><dd>{status.lastSync ? when(status.lastSync) : 'Not yet'}</dd>
      </dl>
      {status.conflicts.map((conflict) => <div key={conflict.document} className="device-sync-conflict" role="group" aria-label={`${DOCUMENT_LABEL[conflict.document]} conflict`}>
        <p><strong>{DOCUMENT_LABEL[conflict.document]} changed here and on {conflict.from}.</strong> Nothing was overwritten. Choose which version both computers keep.</p>
        <div className="hub-toolbar">
          <button className="button secondary" disabled={busy} onClick={() => void run({ action: 'device-sync-resolve', document: conflict.document, keep: 'local' })}>Keep this computer’s</button>
          <button className="button secondary" disabled={busy} onClick={() => void run({ action: 'device-sync-resolve', document: conflict.document, keep: 'remote' })}>Use {conflict.from}’s</button>
        </div>
      </div>)}
      {status.error && <p role="alert" className="error-message">{status.error}</p>}
      <div className="hub-toolbar"><button className="button secondary" disabled={busy || !status.connected} onClick={() => void run({ action: 'device-sync-now' })}><RefreshCw size={14} />Sync now</button></div>
    </>}
    {!status.enabled && <p className="control-note">Turn on “Sync settings, rules, templates and usage between computers” above and save. Do the same on each computer, with the same Drive folder.</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </article>;
}
