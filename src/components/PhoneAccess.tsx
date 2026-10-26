import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Smartphone, X } from 'lucide-react';
import type { RemoteRequest, RemoteStatus, ServeProblem } from '../../shared/remote';
import { workbench } from '../runtime/workbench';

/** A QR code drawn as SVG cells, dark on light so phone cameras read it in either theme. */
function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => { const code = qrcode(0, 'M'); code.addData(text); code.make(); const size = code.getModuleCount(); const dark: string[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) dark.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return { size: size + 8, path: dark.join('') }; }, [text]);
  return <svg className="phone-qr" role="img" aria-label={label} viewBox={`0 0 ${cells.size} ${cells.size}`} shapeRendering="crispEdges"><rect width={cells.size} height={cells.size} fill="#fff" /><path d={cells.path} fill="#000" /></svg>;
}

/** Steps for what stopped Tailscale HTTPS. Trace retries by itself when the person comes back from Tailscale's page. */
function ServeGuide({ problem, busy, open, retry }: { problem: ServeProblem; busy: boolean; open: () => void; retry: () => void }) {
  const openButton = (label: string) => <button className="button secondary" disabled={busy} onClick={open}>{label}</button>;
  return <div className="phone-guide" role="group" aria-label="Finish Tailscale HTTPS">
    <p role="alert">{problem.message}</p>
    {problem.kind === 'certificates' ? <ol>
      <li>Open the DNS page of the Tailscale admin console. {problem.link && openButton('Open Tailscale DNS settings')}</li>
      <li>If MagicDNS is off, click <strong>Enable MagicDNS</strong>.</li>
      <li>Under <strong>HTTPS Certificates</strong>, click <strong>Enable HTTPS</strong>.</li>
      <li>Come back to Trace. It tries again on its own.</li>
    </ol> : problem.kind === 'approve' ? <ol>
      <li>Approve HTTPS (Serve) on the Tailscale page. {problem.link && openButton('Open approval page')}</li>
      <li>Come back to Trace. It tries again on its own.</li>
    </ol> : null}
    <button className="button primary" disabled={busy} onClick={retry}>{busy ? 'Trying…' : 'Try again'}</button>
  </div>;
}

