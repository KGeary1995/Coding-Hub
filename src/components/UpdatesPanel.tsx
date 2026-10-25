import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import type { UpdateRequest, UpdateStatus } from '../../shared/updates';

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
  return <article className="storage-card updates-card">
    <header><h2>Application updates</h2><span className="eyebrow">{status ? `v${status.version}` : 'Desktop edition'}</span></header>
    <p role="status">{status?.message ?? 'Update controls are available in the desktop app.'}</p>
    {error && <p role="alert" className="error-message">{error}</p>}
    {!disabled && <>
      <label className="update-checkbox"><input type="checkbox" checked={status!.automaticChecks} disabled={working} onChange={(event) => void run({ action: 'automatic', enabled: event.target.checked })} />Automatically check for stable releases</label>
      <p className="muted">Checks run after startup and every four hours. Downloads and installation require your action. Checks contact GitHub; workspace files and session content are never included.</p>
      {status?.lastChecked && <small className="muted">Last check: {new Date(status.lastChecked).toLocaleString()}</small>}
      {status?.phase === 'downloading' && <progress aria-label="Update download progress" max={100} value={status.progress ?? undefined} />}
      <div className="hub-toolbar">
        <button className="button secondary" disabled={working || status?.phase === 'ready'} onClick={() => void run({ action: 'check' })}><RefreshCw size={14} />Check for updates</button>
        {(status?.phase === 'available' || (status?.phase === 'error' && status.availableVersion && status.progress !== 100)) && <button className="button primary" disabled={working} onClick={() => void run({ action: 'download' })}><Download size={14} />Download {status.availableVersion}</button>}
        {(status?.phase === 'ready' || (status?.phase === 'error' && status.progress === 100)) && <button className="button primary" disabled={working} onClick={() => void run({ action: 'install' })}>Restart and install</button>}
      </div>
    </>}
    {window.codingHub && <button className="button secondary" disabled={busy} onClick={() => void run({ action: 'downloads' })}><ExternalLink size={14} />Open downloads page</button>}
    <p className="control-note">The downloads page has the Windows installer and the Mac disk images for every release. Settings, rules, memory, and logs are stored separately in ~/.coding-hub and retained across upgrades. Stop all CLI sessions before installing.</p>
  </article>;
}
