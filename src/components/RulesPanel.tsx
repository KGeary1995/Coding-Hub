import { useEffect, useState } from 'react';
import { ProjectValidation } from './ProjectValidation';
import { Check, FolderOpen, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import type { SharedRules } from '../../shared/hub';
import { useWorkspaceStore } from '../state/workspace-store';
import { hubCall } from '../state/hub-store';

const EXAMPLE = 'Preserve public APIs unless I explicitly request a breaking change.\nInspect existing code before adding a dependency.\nRun relevant tests after meaningful changes; report checks you could not run.\nDo not commit, push, deploy, or modify credentials unless I ask.\nBefore finishing, save a handoff with decisions, changed files, validation, and remaining work.';

export function RulesPanel() {
  const { rootDirectory, sessions } = useWorkspaceStore();
  const workspaceDirectories = [...new Set([rootDirectory, ...sessions.map((s) => s.runningCwd ?? (s.binding.mode === 'independent' ? s.binding.cwd : rootDirectory))].filter((d): d is string => !!d))];
  const [snapshot, setSnapshot] = useState<SharedRules | null>(null);
  const [content, setContent] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
  async function save() {
    if (!snapshot) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const applied = await hubCall<SharedRules>({ action: 'rules-save', content, revision: snapshot.revision, targets: snapshot.targets.filter((t) => selected.includes(t.directory) && !t.error).map(({ directory, claudeHash, codexHash }) => ({ directory, claudeHash, codexHash })) });
      setSnapshot({ ...applied, targets: [...applied.targets, ...snapshot.targets.filter((t) => !selected.includes(t.directory)).map((t) => ({ ...t, applied: false }))] });
      setNotice(selected.length ? `Shared rules saved and applied to both engines in ${selected.length} project${selected.length === 1 ? '' : 's'}. Restart running sessions to load them.` : 'Shared rules saved locally. Apply them to a project before starting its sessions.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Rules could not be saved.'); }
    finally { setBusy(false); }
  }

  return <section className="feature-panel hub-panel rules-panel">
    <div className="feature-panel-heading"><span className="eyebrow">ONE SET OF EXPECTATIONS</span><h1><ShieldCheck size={28} />Shared rules</h1><p>Write once. Apply the same project instructions to Claude Code and Codex.</p></div>
    <div className="hub-toolbar"><span className="rules-state">{dirty ? 'Unsaved changes' : snapshot ? 'Saved rules loaded' : 'Loading rules…'}</span><button className="button secondary" disabled={busy} onClick={() => dirty ? setConfirmReload(true) : void reload()}><RefreshCw size={14} />Reload saved rules</button><button className="button secondary" disabled={busy || !snapshot} onClick={() => void addProject()}><FolderOpen size={14} />Add project</button><button className="button primary" disabled={busy || !snapshot} onClick={() => void save()}><Save size={14} />Save and apply</button></div>
    {confirmReload && <div className="hub-warning">Reloading replaces your unsaved draft. <button className="button secondary" onClick={() => void reload()} disabled={busy}>Discard draft and reload</button><button className="quiet-button" onClick={() => setConfirmReload(false)}>Keep editing</button></div>}
    {error && <div className="hub-feedback error-message" role="alert">{error}</div>}{notice && <div className="hub-feedback success" role="status"><Check size={15} />{notice}</div>}
    <div className="rules-columns"><article className="hub-form"><header className="rules-editor-header"><div><h2>Your shared instructions</h2><span className="muted">Stable expectations for all selected projects</span></div><button className="quiet-button" disabled={busy || !!content.trim()} onClick={() => setContent(EXAMPLE)}>Use example rules</button></header><label htmlFor="shared-rules-editor">Rules for both engines</label><textarea id="shared-rules-editor" className="rules-editor" rows={18} maxLength={60000} value={content} disabled={busy || !snapshot} onChange={(e) => setContent(e.target.value)} placeholder={'Describe coding conventions, test requirements, approval boundaries, and handoff expectations.\n\nExample: Run relevant tests and report anything you could not verify.'} /><span className="muted">{content.length.toLocaleString()} / 60,000 characters · Markdown text</span><p>Save and apply replaces only Trace’s marked shared-rules section. Clearing the editor removes that section from selected projects.</p></article>
      <div><article className="hub-form rules-targets"><h2>Apply to projects</h2><p>Each selected directory receives the same rules in both <code>CLAUDE.md</code> and <code>AGENTS.md</code>. Existing text and shared-memory instructions stay intact.</p>{snapshot?.targets.length ? snapshot.targets.map((target) => <label className="rules-target" key={target.directory}><input type="checkbox" checked={selected.includes(target.directory)} disabled={busy || !!target.error} onChange={(e) => setSelected(e.target.checked ? [...selected, target.directory] : selected.filter((d) => d !== target.directory))} /><span><code>{target.directory}</code><small className={target.error ? 'error-message' : ''}>{target.error ?? (target.applied && !dirty ? 'Current rules applied to both engines' : 'Needs current rules applied')}</small></span></label>) : <p>No project selected. Open a workspace or add a project. You can save a local rule draft first.</p>}</article>
      <article className="hub-form"><h2>When they take effect</h2><p>Restart running sessions after applying changes. When rules are set, the app checks that both engines’ instruction files contain the current version before starting a session.</p><p>Rules guide the agents; tests, CLI permissions, hooks, and CI enforce conditions mechanically. Higher-priority and more specific engine instructions still affect behavior.</p><button className="button secondary" onClick={() => useWorkspaceStore.setState({ activeView: 'help', helpTopicId: 'rules' })}>Read the rules guide</button></article></div></div>
  <ProjectValidation directories={[...new Set([...workspaceDirectories, ...(snapshot?.directories ?? [])])]} /></section>;
}
