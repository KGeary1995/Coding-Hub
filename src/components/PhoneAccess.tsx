import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { CircleAlert, Smartphone, X } from 'lucide-react';
import type { RemoteRequest, RemoteStatus, ServeProblem } from '../../shared/remote';
import { workbench } from '../runtime/workbench';
import { HelpTip } from './HelpTip';
import { HowThisWorks } from './HowThisWorks';

/** A QR code drawn as SVG cells, dark on light so phone cameras read it in either theme. */
function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => { const code = qrcode(0, 'M'); code.addData(text); code.make(); const size = code.getModuleCount(); const dark: string[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) dark.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return { size: size + 8, path: dark.join('') }; }, [text]);
  // Literal black on white, not tokens: a QR code needs full contrast to scan, and one that does not scan breaks pairing.
  return <svg className="phone-qr" role="img" aria-label={label} viewBox={`0 0 ${cells.size} ${cells.size}`} shapeRendering="crispEdges"><rect width={cells.size} height={cells.size} fill="#fff" /><path d={cells.path} fill="#000" /></svg>;
}

/** Steps for what stopped Tailscale HTTPS. Trace retries by itself when the person comes back from Tailscale's page. */
function ServeGuide({ problem, busy, open, retry }: { problem: ServeProblem; busy: boolean; open: () => void; retry: () => void }) {
  const openButton = (label: string) => <button className="button secondary small" disabled={busy} onClick={open}>{label}</button>;
  return <div className="phone-guide" role="group" aria-label="Finish Tailscale HTTPS">
    <p role="alert" className="error-message">{problem.message}</p>
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
  const head = (state: string, tone: string) => <div className="ui-card-head"><Smartphone aria-hidden="true" /><h3 id="phone-access-title">Phone access</h3><span className={`ui-badge dot storage-status ${tone}`}>{state}</span></div>;
  if (!status) return <article className="storage-card ui-card settings-card phone-access" aria-labelledby="phone-access-title">{error ? <>{head('Unavailable', 'danger')}<p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p></> : <>{head('Checking', 'neutral')}<p className="ui-hint">Checking phone access…</p></>}</article>;
  const { tailscale } = status; const ready = status.listening && tailscale.serving && !tailscale.funnel;
  // Computers linked to this one, and codes for linking one, belong to the Other computers card.
  const phones = status.devices.filter((device) => device.kind === 'phone'); const pairing = status.pairing?.kind === 'phone' ? status.pairing : null;
  const tone = !status.enabled ? 'neutral' : ready ? 'success saved' : 'warning';
  return <article className="storage-card ui-card settings-card phone-access" aria-labelledby="phone-access-title">
    {head(!status.enabled ? 'Off' : ready ? 'Ready' : status.listening ? 'Needs Tailscale' : 'Not running', tone)}
    <p>Read and type into your channels from your phone, answer approvals, and get alerts.</p>
    <p className="ui-hint ui-help-line">Phones connect through Tailscale, your private network; nothing is opened to the internet.<HelpTip label="Help: how a phone connects" text="Tailscale is a private network for your own devices. Each phone must also be paired here, and can be removed at any time." /></p>
    <label className="ui-check"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={(event) => { const enabled = event.target.checked; setStatus({ ...status, enabled }); void run({ action: 'remote-enable', enabled }); }} />Allow paired phones to read and type into channels</label>
    {status.error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{status.error}</span></p>}
    {status.enabled && <>
      <ol className="phone-steps">
        <li className={tailscale.installed && tailscale.running ? 'done' : ''}><strong>Tailscale on this computer and your phone.</strong>{' '}
          {!tailscale.installed ? 'Install Tailscale from tailscale.com/download on both, and sign in with the same account.' : !tailscale.running ? (tailscale.error ?? 'Open Tailscale and sign in.') : <>Connected as <code>{tailscale.host}</code>. Install Tailscale on your phone with the same account.</>}</li>
        <li className={tailscale.serving ? 'done' : ''}><strong>HTTPS on your tailnet.</strong>{' '}
          {tailscale.serving ? <>Your phone opens <code>{status.url}</code>.</> : status.serveProblem
            ? <ServeGuide problem={status.serveProblem} busy={busy} open={() => void run({ action: 'remote-open-tailscale' })} retry={() => void run({ action: 'remote-serve' })} />
            : <>Trace asks Tailscale to pass HTTPS on your tailnet to this computer’s phone page. <button className="button secondary small" disabled={busy || !tailscale.running} onClick={() => void run({ action: 'remote-serve' })}>Set up Tailscale HTTPS</button></>}</li>
        <li className={phones.length ? 'done' : ''}><strong>Pair your phone.</strong>{' '}
          {/* Primary once HTTPS is set up: until then the step above holds the card's one primary action (Try again). */}
          {pairing ? null : <button className={`button ${tailscale.serving ? 'primary' : 'secondary'} small`} disabled={busy || !status.listening} onClick={() => void run({ action: 'remote-pair' })}>Pair a phone</button>}</li>
      </ol>
      {tailscale.funnel && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>Tailscale Funnel is on for this address, which would put it on the public internet. Trace refuses Funnel requests; turn Funnel off with “tailscale funnel reset”.</span></p>}
      {pairing && <div className="phone-pairing" role="group" aria-label="Pairing code">
        <QrCode text={pairing.url} label="QR code that opens the pairing page on your phone" />
        <div>
          <p>Scan with your phone’s camera, or open {status.url ? <code>{status.url}</code> : 'the phone page'} and enter:</p>
          <p className="phone-code" aria-label="Pairing code">{pairing.code.replace(/(.{5})/, '$1 ')}</p>
          <p className="ui-hint">Expires in {left(pairing.expiresAt, now)}. Works once.</p>
          <button className="quiet-button" disabled={busy} onClick={() => void run({ action: 'remote-cancel-pairing' })}>Cancel</button>
          {!tailscale.serving && <p className="ui-hint">Until Tailscale HTTPS is set up, this code only works from a browser on this computer.</p>}
        </div>
      </div>}
      {phones.length > 0 && <ul className="ui-list phone-devices" aria-label="Paired phones">{phones.map((device) => <li key={device.id} className="ui-row">
        <div className="ui-row-main"><strong>{device.name}</strong><small>Paired {new Date(device.createdAt).toLocaleDateString()} · {device.lastSeen ? `last used ${new Date(device.lastSeen).toLocaleString()}` : 'not used yet'} · {device.notifications ? 'alerts on' : 'alerts off'}</small></div>
        <div className="ui-actions">{device.notifications && <button className="button secondary small" disabled={busy} onClick={() => void run({ action: 'remote-test-alert', id: device.id })}>Send test alert</button>}<button className="button danger small" aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => void run({ action: 'remote-revoke', id: device.id })}><X size={16} />Remove</button></div>
        <label className="ui-check"><input type="checkbox" checked={device.canRun} disabled={busy} onChange={(event) => void run({ action: 'remote-can-run', id: device.id, canRun: event.target.checked })} />Can start and stop agents</label>
      </li>)}</ul>}
      {/* Said once under the list, not in every phone's row: it is the same for each. */}
      {phones.length > 0 && <><div><p className="ui-hint">Any paired phone can type into channels and answer approvals. Remove locks it out at once.</p>
      <p className="ui-hint">Can start and stop agents also lets it add and stop channels and, on Windows, control this screen.</p></div>
      <HowThisWorks><p>Can start and stop agents lets a phone start, stop, restart and add channels, and, on Windows with Share this screen on, see and control this screen (turning it off closes that at once). Either way, a paired phone can type into running channels, answer approvals, write handoff notes to shared memory and ask for a coaching review.</p></HowThisWorks></>}
    </>}
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
  </article>;
}
