import { useEffect, useState } from 'react';
import { ProjectValidation } from './ProjectValidation';
import { Check, CircleAlert, Clock, FileText, FolderCheck, FolderOpen, RefreshCw, Save, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { DeviceSyncStatus, RulesTarget, SharedRules } from '../../shared/hub';
import { useWorkspaceStore } from '../state/workspace-store';
import { hubCall } from '../state/hub-store';

const EXAMPLE = 'Preserve public APIs unless I explicitly request a breaking change.\nInspect existing code before adding a dependency.\nRun relevant tests after meaningful changes; report checks you could not run.\nDo not commit, push, deploy, or modify credentials unless I ask.\nBefore finishing, save a handoff with decisions, changed files, validation, and remaining work.';

/**
 * A project registered for shared rules that cannot be read (its folder was deleted, most often) can be removed from the
 * list; the host refuses while the folder still exists, and never touches a file in it.
 */
export const forgettable = (target: RulesTarget, rules: SharedRules) => Boolean(target.error) && rules.directories.includes(target.directory);
/**
 * What the panel holds after a Remove. The host's write changes the revision, so saved rules that changed meanwhile (from
 * another computer) would otherwise pass Save's RULES_CHANGED check: an untouched editor takes the new text, and a draft
 * keeps the old revision, so Save is refused until the person reloads.
 */
export function afterForget(snapshot: SharedRules, next: SharedRules, draft: string): { snapshot: SharedRules; content: string; stale: boolean } {
  if (next.content === snapshot.content) return { snapshot: next, content: draft, stale: false };
  return draft === snapshot.content ? { snapshot: next, content: next.content, stale: false } : { snapshot: { ...next, revision: snapshot.revision }, content: draft, stale: true };
}

export function RulesPanel() {
  const { rootDirectory, sessions } = useWorkspaceStore();
  const workspaceDirectories = [...new Set([rootDirectory, ...sessions.map((s) => s.runningCwd ?? (s.binding.mode === 'independent' ? s.binding.cwd : rootDirectory))].filter((d): d is string => !!d))];
  const [snapshot, setSnapshot] = useState<SharedRules | null>(null);
  const [content, setContent] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Rules that arrived from another computer are saved but not yet applied to this computer's projects.
  const [syncedFrom, setSyncedFrom] = useState<DeviceSyncStatus['rulesFrom']>(null);
  useEffect(() => { void hubCall<DeviceSyncStatus>({ action: 'device-sync-status' }).then((status) => setSyncedFrom(status.enabled ? status.rulesFrom : null)).catch(() => {}); }, [snapshot?.revision]);
  const [confirmReload, setConfirmReload] = useState(false);
  const dirty = snapshot !== null && content !== snapshot.content;

  async function fetchRules(directories: string[]) {
    const saved = await hubCall<SharedRules>({ action: 'rules-read', directories });
    const all = [...new Set([...directories, ...saved.directories])];
    return all.length === directories.length ? saved : hubCall<SharedRules>({ action: 'rules-read', directories: all });
  }
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchRules(workspaceDirectories).then((value) => {
      if (!cancelled) { setSnapshot(value); setContent(value.content); setSelected(value.targets.filter((t) => !t.error).map((t) => t.directory)); }
    }).catch((e) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  async function reload() {
    setBusy(true); setError(''); setNotice('');
    try { const next = await fetchRules([...new Set([...workspaceDirectories, ...(snapshot?.targets.map((t) => t.directory) ?? [])])]); setSnapshot(next); setContent(next.content); setSelected(next.targets.filter((t) => !t.error).map((t) => t.directory)); setConfirmReload(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Rules could not be loaded.'); }
    finally { setBusy(false); }
  }
  async function addProject() {
    setBusy(true); setError(''); setNotice('');
    try {
      const directory = await window.codingHub?.pickDirectory();
      if (directory) { const next = await fetchRules([...new Set([...(snapshot?.targets.map((t) => t.directory) ?? []), directory])]); if (snapshot && next.revision !== snapshot.revision) throw new Error('Saved rules changed. Reload before selecting another project. Your draft is still in the editor.'); setSnapshot(next); setSelected([...new Set([...selected, ...next.targets.filter((t) => !t.error && !snapshot?.targets.some((old) => old.directory === t.directory)).map((t) => t.directory)])]); }
    } catch (e) { setError(e instanceof Error ? e.message : 'The project could not be added.'); }
    finally { setBusy(false); }
  }
  /** Takes a missing project off the list, keeping the draft and the other selections as they are. */
  async function forget(directory: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await hubCall({ action: 'rules-forget', directory }); const next = await fetchRules([...new Set([...workspaceDirectories, ...(snapshot?.targets.map((t) => t.directory) ?? [])])].filter((d) => d !== directory));
      const kept = snapshot ? afterForget(snapshot, next, content) : { snapshot: next, content: next.content, stale: false };
      setSnapshot(kept.snapshot); setContent(kept.content); setSelected(selected.filter((d) => d !== directory)); setNotice('Removed the missing project from shared rules.');
      if (kept.stale) setError('Saved rules changed. Reload before saving. Your draft is still in the editor.');
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The project could not be removed.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!snapshot) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const applied = await hubCall<SharedRules>({ action: 'rules-save', content, revision: snapshot.revision, targets: snapshot.targets.filter((t) => selected.includes(t.directory) && !t.error).map(({ directory, claudeHash, codexHash }) => ({ directory, claudeHash, codexHash })) });
      setSnapshot({ ...applied, targets: [...applied.targets, ...snapshot.targets.filter((t) => !selected.includes(t.directory)).map((t) => ({ ...t, applied: false }))] });
      setNotice(selected.length ? `Shared rules saved and applied to both engines in ${selected.length} project${selected.length === 1 ? '' : 's'}. Restart running channels to load them.` : 'Shared rules saved locally. Apply them to a project before starting its channels.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Rules could not be saved.'); }
    finally { setBusy(false); }
  }

  return <section className="feature-panel hub-panel rules-panel">
    <header className="ui-page-head"><span className="ui-page-icon"><ShieldCheck aria-hidden="true" /></span><div><h1>Shared rules</h1><p>One set of project instructions for Claude Code and Codex.</p></div><div className="ui-page-actions"><span className={`ui-badge dot rules-state ${dirty ? 'warning' : snapshot ? 'success' : 'neutral'}`}>{dirty ? 'Unsaved changes' : snapshot ? 'Saved rules loaded' : 'Loading rules…'}</span><button className="button primary" disabled={busy || !snapshot} onClick={() => void save()}><Save size={14} />Save and apply</button></div></header>
    {confirmReload && <div className="ui-banner warning rules-confirm"><TriangleAlert aria-hidden="true" /><span>Reloading replaces your unsaved draft.</span><button className="button danger small" onClick={() => void reload()} disabled={busy}>Discard draft and reload</button><button className="quiet-button small" onClick={() => setConfirmReload(false)}>Keep editing</button></div>}
    {error && <div className="hub-feedback error-message" role="alert">{error}</div>}{notice && <div className="hub-feedback success" role="status"><Check size={15} />{notice}</div>}
    {syncedFrom && snapshot?.targets.some((target) => !target.applied) && <div className="ui-banner warning rules-synced" role="status"><TriangleAlert aria-hidden="true" /><span>These rules came from {syncedFrom.name} ({new Date(syncedFrom.at).toLocaleString()}). Apply them to this computer’s projects below; until then those projects’ channels do not start.</span></div>}
    <div className="rules-columns"><article className="hub-form"><div className="ui-card-head"><FileText aria-hidden="true" /><h2>Your shared instructions</h2><div className="ui-card-actions"><button className="quiet-button small" disabled={busy || !!content.trim()} onClick={() => setContent(EXAMPLE)}>Use example rules</button><button className="button secondary small" disabled={busy} onClick={() => dirty ? setConfirmReload(true) : void reload()}><RefreshCw size={14} />Reload saved rules</button></div></div><label htmlFor="shared-rules-editor">Rules for both engines</label><textarea id="shared-rules-editor" className="rules-editor" rows={18} maxLength={60000} value={content} disabled={busy || !snapshot} onChange={(e) => setContent(e.target.value)} placeholder={'Describe coding conventions, test requirements, approval boundaries, and handoff expectations.\n\nExample: Run relevant tests and report anything you could not verify.'} /><span className="ui-hint tnum">{content.length.toLocaleString()} / 60,000 characters · Markdown text</span><p className="ui-hint">Save and apply replaces only Trace’s marked shared-rules section. Clearing the editor removes that section from selected projects.</p></article>
      <div><article className="hub-form rules-targets"><div className="ui-card-head"><FolderCheck aria-hidden="true" /><h2>Apply to projects</h2><div className="ui-card-actions"><button className="button secondary small" disabled={busy || !snapshot} onClick={() => void addProject()}><FolderOpen size={14} />Add project</button></div></div><p className="ui-hint">The same rules go into each project’s <code>CLAUDE.md</code> and <code>AGENTS.md</code>; their other text stays intact.</p>{snapshot?.targets.length ? <div className="ui-list">{snapshot.targets.map((target) => <label className="ui-row rules-target" key={target.directory}><input type="checkbox" checked={selected.includes(target.directory)} disabled={busy || !!target.error} onChange={(e) => setSelected(e.target.checked ? [...selected, target.directory] : selected.filter((d) => d !== target.directory))} /><span><code>{target.directory}</code><small className={target.error ? 'error-message' : ''}>{target.error ?? (target.applied && !dirty ? 'Current rules applied to both engines' : 'Needs current rules applied')}</small>{forgettable(target, snapshot) && <button type="button" className="quiet-button" disabled={busy} onClick={(e) => { e.preventDefault(); void forget(target.directory); }}>Remove</button>}</span></label>)}</div> : snapshot ? <div className="ui-empty"><FolderCheck aria-hidden="true" /><h3>No projects yet</h3><p>Open a workspace or add a project. You can save a rule draft first.</p></div> : error ? <div className="ui-empty danger" role="alert"><CircleAlert aria-hidden="true" /><h3>Rules could not be loaded</h3><p>Reload saved rules to try again.</p></div> : <div className="ui-empty" role="status"><RefreshCw className="spin" aria-hidden="true" /><h3>Loading projects…</h3><p>Reading each project’s instruction files.</p></div>}</article>
      <article className="hub-form"><div className="ui-card-head"><Clock aria-hidden="true" /><h2>When they take effect</h2><button type="button" className="ui-help" aria-label="Help: when rules take effect" title="When rules are set, Trace checks that both engines’ instruction files contain the current version before starting a channel." /></div><p className="ui-hint">Restart running channels after applying changes.</p><p className="ui-hint">Rules guide the agents; tests, CLI permissions, hooks, and CI enforce conditions mechanically. Higher-priority and more specific engine instructions still affect behavior.</p><button className="button secondary" onClick={() => useWorkspaceStore.setState({ activeView: 'help', helpTopicId: 'rules' })}>Read the rules guide</button></article></div></div>
  <ProjectValidation directories={[...new Set([...workspaceDirectories, ...(snapshot?.directories ?? [])])]} /></section>;
}