const left = (iso: string, now: number) => { const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/** Settings card for the phone remote: on/off, the Tailscale route to it, pairing by QR code, and paired phones. */
export function PhoneAccessCard() {
  const [status, setStatus] = useState<RemoteStatus | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const working = useRef(false);
  const run = async (request: RemoteRequest) => { working.current = true; setBusy(true); setError(''); try { setStatus(await workbench<RemoteStatus>(request)); } catch (e) { setError((e as Error).message); void workbench<RemoteStatus>({ action: 'remote-status' }).then(setStatus).catch(() => {}); } finally { working.current = false; setBusy(false); } };
  useEffect(() => { void run({ action: 'remote-status' }); }, []);
  // While a code is showing, count down, and refresh so a successful pairing appears in the list.
  useEffect(() => {
    if (!status?.pairing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void workbench<RemoteStatus>({ action: 'remote-status' }).then(setStatus).catch(() => {}); }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [status?.pairing?.code]);
  // While Tailscale setup is unfinished, keep checking (and on return to the window) so installing or signing in moves to the next step.
  const settingUp = !!status?.enabled && !(status.tailscale.running && status.tailscale.serving);
  useEffect(() => {
    if (!settingUp) return;
    const refresh = () => { void workbench<RemoteStatus>({ action: 'remote-status' }).then(setStatus).catch(() => {}); };
    const poll = setInterval(refresh, 5000); window.addEventListener('focus', refresh);
    return () => { clearInterval(poll); window.removeEventListener('focus', refresh); };
  }, [settingUp]);
  // After a Tailscale settings page is opened, coming back to Trace tries HTTPS again without another click.
  const fixable = status?.serveProblem && ['certificates', 'approve'].includes(status.serveProblem.kind) && !status.tailscale.serving;
  useEffect(() => {
    if (!fixable) return;
    const retry = () => { if (!working.current) void run({ action: 'remote-serve', automatic: true }); };
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [fixable]);
  if (!status) return error ? <p role="alert" className="error-message">{error}</p> : null;
  const { tailscale } = status; const ready = status.listening && tailscale.serving && !tailscale.funnel;
  // Computers linked to this one, and codes for linking one, belong to the Other computers card.
  const phones = status.devices.filter((device) => device.kind === 'phone'); const pairing = status.pairing?.kind === 'phone' ? status.pairing : null;
  return <article className="storage-card phone-access" aria-labelledby="phone-access-title">
    <header><h2 id="phone-access-title"><Smartphone size={16} aria-hidden="true" />Phone access</h2><span className={`storage-status ${ready ? 'saved' : ''}`}>{!status.enabled ? 'Off' : ready ? 'Ready' : status.listening ? 'Needs Tailscale' : 'Not running'}</span></header>
    <p>Read and type into running channels from your phone, including answering approval prompts, and get an alert when one needs you. Your phone reaches this computer through Tailscale, a private network for your own devices; nothing is opened to the internet. Each phone must also be paired here, and can be removed at any time.</p>
    <label className="update-checkbox"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={(event) => { const enabled = event.target.checked; setStatus({ ...status, enabled }); void run({ action: 'remote-enable', enabled }); }} />Allow paired phones to read and type into channels</label>
    {status.error && <p role="alert" className="error-message">{status.error}</p>}
    {status.enabled && <>
      <ol className="phone-steps">
        <li className={tailscale.installed && tailscale.running ? 'done' : ''}><strong>Tailscale on this computer and your phone.</strong>{' '}
          {!tailscale.installed ? 'Install Tailscale from tailscale.com/download on both, and sign in with the same account.' : !tailscale.running ? (tailscale.error ?? 'Open Tailscale and sign in.') : <>Connected as <code>{tailscale.host}</code>. Install Tailscale on your phone with the same account.</>}</li>
        <li className={tailscale.serving ? 'done' : ''}><strong>HTTPS on your tailnet.</strong>{' '}
          {tailscale.serving ? <>Your phone opens <code>{status.url}</code>.</> : status.serveProblem
            ? <ServeGuide problem={status.serveProblem} busy={busy} open={() => void run({ action: 'remote-open-tailscale' })} retry={() => void run({ action: 'remote-serve' })} />
            : <>Trace asks Tailscale to pass HTTPS on your tailnet to this computer’s phone page. <button className="button secondary" disabled={busy || !tailscale.running} onClick={() => void run({ action: 'remote-serve' })}>Set up Tailscale HTTPS</button></>}</li>
        <li className={phones.length ? 'done' : ''}><strong>Pair your phone.</strong>{' '}
          {pairing ? null : <button className="button primary" disabled={busy || !status.listening} onClick={() => void run({ action: 'remote-pair' })}>Pair a phone</button>}</li>
      </ol>
      {tailscale.funnel && <p role="alert" className="error-message">Tailscale Funnel is on for this address, which would put it on the public internet. Trace refuses Funnel requests; turn Funnel off with “tailscale funnel reset”.</p>}
      {pairing && <div className="phone-pairing" role="group" aria-label="Pairing code">
        <QrCode text={pairing.url} label="QR code that opens the pairing page on your phone" />
        <div>
          <p>Scan with your phone’s camera, or open {status.url ? <code>{status.url}</code> : 'the phone page'} and enter:</p>
          <p className="phone-code" aria-label="Pairing code">{pairing.code.replace(/(.{5})/, '$1 ')}</p>
          <p className="control-note">Expires in {left(pairing.expiresAt, now)}. Works once.</p>
          <button className="quiet-button" disabled={busy} onClick={() => void run({ action: 'remote-cancel-pairing' })}>Cancel</button>
          {!tailscale.serving && <p className="control-note">Until Tailscale HTTPS is set up, this code only works from a browser on this computer.</p>}
        </div>
      </div>}
      {phones.length > 0 && <ul className="hub-list phone-devices" aria-label="Paired phones">{phones.map((device) => <li key={device.id} className="extension-row">
        <strong>{device.name}</strong><span className="muted">Paired {new Date(device.createdAt).toLocaleDateString()} · {device.lastSeen ? `last used ${new Date(device.lastSeen).toLocaleString()}` : 'not used yet'} · {device.notifications ? 'alerts on' : 'alerts off'}</span>
        {device.notifications && <button className="quiet-button" disabled={busy} onClick={() => void run({ action: 'remote-test-alert', id: device.id })}>Send test alert</button>}
        <button className="quiet-button" aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => void run({ action: 'remote-revoke', id: device.id })}><X size={14} />Remove</button>
      </li>)}</ul>}
    </>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </article>;
}
