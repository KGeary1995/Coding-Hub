import { useEffect, useState } from 'react';
import { Code2 } from 'lucide-react';
import { workbench } from '../runtime/workbench';

/** Connects VS Code (1.38.0): Trace installs its extension with one press, and the extension finds Trace by itself. */
export function VSCodeCard() {
  const [status, setStatus] = useState<{ found: boolean; installed: boolean } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  useEffect(() => { void workbench<{ found: boolean; installed: boolean }>({ action: 'editor-status' }).then(setStatus).catch(() => setStatus(null)); }, []);
  const connect = async () => { setBusy(true); setError(''); try { setStatus(await workbench<{ found: boolean; installed: boolean }>({ action: 'editor-connect' })); setDone(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <article className="ui-card settings-card"><div className="ui-card-head"><Code2 aria-hidden="true" /><h3>VS Code</h3>{status?.installed && <span className="ui-badge success dot">Connected</span>}</div>
    <p className="control-note">Select code in VS Code, right-click it and choose <strong>Send to a Trace channel</strong>: pick a running agent channel, say what to do with it, and it arrives there with its file and lines. Trace must be open.</p>
    {status && !status.found && <p className="control-note">VS Code was not found on this computer.</p>}
    <div className="ui-actions"><button type="button" className="button secondary" disabled={busy || (status !== null && !status.found)} onClick={() => void connect()}>{busy ? 'Connecting…' : status?.installed ? 'Update the VS Code extension' : 'Connect VS Code'}</button></div>
    {done && !error && <p className="ui-hint" role="status">Done. In VS Code, the editor’s right-click menu now has Send to a Trace channel (reload the window if it does not show yet).</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </article>;
}
