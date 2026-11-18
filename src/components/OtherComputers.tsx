import { useEffect, useState } from 'react';
import { CircleAlert, Monitor, TriangleAlert, X } from 'lucide-react';
import type { LinkedComputer, RemoteStatus } from '../../shared/remote';
import type { ScreenShareStatus } from '../../shared/screen';
import { screen } from '../runtime/screen-channel';
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
  const [share, setShare] = useState<ScreenShareStatus | null>(null);
  const status = () => workbench<RemoteStatus>({ action: 'remote-status' }).then(setRemote).catch(() => {});
  useEffect(() => { void screen<ScreenShareStatus>({ action: 'screen-share-status' }).then(setShare).catch(() => {}); }, []);
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
  const ready = Boolean(remote?.listening && remote.tailscale.serving); const connected = computers.filter((item) => item.connected).length;
  return <article className="storage-card ui-card settings-card other-computers" aria-labelledby="other-computers-title">
    <div className="ui-card-head"><Monitor aria-hidden="true" /><h2 id="other-computers-title">Other computers</h2><span className={`ui-badge dot storage-status ${connected ? 'success saved' : 'neutral'}`}>{connected ? `${connected} connected` : 'None connected'}</span></div>
    <p>Watch, type into, start and stop the channels on your other computers, each in its own tab.</p>
    {/* Who else gets to see these channels stays in view, not behind the help button: it is what linking gives away. */}
    <p className="ui-hint settings-hint-help">They connect over Tailscale, and each link's key stays on this computer.<button type="button" className="ui-help" aria-label="Help: how computers find each other" title="Computers find each other on your tailnet and through the Drive sync folder." /></p>
    <p className="ui-hint">A phone paired with either computer sees the channels of both.</p>
    <label className="ui-check"><input type="checkbox" checked={remote?.autoLink ?? true} disabled={busy || !remote} onChange={(event) => { const enabled = event.target.checked; void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-auto-link', enabled }))); }} />Link my computers automatically</label>
    <p className="ui-hint">Computers signed in to your Tailscale account ({remote?.tailscale.login ?? 'not known yet'}) link without a code when both have this on. Shared and tagged devices still need a code, and a computer you unlink stays unlinked until you link it with a code.</p>
    {!computers.length && <div className="ui-empty"><Monitor aria-hidden="true" /><h3>No other computers yet</h3><p>On each computer, turn on Phone access with Tailscale HTTPS; computers on your Tailscale account appear here within a minute.</p></div>}
    {computers.length > 0 && <ul className="ui-list linked-computers" aria-label="Other computers">{computers.map((computer) => <li key={computer.id} className="ui-row">
      <div className="ui-row-main"><strong>{computer.name}</strong>
      <small>{computer.linked ? (computer.connected ? `Connected · ${computer.channels.length} ${computer.channels.length === 1 ? 'channel' : 'channels'}` : computer.error ?? 'Connecting…') : computer.url ? computer.error ?? 'Not linked' : 'Phone access with Tailscale HTTPS is not set up there yet'}</small></div>
      {computer.linked
        ? <div className="ui-actions"><button className="button secondary small" disabled={!computer.connected} onClick={() => useWorkspaceStore.setState({ computerId: computer.id, activeView: 'computer' })}>Open</button><button className="button danger small" aria-label={`Unlink ${computer.name}`} disabled={busy} onClick={() => void unlink(computer)}><X size={16} />Unlink</button></div>
        : computer.url && <span className="link-code"><input aria-label={`Link code from ${computer.name}`} placeholder="Code from that computer" value={codes[computer.id] ?? ''} maxLength={20} spellCheck={false} autoCapitalize="characters" onChange={(event) => setCodes((current) => ({ ...current, [computer.id]: event.target.value.toUpperCase() }))} onKeyDown={(event) => { if (event.key === 'Enter' && codes[computer.id]) void link(computer); }} /><button className="button primary" disabled={busy || !codes[computer.id]?.trim()} onClick={() => void link(computer)}>Link</button></span>}
    </li>)}</ul>}
    <section className="link-this">
      <h3>Link this computer from another one</h3>
      {!ready ? <p className="ui-hint">Turn on Phone access and set up Tailscale HTTPS above first; the other computer reaches this one the same way your phone does.</p>
        : pairing ? <div className="phone-pairing" role="group" aria-label="Link code">
          <div>
            <p>On the other computer, open Settings → Other computers and enter this code next to this computer’s name:</p>
            <p className="phone-code" aria-label="Link code">{pairing.code.replace(/(.{5})/, '$1 ')}</p>
            <p className="ui-hint">Expires in {left(pairing.expiresAt, now)}. Works once. A computer linked with it can start and stop channels here.</p>
            <button className="quiet-button" disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-cancel-pairing' })))}>Cancel</button>
          </div>
        </div>
        : <button className="button secondary" disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-pair', kind: 'computer' })))}>Show link code</button>}
      {linkedHere.length > 0 && <ul className="ui-list" aria-label="Computers linked to this one">{linkedHere.map((device) => <li key={device.id} className="ui-row">
        <div className="ui-row-main"><strong>{device.name}</strong><small>Can control this computer’s channels · linked {new Date(device.createdAt).toLocaleDateString()}{device.lastSeen ? ` · last seen ${new Date(device.lastSeen).toLocaleString()}` : ''}</small></div>
        <button className="button danger small" aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => void act(async () => setRemote(await workbench<RemoteStatus>({ action: 'remote-revoke', id: device.id })))}><X size={16} />Remove</button>
      </li>)}</ul>}
    </section>
    {share?.supported && <section className="link-this">
      <div className="link-this-head"><h3>Share this screen</h3><button type="button" className="ui-help" aria-label="Help: opening this screen from elsewhere" title="A linked computer opens it with Screen on this computer’s tab, and a paired phone with Screen in its app." /></div>
      <label className="ui-check"><input type="checkbox" checked={share.enabled} disabled={busy || (!ready && !share.enabled)} onChange={(event) => { const enabled = event.target.checked; void act(async () => setShare(await screen<ScreenShareStatus>({ action: 'screen-share-set', enabled }))); }} />Let linked computers see and control this screen</label>
      {share.enabled && <label className="ui-check"><input type="checkbox" checked={share.elevated} disabled={busy} onChange={(event) => { const elevated = event.target.checked; void act(async () => setShare(await screen<ScreenShareStatus>({ action: 'screen-share-set', enabled: true, elevated }))); }} />Also control apps running as administrator</label>}
      <p className="ui-hint">A paired phone can see and control it too, once <strong>Can start and stop agents</strong> is on for it under Phone access.</p>
      <p className="ui-hint">It works while Trace is closed: a small Trace service starts when you sign in to Windows. A Trace icon by the clock shows while someone is watching, with <strong>Disconnect</strong>. This computer must be on, awake and unlocked.</p>
      {share.enabled && <p className="ui-banner warning"><TriangleAlert aria-hidden="true" /><span>{share.elevated ? 'The service runs as administrator every time you sign in, without asking (a scheduled task starts it). Anyone viewing this screen also controls apps running as administrator. Trace is installed in a folder your account can change, so any program running as you could put its own code there and get administrator rights without Windows asking. Windows prompts and the lock screen still cannot be controlled. Turning this off asks Windows’ permission again to remove the task.' : 'Windows lets only a program running as administrator control apps that run as administrator. Turning this on asks Windows’ permission once (an administrator account is needed). The cost: the service then runs as administrator at every sign-in without asking, from a folder your account can change, so any program running as you could get administrator rights without Windows asking; and anyone viewing this screen controls apps running as administrator.'}</span></p>}
      {share.enabled && <p className="ui-hint">{share.running ? 'Sharing: the service is running.' : 'The service is not running. Turn this off and on again.'}</p>}
      {!ready && !share.enabled && <p className="ui-hint">Set up Phone access with Tailscale HTTPS above first.</p>}
    </section>}
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
  </article>;
}
