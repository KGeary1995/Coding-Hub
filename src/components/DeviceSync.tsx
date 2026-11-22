import { useEffect, useState } from 'react';
import { CircleAlert, MonitorSmartphone, RefreshCw } from 'lucide-react';
import type { DeviceSyncStatus, SyncedComputer, SyncedDocument } from '../../shared/hub';
import type { LinkedComputer } from '../../shared/remote';
import { useLinkedStore } from '../state/linked-store';
import { hubCall, useHubStore } from '../state/hub-store';
import { refreshSynced } from '../runtime/use-native-host';

const DOCUMENT_LABEL: Record<SyncedDocument, string> = { settings: 'Settings', rules: 'Shared rules' };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Status of the sync between computers: which computers share the Drive folder, the last sync, and conflicts to settle. */
/**
 * Computers this one reaches over Tailscale (or has linked) that have never written to this sync folder: most often the
 * two use different Drive folders, which otherwise only shows as "None seen yet". Checked only after a sync has run.
 */
export function outsideSyncFolder(linked: LinkedComputer[], status: Pick<DeviceSyncStatus, 'enabled' | 'connected' | 'lastSync' | 'machine'> & { computers: SyncedComputer[] }): LinkedComputer[] {
  if (!status.enabled || !status.connected || !status.lastSync) return [];
  const synced = new Set(status.computers.map((item) => item.id));
  return linked.filter((item) => item.id !== status.machine.id && !synced.has(item.id) && (item.linked || item.url !== null));
}

export function DeviceSyncCard() {
  const [status, setStatus] = useState<DeviceSyncStatus | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const linked = useLinkedStore((state) => state.computers);
  const run = async (request: Parameters<typeof hubCall>[0]) => {
    setBusy(true); setError('');
    try { setStatus(await hubCall<DeviceSyncStatus>(request)); await refreshSynced(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  /** Joins the computers that sync through another Drive folder: this computer's Drive folder becomes theirs, and a sync runs at once. */
  const useFolder = async (directory: string) => {
    setBusy(true); setError('');
    try {
      const preferences = { ...useHubStore.getState().preferences, driveDirectory: directory };
      await hubCall({ action: 'save-preferences', preferences }); useHubStore.getState().setPreferences(preferences);
      setStatus(await hubCall<DeviceSyncStatus>({ action: 'device-sync-now' })); await refreshSynced();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  // The sync also runs in the background every 30 seconds; follow it so connection, conflicts and errors stay current.
  useEffect(() => {
    const load = () => void hubCall<DeviceSyncStatus>({ action: 'device-sync-status' }).then(setStatus).catch((e) => setError(e.message));
    load(); const timer = setInterval(load, 15000); return () => clearInterval(timer);
  }, []);
  const head = (state: string, tone: string) => <div className="ui-card-head"><MonitorSmartphone aria-hidden="true" /><h3 id="device-sync-title">Sync between computers</h3>
    <span className={`ui-badge dot storage-status ${tone}`}>{state}</span></div>;
  // Before the first answer the card is already there, so the Sync section is never a heading over nothing.
  if (!status) return <article className="storage-card ui-card settings-card device-sync" aria-labelledby="device-sync-title">{error ? <>{head('Unavailable', 'danger')}<p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p></> : <>{head('Checking', 'neutral')}<p className="ui-hint">Checking sync…</p></>}</article>;
  const outside = outsideSyncFolder(linked, status);
  return <article className="storage-card ui-card settings-card device-sync" aria-labelledby="device-sync-title">
    {head(!status.enabled ? 'Off' : status.connected ? 'On' : 'Drive folder unavailable', status.enabled && status.connected ? 'saved success' : status.enabled ? 'warning' : 'neutral')}
    <p>Settings, shared rules, project templates and usage history follow you through the Drive folder above. Running channels, recorded output and the project list stay on each computer.</p>
    {status.enabled && <>
      <dl className="settings-facts">
        <dt>This computer</dt><dd>{status.machine.name}</dd>
        <dt>Other computers</dt><dd>{status.computers.length ? status.computers.map((item) => `${item.name} (${when(item.updatedAt)})`).join(', ') : 'None seen yet'}</dd>
        <dt>Last sync</dt><dd>{status.lastSync ? when(status.lastSync) : 'Not yet'}</dd>
      </dl>
      {status.conflicts.map((conflict) => <div key={conflict.document} className="ui-banner warning device-sync-conflict" role="group" aria-label={`${DOCUMENT_LABEL[conflict.document]} conflict`}>
        <p><strong>{DOCUMENT_LABEL[conflict.document]} changed here and on {conflict.from}.</strong> Nothing was overwritten. Choose which version both computers keep.</p>
        <div className="ui-actions">
          <button className="button secondary" disabled={busy} onClick={() => void run({ action: 'device-sync-resolve', document: conflict.document, keep: 'local' })}>Keep this computer’s</button>
          <button className="button secondary" disabled={busy} onClick={() => void run({ action: 'device-sync-resolve', document: conflict.document, keep: 'remote' })}>Use {conflict.from}’s</button>
        </div>
      </div>)}
      {status.joined && <div className="ui-banner device-sync-conflict" role="status">
        <p><strong>Trace moved this computer’s sync to <code>{status.joined.directory}</code></strong> on {when(status.joined.at)}, to join {status.joined.computers.join(', ')}. It used <code>{status.joined.from || 'no folder'}</code> before; nothing was removed there.</p>
        {status.joined.from && <div className="ui-actions"><button className="button secondary small" disabled={busy} onClick={() => void useFolder(status.joined!.from)}>Move back</button></div>}
      </div>}
      {status.elsewhere && <div className="ui-banner warning device-sync-conflict" role="alert">
        <p><strong>{status.elsewhere.computers.join(', ')} {status.elsewhere.computers.length === 1 ? 'syncs' : 'sync'} through another Drive folder</strong> (<code>{status.elsewhere.directory}</code>), so usage, settings, rules and memory notes do not pass between {status.elsewhere.computers.length === 1 ? 'it' : 'them'} and this computer. {status.elsewhere.switchHere ? 'Use that folder here to join them; this computer’s notes and usage are added to it.' : `Trace on ${status.elsewhere.computers.length === 1 ? 'that computer' : 'those computers'} moves to this folder by itself once it is updated and open; or use that folder here.`}</p>
        <div className="ui-actions"><button className={`button ${status.elsewhere.switchHere ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => void useFolder(status.elsewhere!.directory)}>{status.elsewhere.switchHere ? 'Use the same folder' : 'Use that folder here'}</button></div>
      </div>}
      {outside.length > 0 && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{outside.map((item) => item.name).join(', ')} {outside.length === 1 ? 'is' : 'are'} on your tailnet but not in this sync folder. Check that sync is on there and that both computers use the same Google Drive folder.</span></p>}
      {status.error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{status.error}</span></p>}
      <div className="ui-actions"><button className="button secondary" disabled={busy} onClick={() => void run({ action: 'device-sync-now' })}><RefreshCw size={14} />Sync now</button></div>
    </>}
    {!status.enabled && <p className="ui-hint">Turn on “Sync settings, rules, templates and usage between computers” above and save. Do the same on each computer, with the same Drive folder.</p>}
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
  </article>;
}
