import { useEffect, useState } from 'react';
import { Download, FolderOpen, Puzzle, RefreshCw, ScrollText, Search, Trash2 } from 'lucide-react';
import type { PluginBrowseItem, PluginData, PluginPreview, PluginRun, PluginSummary } from '../../shared/plugins';
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
  // The switch shows its new state at once (1.35.0); a refusal puts back what the main process holds.
  const act = async (request: Parameters<typeof workbench>[0]) => { setBusy(true); setError(''); try { const next = await workbench<PluginData | null>(request); if (next && 'plugins' in next) setData(next); else await refresh(); } catch (e) { setError((e as Error).message); await refresh(); } finally { setBusy(false); } };
  const link = async () => { const folder = await window.codingHub?.pickDirectory(); if (folder) await act({ action: 'plugin-link', folder }); };
  // Install from GitHub (docs/plugins.md, section 6): fetch, then a preview of everything it would run, then Install.
  const [repo, setRepo] = useState(''); const [ref, setRef] = useState(''); const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [list, setList] = useState<PluginBrowseItem[] | null>(null);
  const fetchPreview = async (from: string, at?: string) => { setBusy(true); setError(''); setPreview(null); try { setPreview(await workbench<PluginPreview>({ action: 'plugin-fetch', repo: from, ...(at ? { ref: at } : {}) })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const install = async () => { if (!preview) return; await act({ action: 'plugin-install', fetchId: preview.fetchId }); setPreview(null); setRepo(''); setRef(''); };
  const loadList = async () => { setBusy(true); setError(''); try { setList(await workbench<PluginBrowseItem[]>({ action: 'plugin-browse' })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const showLog = async (id: string) => { if (log?.id === id) { setLog(null); return; } try { setLog({ id, runs: await workbench<PluginRun[]>({ action: 'plugin-log', id }) }); } catch (e) { setError((e as Error).message); } };
  return <article className="ui-card trace-plugins" aria-labelledby="trace-plugins-title">
    <div className="ui-card-head"><Puzzle aria-hidden="true" /><h2 id="trace-plugins-title">Trace plugins</h2><span className="ui-badge neutral">{data.plugins.length}</span><div className="ui-card-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => void act({ action: 'plugin-check' })}><RefreshCw size={13} aria-hidden="true" />Check for updates</button><button type="button" className="button secondary small" disabled={busy} onClick={() => void link()}><FolderOpen size={13} aria-hidden="true" />Link a folder</button></div></div>
    <p className="ui-hint">Plugins add actions to the command menu and run on events in Trace. They run as you, on this computer, and nobody reviews them: add only ones you trust.</p>
    <HowThisWorks><p>A plugin is a folder with a <code>trace-plugin.json</code> manifest and the programs it names. Before it is added, a system dialog shows every command it may run and what it may ask Trace to do. Its actions are in the command menu (Ctrl+Shift+P) as <em>plugin name: action</em>, and its event commands run when a channel needs you, ends its turn, fails, starts or stops, a task is ready for review, a worktree is made, or Trace starts. Turning a plugin off stops its programs at once.</p></HowThisWorks>
    <form className="plugin-install" onSubmit={(e) => { e.preventDefault(); if (repo.trim()) void fetchPreview(repo, ref); }}>
      <label>Install from GitHub<input aria-label="GitHub repository" placeholder="owner/repo or owner/repo/folder" value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
      <label>Branch, tag or commit<input aria-label="Branch, tag or commit" placeholder="The default branch" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
      <button type="submit" className="button secondary" disabled={busy || !repo.trim()}><Download size={16} aria-hidden="true" />Preview</button>
      <small className="ui-hint">Fetched with this computer's Git, so a private repository works when Git is signed in to GitHub here. Nothing runs before you install.</small>
    </form>
    {preview && <section className="plugin-preview" aria-label={`Preview of ${preview.name}`}>
      <h3>{preview.name} <span className="ui-hint">{preview.version} · {preview.repo}{preview.ref ? ` (${preview.ref})` : ''} at {preview.commit.slice(0, 12)}</span></h3>
      {preview.description && <p>{preview.description}</p>}
      <p className="error-message">It runs as you, on this computer, and nobody has reviewed it. Install only what you trust.</p>
      {preview.update && (preview.update.same ? <p className="ui-hint">This is the version installed now ({preview.update.from.slice(0, 12)}).</p> : <p>Updates from {preview.update.from.slice(0, 12)}: {preview.update.added.length} new {preview.update.added.length === 1 ? 'command' : 'commands'}, {preview.update.removed.length} removed{preview.update.newPermissions.length ? `, and it newly asks to ${preview.update.newPermissions.map((item) => PERMISSION_WORDS[item]).join(', ')}` : ''}.</p>)}
      <p>It may {preview.permissions.length ? preview.permissions.map((item) => PERMISSION_WORDS[item]).join(', ') : 'not use Trace at all'}.</p>
      <p>Every command it may run:</p><pre className="check-output">{preview.commands.map((item) => `${item.what}: ${item.command.join(' ')}`).join('\n') || 'None'}</pre>
      <details><summary>{preview.files.length} {preview.files.length === 1 ? 'file' : 'files'}</summary><pre className="check-output">{preview.files.join('\n')}</pre></details>
      <div className="ui-actions"><button type="button" className="button primary small" disabled={busy || Boolean(preview.update?.same)} onClick={() => void install()}>{preview.update ? 'Update' : 'Install'}</button><button type="button" className="button secondary small" onClick={() => setPreview(null)}>Cancel</button></div>
    </section>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {!data.plugins.length ? <div className="ui-empty"><Puzzle aria-hidden="true" /><h3>No Trace plugins yet</h3><p>Link a folder holding a plugin's trace-plugin.json to add one.</p></div>
      : <ul className="ui-list">{data.plugins.map((plugin) => <li key={plugin.id} className="trace-plugin">
        <div className="ui-row">
          <span className="ui-row-main"><strong>{plugin.name}{plugin.version && <span className="ui-hint"> {plugin.version}</span>}</strong><small>{plugin.description || plugin.id}</small><small className="ui-hint">{sourceWords(plugin)}</small>
            {plugin.problem ? <small className="error-message" role="alert">{plugin.problem}</small> : <small>{[plugin.actions.length && `${plugin.actions.length} ${plugin.actions.length === 1 ? 'action' : 'actions'}`, plugin.events.length && `runs on ${[...new Set(plugin.events)].join(', ')}`, plugin.permissions.length && `may ${plugin.permissions.map((item) => PERMISSION_WORDS[item]).join(', ')}`].filter(Boolean).join(' · ') || 'Does nothing yet'}</small>}
            {plugin.lastRun && <small className={plugin.lastRun.ok ? 'ui-hint' : 'error-message'}>Last run: {plugin.lastRun.what}, {plugin.lastRun.note.toLowerCase()} · {new Date(plugin.lastRun.endedAt).toLocaleString()}{plugin.failures > 2 ? ` · ${plugin.failures} failed in a row` : ''}</small>}</span>
          <label className="update-checkbox"><input type="checkbox" aria-label={`${plugin.name} on`} checked={plugin.enabled} disabled={busy} onChange={(e) => { const enabled = e.target.checked; setData((current) => ({ plugins: current.plugins.map((item) => item.id === plugin.id ? { ...item, enabled } : item) })); void act({ action: 'plugin-enable', id: plugin.id, enabled }); }} />On</label>
          {plugin.update && plugin.source.kind === 'github' && <button type="button" className="button secondary small" disabled={busy} onClick={() => { const source = plugin.source; if (source.kind === 'github') void fetchPreview(source.repo, source.ref); }}>Update to {plugin.update.slice(0, 8)}</button>}
          <button type="button" className="quiet-button small" aria-pressed={log?.id === plugin.id} onClick={() => void showLog(plugin.id)}><ScrollText size={12} aria-hidden="true" />Runs</button>
          {removing === plugin.id ? <ConfirmStep question={`Remove ${plugin.name}? Its folder stays where it is.`} action="Remove plugin" busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => { setRemoving(null); void act({ action: 'plugin-remove', id: plugin.id }); }} /> : <button type="button" className="icon-button" aria-label={`Remove ${plugin.name}`} disabled={busy} onClick={() => setRemoving(plugin.id)}><Trash2 size={14} aria-hidden="true" /></button>}
        </div>
        {log?.id === plugin.id && (log.runs.length ? <ol className="plugin-runs">{log.runs.map((run, index) => <li key={index}><strong className={run.ok ? '' : 'error-message'}>{run.what}: {run.note}</strong> <span className="ui-hint">{new Date(run.endedAt).toLocaleString()}</span>{run.output && <pre className="check-output">{run.output}</pre>}</li>)}</ol> : <p className="ui-hint">No runs yet in this session.</p>)}
      </li>)}</ul>}
    <section className="plugin-browse" aria-labelledby="plugin-browse-title">
      <div className="ui-row"><h3 id="plugin-browse-title">Browse</h3><button type="button" className="button secondary small" disabled={busy} onClick={() => void loadList()}><Search size={13} aria-hidden="true" />{list ? 'Search again' : 'Find plugins on GitHub'}</button></div>
      <p className="ui-hint">Repositories on GitHub with the topic trace-plugin. Nobody reviews this list: being on it means only that a repository tagged itself.</p>
      {list && (list.length ? <ul className="ui-list">{list.map((item) => <li key={item.repo} className="ui-row"><span className="ui-row-main"><strong>{item.repo}</strong><small>{item.description || 'No description'}</small><small className="ui-hint">★ {item.stars}{item.pushedAt ? ` · updated ${new Date(item.pushedAt).toLocaleDateString()}` : ''}</small></span><button type="button" className="button secondary small" disabled={busy} onClick={() => void fetchPreview(item.repo)}>Preview</button></li>)}</ul> : <p className="ui-hint">No repositories have the topic trace-plugin yet.</p>)}
    </section>
  </article>;
}
