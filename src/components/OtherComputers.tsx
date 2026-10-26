import { useEffect, useState } from 'react';
import { Monitor, X } from 'lucide-react';
import type { LinkedComputer, RemoteStatus } from '../../shared/remote';
import { workbench } from '../runtime/workbench';
import { refreshLinked } from '../runtime/linked-terminals';
import { useLinkedStore } from '../state/linked-store';
import { useWorkspaceStore } from '../state/workspace-store';

const left = (iso: string, now: number) => { const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/**
 * Settings card for the person's other computers: the ones found through the Drive sync folder, linking one with the
 * code it shows, and a code for linking this one from elsewhere. Linked computers can watch, type into, start and stop
 * each other's channels; each gets a tab, and phones paired with either see both.
 */
export function OtherComputersCard() {
  const computers = useLinkedStore((state) => state.computers);
  const [remote, setRemote] = useState<RemoteStatus | null>(null); const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const status = () => workbench<RemoteStatus>({ action: 'remote-status' }).then(setRemote).catch(() => {});
  useEffect(() => { void status(); void refreshLinked(); const poll = setInterval(() => { void refreshLinked(); }, 10000); return () => clearInterval(poll); }, []);
  const pairing = remote?.pairing?.kind === 'computer' ? remote.pairing : null;
  // While this computer's code shows, count down and watch for the other computer to use it.
  useEffect(() => {
    if (!pairing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000); const poll = setInterval(() => void status(), 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [pairing?.code]);
  async function act<T>(work: () => Promise<T>) { setBusy(true); setError(''); try { return await work(); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); } }
  const link = (computer: LinkedComputer) => act(async () => { useLinkedStore.setState({ computers: await workbench<LinkedComputer[]>({ action: 'linked-link', id: computer.id, code: codes[computer.id] ?? '' }) }); setCodes((current) => ({ ...current, [computer.id]: '' })); });
  const unlink = (computer: LinkedComputer) => act(async () => { useLinkedStore.setState({ computers: await workbench<LinkedComputer[]>({ action: 'linked-unlink', id: computer.id }) }); });
  const linkedHere = remote?.devices.filter((device) => device.kind === 'computer') ?? [];
  const ready = Boolean(remote?.listening && remote.tailscale.serving);
  return <article className="storage-card other-computers" aria-labelledby="other-computers-title">
    <header><h2 id="other-computers-title"><Monitor size={16} aria-hidden="true" />Other computers</h2><span className={`storage-status ${computers.some((item) => item.connected) ? 'saved' : ''}`}>{computers.filter((item) => item.connected).length ? `${computers.filter((item) => item.connected).length} connected` : 'None connected'}</span></header>
    <p>Watch, type into, start and stop the channels running on your other computers, each in its own tab, and see all of them on your phone through either computer. Computers find each other through the Drive sync folder and connect over Tailscale; each link needs a one-time code from the other computer, and its key stays on this computer.</p>
    {!computers.length && <p className="control-note">No other computers yet. On each computer, turn on <strong>Sync between computers</strong> (same Drive folder) and <strong>Phone access</strong> with Tailscale HTTPS; they appear here within a minute.</p>}
    {computers.length > 0 && <ul className="hub-list linked-computers" aria-label="Other computers">{computers.map((computer) => <li key={computer.id} className="extension-row">
      <strong>{computer.name}</strong>
      <span className="muted">{computer.linked ? (computer.connected ? `Connected · ${computer.channels.length} ${computer.channels.length === 1 ? 'channel' : 'channels'}` : computer.error ?? 'Connecting…') : computer.url ? 'Not linked' : 'Phone access with Tailscale HTTPS is not set up there yet'}</span>
      {computer.linked
        ? <><button className="quiet-button" disabled={!computer.connected} onClick={() => useWorkspaceStore.setState({ computerId: computer.id, activeView: 'computer' })}>Open</button><button className="quiet-button" aria-label={`Unlink ${computer.name}`} disabled={busy} onClick={() => void unlink(computer)}><X size={14} />Unlink</button></>
        : computer.url && <span className="link-code"><input aria-label={`Link code from ${computer.name}`} placeholder="Code from that computer" value={codes[computer.id] ?? ''} maxLength={20} spellCheck={false} autoCapitalize="characters" onChange={(event) => setCodes((current) => ({ ...current, [computer.id]: event.target.value.toUpperCase() }))} onKeyDown={(event) => { if (event.key === 'Enter' && codes[computer.id]) void link(computer); }} /><button className="button primary" disabled={busy || !codes[computer.id]?.trim()} onClick={() => void link(computer)}>Link</button></span>}
    </li>)}</ul>}
    <div className="link-this">
      <h3>Link this computer from another one</h3>
      {!ready ? <p className="control-note">Turn on Phone access and set up Tailscale HTTPS above first; the other computer reaches this one the same way your phone does.</p>
        : pairing ? <div className="phone-pairing" role="group" aria-label="Link code">
          <div>
            <p>On the other computer, open Settings → Other computers and enter this code next to this computer’s name:</p>
            <p className="phone-code" aria-label="Link code">{pairing.code.replace(/(.{5})/, '$1 ')}</p>
            <p className="control-note">Expires in {left(pairing.expiresAt, now)}. Works once. A computer linked with it can start and stop channels here.</p>
            <button className="quiet-button" disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-cancel-pairing' })))}>Cancel</button>
          </div>
        </div>
        : <button className="button secondary" disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-pair', kind: 'computer' })))}>Show link code</button>}
      {linkedHere.length > 0 && <ul className="hub-list" aria-label="Computers linked to this one">{linkedHere.map((device) => <li key={device.id} className="extension-row">
        <strong>{device.name}</strong><span className="muted">Can control this computer’s channels · linked {new Date(device.createdAt).toLocaleDateString()}{device.lastSeen ? ` · last seen ${new Date(device.lastSeen).toLocaleString()}` : ''}</span>
        <button className="quiet-button" aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-revoke', id: device.id })))}><X size={14} />Remove</button>
      </li>)}</ul>}
    </div>
    {error && <p role="alert" className="error-message">{error}</p>}
  </article>;
}
