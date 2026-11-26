import { useEffect, useState } from 'react';
import { CircleAlert, Download, ExternalLink, RefreshCw } from 'lucide-react';
import type { UpdatePhase, UpdateRequest, UpdateStatus } from '../../shared/updates';

/** The phase as a badge beside the version; idle shows none. */
const PHASES: Partial<Record<UpdatePhase, { label: string; tone: string }>> = { disabled: { label: 'Manual updates', tone: 'neutral' }, checking: { label: 'Checking', tone: 'accent' }, available: { label: 'Update available', tone: 'accent' }, current: { label: 'Up to date', tone: 'success' }, downloading: { label: 'Downloading', tone: 'accent' }, ready: { label: 'Ready to install', tone: 'success' }, installing: { label: 'Installing', tone: 'accent' }, error: { label: 'Update failed', tone: 'danger' } };

export function UpdatesPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const host = window.codingHub;
    if (!host) return;
    let mounted = true;
    const unsubscribe = host.onUpdateStatus((next) => { if (mounted) setStatus(next); });
    void host.updates({ action: 'status' }).then((result) => {
      if (!mounted) return;
      if (result.ok) setStatus(result.value); else setError(result.error.message);
    }).catch(() => { if (mounted) setError('Update status is unavailable.'); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  async function run(request: UpdateRequest) {
    if (!window.codingHub || busy) return;
    setBusy(true); setError('');
    try {
      const result = await window.codingHub.updates(request);
      if (result.ok) setStatus(result.value); else setError(result.error.message);
    } catch { setError('The update request failed. Try again.'); }
    finally { setBusy(false); }
  }
  const disabled = !status || status.phase === 'disabled';
  const working = busy || ['checking', 'downloading', 'installing'].includes(status?.phase ?? '');
  const state = status ? PHASES[status.phase] : undefined;
  return <article className="storage-card ui-card settings-card updates-card">
    <div className="ui-card-head"><Download aria-hidden="true" /><h3>Application updates</h3><span className="ui-badge neutral">{status ? `v${status.version}` : !window.codingHub ? 'Desktop edition' : error ? 'Unavailable' : 'Checking'}</span>{state && <span className={`ui-badge ${state.tone}`}>{state.label}</span>}</div>
    {/* A failed update reads as an error; with no status at all, the error banner below says why. */}
    {(status || !error) && <p role="status" className={status?.phase === 'error' ? 'ui-banner danger' : undefined}>{status?.phase === 'error' && <CircleAlert aria-hidden="true" />}<span>{status?.message ?? (window.codingHub ? 'Checking how this copy is updated…' : 'Update controls are available in the desktop app.')}</span></p>}
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
    {!disabled && <>
      <label className="ui-check"><input type="checkbox" checked={status!.automaticChecks} disabled={working} onChange={(event) => void run({ action: 'automatic', enabled: event.target.checked })} />Automatically check for stable releases</label>
      <p className="ui-hint">Checks contact GitHub every four hours, without your files or channels. You choose when to install.</p>
      {status?.lastChecked && <small className="ui-hint">Last check: {new Date(status.lastChecked).toLocaleString()}</small>}
      {status?.phase === 'downloading' && <progress className="ui-meter accent" aria-label="Update download progress" max={100} value={status.progress ?? undefined} />}
    </>}
    <div className="ui-actions">
      {!disabled && <button className="button secondary" disabled={working || status?.phase === 'ready'} onClick={() => void run({ action: 'check' })}><RefreshCw size={16} />Check for updates</button>}
      {!disabled && (status?.phase === 'available' || (status?.phase === 'error' && status.availableVersion && status.progress !== 100)) && <button className="button primary" disabled={working} onClick={() => void run({ action: 'download' })}><Download size={16} />Download {status.availableVersion}</button>}
      {!disabled && (status?.phase === 'ready' || (status?.phase === 'error' && status.progress === 100)) && <button className="button primary" disabled={working} onClick={() => void run({ action: 'install' })}>Restart and install</button>}
      {window.codingHub && <button className="button secondary" disabled={busy} title="The Windows installer and the Mac disk images for every release" onClick={() => void run({ action: 'downloads' })}><ExternalLink size={16} />Open downloads page</button>}
    </div>
    <p className="ui-hint">Stop all channels before installing. Your data in <code>~/.coding-hub</code> is kept across upgrades.</p>
  </article>;
}
