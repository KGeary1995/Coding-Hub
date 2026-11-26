import { useEffect, useState } from 'react';
import { CircleAlert, Cpu, Folder, FolderOpen, FolderPlus, Github, History, type LucideIcon } from 'lucide-react';
import type { AccountConnection } from '../../../shared/accounts';
import type { SessionHistoryRun } from '../../../shared/types';
import { useWorkspaceStore } from '../../state/workspace-store';
import { openProject } from '../../state/projects';
import { openProjectFolder } from '../shell/Topbar';
import { MOD_KEY } from '../platform';
import { TraceMark } from '../shell/TraceMark';
import { ENGINE_ICONS } from '../tile/engine-icons';

const SETUP_KEY = 'coding-hub-setup-complete';
const absolute = (directory: string) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(directory);
const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;

/** True until a project (or a channel's own folder) is chosen, unless the person skipped setup. */
export function useProjectSetup() {
  const { rootDirectory, sessions } = useWorkspaceStore();
  const [skipped, setSkipped] = useState(() => { try { return localStorage.getItem(SETUP_KEY) === 'true'; } catch { return false; } });
  const hasProject = Boolean(rootDirectory || sessions.some((session) => session.binding.mode === 'independent' && absolute(session.binding.cwd)));
  const skip = () => { setSkipped(true); try { localStorage.setItem(SETUP_KEY, 'true'); } catch { /* This window still skips. */ } };
  useEffect(() => { if (hasProject && !skipped) skip(); }, [hasProject, skipped]);
  return { needsProject: !hasProject && !skipped, skip };
}

/** "x min ago" for the last activity in a recent project. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60); if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24); return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Folders of recorded runs, newest first, one row each. */
export function recentProjects(runs: SessionHistoryRun[], limit = 5) {
  const latest = new Map<string, string>();
  for (const run of runs) if (run.cwd && absolute(run.cwd) && (latest.get(run.cwd) ?? '') < run.startedAt) latest.set(run.cwd, run.startedAt);
  return [...latest].sort((a, b) => b[1].localeCompare(a[1])).slice(0, limit).map(([directory, at]) => ({ directory, at }));
}

const ENGINE_NAMES: Record<AccountConnection['provider'], string> = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini', github: 'GitHub CLI' };
/** The same marks and tones as the new-channel menu (Topbar.tsx); GitHub is not an engine, so it stays neutral. */
const ENGINE_MARKS: Record<AccountConnection['provider'], { icon: LucideIcon; tone: string }> = { claude: { icon: ENGINE_ICONS.claude, tone: 'claude' }, codex: { icon: ENGINE_ICONS.codex, tone: 'codex' }, gemini: { icon: ENGINE_ICONS.gemini, tone: 'gemini' }, github: { icon: Github, tone: 'neutral' } };

