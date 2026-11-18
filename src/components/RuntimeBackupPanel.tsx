import { useEffect, useState } from 'react';
import { AppWindow, ArchiveRestore, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { APP_VERSION } from '../version';
import { CrashDiagnostics } from './CrashDiagnostics';
import { MAC } from './platform';
import { workbench } from '../runtime/workbench';
import type { RuntimeInfo, BackupRecord, BackupResult } from '../../shared/workbench';
const EDITIONS: Record<RuntimeInfo['edition'], string> = { source: 'Source edition', installed: 'Installed edition', portable: 'Portable edition' };
export function RuntimeBackupPanel() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null); const [backups, setBackups] = useState<BackupRecord[]>([]); const [includeLogs, setIncludeLogs] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  async function refresh() { const [info, records] = await Promise.all([workbench<RuntimeInfo>({ action: 'runtime' }), workbench<BackupRecord[]>({ action: 'backup-list' })]); setRuntime(info); setBackups(records); }
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  async function run(action: 'backup-create' | 'backup-export' | 'backup-restore' | 'backup-import' | 'backup-delete' | 'restart', id?: string) {
    setBusy(true); setError(''); setNotice(''); try {
      const result = await workbench<BackupResult | BackupRecord[] | null>(action === 'backup-create' ? { action, includeLogs } : action === 'backup-export' || action === 'backup-restore' || action === 'backup-delete' ? { action, id: id! } : { action });
      // Deleting answers with the list left (Trace asks to confirm first), or nothing when the person said no.
      if (Array.isArray(result)) { setBackups(result); setNotice('Backup deleted.'); return; }
      if (result) setNotice(result.restartRequired ? `Restored copy ready at ${result.restoredPath}. Restart to activate it.` : 'Backup verified successfully.'); await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><article className="storage-card ui-card settings-card"><div className="ui-card-head"><AppWindow aria-hidden="true" /><h2>Running application</h2><span className="ui-badge neutral">{runtime ? EDITIONS[runtime.edition] ?? `${runtime.edition} edition` : 'Checking'}</span></div>
    {runtime && runtime.version !== APP_VERSION && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>The renderer and native host versions differ. Close old app windows and rebuild or install the latest source release.</span></p>}
    <dl className="settings-facts"><dt>Version</dt><dd>Renderer v{APP_VERSION} · Host v{runtime?.version ?? 'checking'}</dd><dt>Executable</dt><dd><code>{runtime?.executable}</code></dd><dt>Application folder</dt><dd><code>{runtime?.applicationPath}</code></dd><dt>Active local data</dt><dd><code>{runtime?.storagePath}</code></dd></dl>
    <p className="ui-hint">Source files do not update an installed shortcut. {MAC ? 'Use npm start in the intended source folder, or rebuild and install its disk image.' : 'Use npm.cmd start in the intended source folder, or rebuild and install its Windows Setup.exe.'}</p><CrashDiagnostics storagePath={runtime?.storagePath} /></article>
  <article className="storage-card ui-card settings-card"><div className="ui-card-head"><ArchiveRestore aria-hidden="true" /><h2>Local backup and recovery</h2></div><p>Save verified settings, SQLite history/usage, shared rules, curated memory, experiments, tasks, and verification profiles. CLI credentials and external project files are excluded. Restore creates a new copy and activates it on restart; current data remains intact.</p>
    <label className="ui-check"><input type="checkbox" aria-label="Include session output in backup" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />Include session output logs</label>
    <div className="ui-actions"><button className="button secondary" disabled={busy} onClick={() => void run('backup-create')}>Create local backup</button><button className="button secondary" disabled={busy} onClick={() => void run('backup-import')}>Import and restore backup</button>{runtime?.restartRequired && <button className="button primary" disabled={busy} onClick={() => void run('restart')}>Restart with restored data</button>}</div>
    <p className="ui-banner warning"><TriangleAlert aria-hidden="true" /><span>Stop sessions and verification first. Backups are unencrypted and limited to 64 MiB / 10,000 files, with up to 50 local backups. Profile labels are preserved; named accounts must sign in again after restore. Project instructions and repository files are not restored.</span></p>
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}{notice && <p role="status" className="ui-banner success"><CircleCheck aria-hidden="true" /><span>{notice}</span></p>}
    {backups.length > 0 && <ul className="ui-list" aria-label="Local backups">{backups.map((backup) => <li className="ui-row" key={backup.id}><div className="ui-row-main"><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>v{backup.appVersion} · {backup.files} files · {(backup.bytes / 1048576).toFixed(1)} MiB {backup.includesLogs ? '· with logs' : ''}</small></div><div className="ui-actions"><button className="button secondary small" disabled={busy} onClick={() => void run('backup-export', backup.id)}>Export backup</button><button className="button secondary small" disabled={busy} onClick={() => void run('backup-restore', backup.id)}>Restore verified copy</button><button className="button danger small" disabled={busy} onClick={() => void run('backup-delete', backup.id)}>Delete backup</button></div></li>)}</ul>}</article></>;
}
