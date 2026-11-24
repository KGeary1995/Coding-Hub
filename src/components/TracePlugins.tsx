import { useEffect, useState } from 'react';
import { FolderOpen, Puzzle, ScrollText, Trash2 } from 'lucide-react';
import type { PluginData, PluginRun, PluginSummary } from '../../shared/plugins';
import { workbench } from '../runtime/workbench';
import { ConfirmStep } from './ConfirmStep';
import { HowThisWorks } from './HowThisWorks';

const PERMISSION_WORDS: Record<PluginSummary['permissions'][number], string> = { 'channels.read': 'read channels', 'channels.send': 'message channels', 'channels.control': 'start, stop and add channels', tasks: 'read and add tasks', notify: 'show notices' };
const sourceWords = (plugin: PluginSummary) => plugin.source.kind === 'folder' ? `Linked folder: ${plugin.source.path}` : `GitHub: ${plugin.source.repo}${plugin.source.ref ? ` (${plugin.source.ref})` : ''} at ${plugin.source.commit.slice(0, 8)}`;

/**
 * Skills & plugins → Trace plugins (1.35.0, docs/plugins.md): Trace's own plugins, as against the CLIs' skills and
 * plugins listed below. Link a folder adds one after a system dialog shows every command it may run.
 */
export function TracePlugins() {
  const [data, setData] = useState<PluginData>({ plugins: [] }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null); const [log, setLog] = useState<{ id: string; runs: PluginRun[] } | null>(null);
  const refresh = () => workbench<PluginData>({ action: 'plugin-list' }).then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  const act = async (request: Parameters<typeof workbench>[0]) => { setBusy(true); setError(''); try { const next = await workbench<PluginData | null>(request); if (next && 'plugins' in next) setData(next); else await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const link = async () => { const folder = await window.codingHub?.pickDirectory(); if (folder) await act({ action: 'plugin-link', folder }); };
  const showLog = async (id: string) => { if (log?.id === id) { setLog(null); return; } try { setLog({ id, runs: await workbench<PluginRun[]>({ action: 'plugin-log', id }) }); } catch (e) { setError((e as Error).message); } };
  return <article className="ui-card trace-plugins" aria-labelledby="trace-plugins-title">
    <div className="ui-card-head"><Puzzle aria-hidden="true" /><h2 id="trace-plugins-title">Trace plugins</h2><span className="ui-badge neutral">{data.plugins.length}</span><div className="ui-card-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => void link()}><FolderOpen size={13} aria-hidden="true" />Link a folder</button></div></div>
    <p className="ui-hint">Plugins add actions to the command menu and run on events in Trace. They run as you, on this computer, and nobody reviews them: add only ones you trust.</p>
    <HowThisWorks><p>A plugin is a folder with a <code>trace-plugin.json</code> manifest and the programs it names. Before it is added, a system dialog shows every command it may run and what it may ask Trace to do. Its actions are in the command menu (Ctrl+Shift+P) as <em>plugin name: action</em>, and its event commands run when a channel needs you, ends its turn, fails, starts or stops, a task is ready for review, a worktree is made, or Trace starts. Turning a plugin off stops its programs at once.</p></HowThisWorks>
    {error && <p className="error-message" role="alert">{error}</p>}
    {!data.plugins.length ? <div className="ui-empty"><Puzzle aria-hidden="true" /><h3>No Trace plugins yet</h3><p>Link a folder holding a plugin's trace-plugin.json to add one.</p></div>
      : <ul className="ui-list">{data.plugins.map((plugin) => <li key={plugin.id} className="trace-plugin">
        <div className="ui-row">
          <span className="ui-row-main"><strong>{plugin.name}{plugin.version && <span className="ui-hint"> {plugin.version}</span>}</strong><small>{plugin.description || plugin.id}</small><small className="ui-hint">{sourceWords(plugin)}</small>
            {plugin.problem ? <small className="error-message" role="alert">{plugin.problem}</small> : <small>{[plugin.actions.length && `${plugin.actions.length} ${plugin.actions.length === 1 ? 'action' : 'actions'}`, plugin.events.length && `runs on ${[...new Set(plugin.events)].join(', ')}`, plugin.permissions.length && `may ${plugin.permissions.map((item) => PERMISSION_WORDS[item]).join(', ')}`].filter(Boolean).join(' · ') || 'Does nothing yet'}</small>}
            {plugin.lastRun && <small className={plugin.lastRun.ok ? 'ui-hint' : 'error-message'}>Last run: {plugin.lastRun.what}, {plugin.lastRun.note.toLowerCase()} · {new Date(plugin.lastRun.endedAt).toLocaleString()}{plugin.failures > 2 ? ` · ${plugin.failures} failed in a row` : ''}</small>}</span>
          <label className="update-checkbox"><input type="checkbox" aria-label={`${plugin.name} on`} checked={plugin.enabled} disabled={busy} onChange={(e) => void act({ action: 'plugin-enable', id: plugin.id, enabled: e.target.checked })} />On</label>
          <button type="button" className="quiet-button small" aria-pressed={log?.id === plugin.id} onClick={() => void showLog(plugin.id)}><ScrollText size={12} aria-hidden="true" />Runs</button>
          {removing === plugin.id ? <ConfirmStep question={`Remove ${plugin.name}? Its folder stays where it is.`} action="Remove plugin" busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => { setRemoving(null); void act({ action: 'plugin-remove', id: plugin.id }); }} /> : <button type="button" className="icon-button" aria-label={`Remove ${plugin.name}`} disabled={busy} onClick={() => setRemoving(plugin.id)}><Trash2 size={14} aria-hidden="true" /></button>}
        </div>
        {log?.id === plugin.id && (log.runs.length ? <ol className="plugin-runs">{log.runs.map((run, index) => <li key={index}><strong className={run.ok ? '' : 'error-message'}>{run.what}: {run.note}</strong> <span className="ui-hint">{new Date(run.endedAt).toLocaleString()}</span>{run.output && <pre className="check-output">{run.output}</pre>}</li>)}</ol> : <p className="ui-hint">No runs yet in this session.</p>)}
      </li>)}</ul>}
  </article>;
}