/** Workspace with no project: a centred welcome with the ways in, then recent folders and what is installed. */
export function EmptyWorkspace({ onSkip }: { onSkip: () => void }) {
  const { setView } = useWorkspaceStore();
  /** null while loading; the browser preview has no history, so it starts empty. */
  const [recent, setRecent] = useState<{ directory: string; at: string }[] | null>(() => window.codingHub ? null : []);
  const [engines, setEngines] = useState<AccountConnection[] | null>(null);
  /** A failed read is shown as one, not left looking like "still checking" or "nothing here". */
  const [recentError, setRecentError] = useState(''); const [enginesError, setEnginesError] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const failed = (set: (message: string) => void) => (cause: unknown) => { if (live) set(cause instanceof Error ? cause.message : 'Trace could not read it.'); };
    void window.codingHub?.listHistory().then((result) => { if (!live) return; if (result.ok) setRecent(recentProjects(result.value)); else setRecentError(result.error.message); }).catch(failed(setRecentError));
    void window.codingHub?.accounts({ action: 'status' }).then((result) => { if (!live) return; if (result.ok) setEngines(result.value as AccountConnection[]); else setEnginesError(result.error.message); }).catch(failed(setEnginesError));
    return () => { live = false; };
  }, []);
  const open = () => { setError(''); openProjectFolder().catch(() => setError('The folder picker could not open. Try again, or enter a path in Projects.')); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o' && !event.shiftKey) { event.preventDefault(); open(); }
      else if (key === 'n' && event.shiftKey) { event.preventDefault(); setView('projects'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const github = engines?.find((item) => item.provider === 'github');
  const githubReady = github?.state === 'authenticated';
  return <section className="tr-empty" aria-labelledby="tr-empty-title">
    <div className="tr-start-welcome">
      <span className="tr-start-mark" aria-hidden="true"><TraceMark size={48} /></span>
      <h1 id="tr-empty-title">Open a project</h1>
      <p className="tr-start-lead">Every channel runs inside a local folder.</p>
      <div className="ui-actions tr-start-actions">
        <button className="button primary large" onClick={open}><FolderOpen size={16} aria-hidden="true" />Open folder</button>
        <button className="button large" onClick={() => setView('projects')}><Github size={16} aria-hidden="true" />Clone from GitHub{github && !githubReady && <span className="ui-badge warning">Sign-in needed</span>}</button>
        <button className="button large" onClick={() => setView('projects')}><FolderPlus size={16} aria-hidden="true" />New project</button>
      </div>
      <p className="tr-start-keys"><span><kbd>{MOD_KEY} O</kbd> Open folder</span><span><kbd>{MOD_KEY} ⇧ N</kbd> New project</span></p>
      {error && <div role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
    </div>
    <div className="ui-grid">
      <section className="ui-card span-6" aria-labelledby="tr-recent-title">
        <div className="ui-card-head"><History aria-hidden="true" /><h2 id="tr-recent-title">Recent projects</h2>{!!recent?.length && <span className="ui-count neutral">{recent.length}</span>}</div>
        {recentError ? <div className="ui-empty danger" role="alert"><CircleAlert aria-hidden="true" /><h3>Recent projects unavailable</h3><p>{recentError}</p></div>
          : !recent ? <div className="ui-empty" role="status"><History aria-hidden="true" /><h3>Loading recent projects</h3><p>Looking for folders you ran channels in.</p></div>
          : recent.length ? <ul className="ui-list">{recent.map(({ directory, at }) => <li key={directory}><button className="ui-row" onClick={() => openProject(directory)} title={`Open ${directory}`}><span className="ui-avatar neutral" aria-hidden="true"><Folder /></span><span className="ui-row-main"><strong>{folderName(directory)}</strong><small className="tr-row-path">{directory}</small></span><small className="tr-row-meta">{ago(at)}</small></button></li>)}</ul>
          : <div className="ui-empty"><History aria-hidden="true" /><h3>No recent projects</h3><p>Folders you run channels in appear here.</p></div>}
      </section>
      <section className="ui-card span-6" aria-labelledby="tr-engines-title">
        <div className="ui-card-head"><Cpu aria-hidden="true" /><h2 id="tr-engines-title">Engines on this computer</h2></div>
        {engines ? <ul className="ui-list">{engines.map((item) => { const { icon: Mark, tone } = ENGINE_MARKS[item.provider]; return <li key={item.provider} className="ui-row tr-engine-row">
          <span className={`ui-avatar ${tone}`} aria-hidden="true"><Mark /></span>
          <span className="ui-row-main"><strong>{ENGINE_NAMES[item.provider]}</strong><small>{item.installed ? item.version ?? 'Installed' : 'Not installed'}</small></span>
          {item.state === 'authenticated' ? <span className="ui-badge success dot">Signed in</span> : <button className="button small" onClick={() => setView('accounts')} aria-label={`Sign in to ${ENGINE_NAMES[item.provider]}`}>{item.installed ? 'Sign in' : 'Set up'}</button>}
        </li>; })}</ul>
          : enginesError ? <div className="ui-empty danger" role="alert"><CircleAlert aria-hidden="true" /><h3>Engines not checked</h3><p>{enginesError}</p><button className="button secondary" onClick={() => setView('accounts')}>Open Accounts & connections</button></div>
          : window.codingHub ? <div className="ui-empty" role="status"><Cpu aria-hidden="true" /><h3>Checking engines</h3><p>Looking for Claude Code, Codex, Gemini and GitHub CLI.</p></div>
          : <div className="ui-empty"><Cpu aria-hidden="true" /><h3>Engines not checked</h3><p>The desktop app checks local CLIs.</p></div>}
      </section>
    </div>
    <button className="quiet-button tr-empty-skip" onClick={onSkip}>Use channels without a project</button>
  </section>;
}
