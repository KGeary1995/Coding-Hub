import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Smartphone, X } from 'lucide-react';
import type { RemoteRequest, RemoteStatus } from '../../shared/remote';
import { workbench } from '../runtime/workbench';

/** A QR code drawn as SVG cells, dark on light so phone cameras read it in either theme. */
function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => { const code = qrcode(0, 'M'); code.addData(text); code.make(); const size = code.getModuleCount(); const dark: string[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) dark.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return { size: size + 8, path: dark.join('') }; }, [text]);
  return <svg className="phone-qr" role="img" aria-label={label} viewBox={`0 0 ${cells.size} ${cells.size}`} shapeRendering="crispEdges"><rect width={cells.size} height={cells.size} fill="#fff" /><path d={cells.path} fill="#000" /></svg>;
}

const left = (iso: string, now: number) => { const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/** Settings card for the phone remote: on/off, the Tailscale route to it, pairing by QR code, and paired phones. */
export function PhoneAccessCard() {
  const [status, setStatus] = useState<RemoteStatus | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const run = async (request: RemoteRequest) => { setBusy(true); setError(''); try { setStatus(await workbench<RemoteStatus>(request)); } catch (e) { setError((e as Error).message); void workbench<RemoteStatus>({ action: 'remote-status' }).then(setStatus).catch(() => {}); } finally { setBusy(false); } };
  useEffect(() => { void run({ action: 'remote-status' }); }, []);
  // While a code is showing, count down, and refresh so a successful pairing appears in the list.
  useEffect(() => {
    if (!status?.pairing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void workbench<RemoteStatus>({ action: 'remote-status' }).then(setStatus).catch(() => {}); }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [status?.pairing?.code]);
  if (!status) return error ? <p role="alert" className="error-message">{error}</p> : null;
  const { tailscale } = status; const ready = status.listening && tailscale.serving && !tailscale.funnel;
  return <article className="storage-card phone-access" aria-labelledby="phone-access-title">
    <header><h2 id="phone-access-title"><Smartphone size={16} aria-hidden="true" />Phone access</h2><span className={`storage-status ${ready ? 'saved' : ''}`}>{!status.enabled ? 'Off' : ready ? 'Ready' : status.listening ? 'Needs Tailscale' : 'Not running'}</span></header>
    <p>Read and type into running channels from your phone, including answering approval prompts. Your phone reaches this computer through Tailscale, a private network for your own devices; nothing is opened to the internet. Each phone must also be paired here, and can be removed at any time.</p>
    <label className="update-checkbox"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={(event) => { const enabled = event.target.checked; setStatus({ ...status, enabled }); void run({ action: 'remote-enable', enabled }); }} />Allow paired phones to read and type into channels</label>
    {status.error && <p role="alert" className="error-message">{status.error}</p>}
    {status.enabled && <>
      <ol className="phone-steps">
        <li className={tailscale.installed && tailscale.running ? 'done' : ''}><strong>Tailscale on this computer and your phone.</strong>{' '}
          {!tailscale.installed ? 'Install Tailscale from tailscale.com/download on both, and sign in with the same account.' : !tailscale.running ? (tailscale.error ?? 'Open Tailscale and sign in.') : <>Connected as <code>{tailscale.host}</code>. Install Tailscale on your phone with the same account.</>}</li>
        <li className={tailscale.serving ? 'done' : ''}><strong>HTTPS on your tailnet.</strong>{' '}
          {tailscale.serving ? <>Your phone opens <code>{status.url}</code>.</> : <>Trace asks Tailscale to pass HTTPS on your tailnet to this computer’s phone page. <button className="button secondary" disabled={busy || !tailscale.running} onClick={() => void run({ action: 'remote-serve' })}>Set up Tailscale HTTPS</button></>}</li>
        <li className={status.devices.length ? 'done' : ''}><strong>Pair your phone.</strong>{' '}
          {status.pairing ? null : <button className="button primary" disabled={busy || !status.listening} onClick={() => void run({ action: 'remote-pair' })}>Pair a phone</button>}</li>
      </ol>
      {tailscale.funnel && <p role="alert" className="error-message">Tailscale Funnel is on for this address, which would put it on the public internet. Trace refuses Funnel requests; turn Funnel off with “tailscale funnel reset”.</p>}
      {status.pairing && <div className="phone-pairing" role="group" aria-label="Pairing code">
        <QrCode text={status.pairing.url} label="QR code that opens the pairing page on your phone" />
        <div>
          <p>Scan with your phone’s camera, or open {status.url ? <code>{status.url}</code> : 'the phone page'} and enter:</p>
          <p className="phone-code" aria-label="Pairing code">{status.pairing.code.replace(/(.{5})/, '$1 ')}</p>
          <p className="control-note">Expires in {left(status.pairing.expiresAt, now)}. Works once.</p>
          <button className="quiet-button" disabled={busy} onClick={() => void run({ action: 'remote-cancel-pairing' })}>Cancel</button>
          {!tailscale.serving && <p className="control-note">Until Tailscale HTTPS is set up, this code only works from a browser on this computer.</p>}
        </div>
      </div>}
      {status.devices.length > 0 && <ul className="hub-list phone-devices" aria-label="Paired phones">{status.devices.map((device) => <li key={device.id} className="extension-row">
        <strong>{device.name}</strong><span className="muted">Paired {new Date(device.createdAt).toLocaleDateString()} · {device.lastSeen ? `last used ${new Date(device.lastSeen).toLocaleString()}` : 'not used yet'}</span>
        <button className="quiet-button" aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => void run({ action: 'remote-revoke', id: device.id })}><X size={14} />Remove</button>
      </li>)}</ul>}
    </>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </article>;
}
