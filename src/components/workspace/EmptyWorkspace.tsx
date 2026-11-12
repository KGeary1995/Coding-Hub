import { useEffect, useState } from 'react';
import type { AccountConnection } from '../../../shared/accounts';
import type { SessionHistoryRun } from '../../../shared/types';
import { useWorkspaceStore } from '../../state/workspace-store';
import { openProjectFolder } from '../shell/Topbar';

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

const ENGINE_NAMES: Record<AccountConnection['provider'], string> = { claude: 'Claude Code', codex: 'Codex CLI', github: 'GitHub CLI' };

/** Workspace with no project: a scope with no signal, three ways in, recent folders and what is installed (sheet 03). */
export function EmptyWorkspace({ onSkip }: { onSkip: () => void }) {
  const { setRootDirectory, setView } = useWorkspaceStore();
  const [recent, setRecent] = useState<{ directory: string; at: string }[]>([]);
  const [engines, setEngines] = useState<AccountConnection[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.codingHub?.listHistory().then((result) => { if (live && result.ok) setRecent(recentProjects(result.value)); }).catch(() => {});
    void window.codingHub?.accounts({ action: 'status' }).then((result) => { if (live && result.ok) setEngines(result.value as AccountConnection[]); }).catch(() => {});
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
    <div className="tr-nosignal" aria-hidden="true"><span className="tr-nosignal-line" /><span className="tr-nosignal-tag">CH— · no signal</span><span className="tr-nosignal-hint">open a project to arm a channel</span></div>
    <h1 id="tr-empty-title">Open a project</h1>
    <p className="tr-empty-sub">Every channel runs inside a local folder.</p>
    <div className="tr-keys">
      <button className="tr-key primary" onClick={open}><span className="tr-key-meta"><span>01</span><kbd>Ctrl O</kbd></span><strong>Open folder</strong><span className="tr-key-sub">A folder on this computer, with or without Git</span></button>
      <button className="tr-key" onClick={() => setView('projects')}><span className="tr-key-meta"><span>02</span>{github && !githubReady && <span className="tr-key-warn">▲ GitHub sign-in needed</span>}</span><strong>Clone from GitHub</strong><span className="tr-key-sub">Pick one of your repositories</span></button>
      <button className="tr-key" onClick={() => setView('projects')}><span className="tr-key-meta"><span>03</span><kbd>Ctrl ⇧ N</kbd></span><strong>New project</strong><span className="tr-key-sub">Create a folder and optionally a Git repository</span></button>
    </div>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="tr-empty-columns">
      <section aria-labelledby="tr-recent-title">
        <h2 id="tr-recent-title">Recent projects</h2>
        {recent.length ? <ul className="tr-rows">{recent.map(({ directory, at }) => <li key={directory}><button className="tr-row" onClick={() => setRootDirectory(directory)} title={`Open ${directory}`}><strong>{folderName(directory)}</strong><span className="tr-row-path">{directory}</span><span className="tr-row-meta">{ago(at)}</span></button></li>)}</ul>
          : <p className="tr-empty-note">Folders you run channels in appear here.</p>}
      </section>
      <section aria-labelledby="tr-engines-title">
        <h2 id="tr-engines-title">Engines on this machine</h2>
        {engines ? <ul className="tr-rows">{engines.map((item) => <li key={item.provider} className="tr-engine-row">
          <span><strong>{ENGINE_NAMES[item.provider]}</strong><span className="tr-row-path">{item.installed ? item.version ?? 'installed' : 'not installed'}</span></span>
          {item.state === 'authenticated' ? <span className="tr-ok">✓ signed in</span> : <button className="tr-signin" onClick={() => setView('accounts')} aria-label={`Sign in to ${ENGINE_NAMES[item.provider]}`}>{item.installed ? 'Sign in' : 'Set up'}</button>}
        </li>)}</ul> : <p className="tr-empty-note">{window.codingHub ? 'Checking local CLIs…' : 'The desktop app checks local CLIs.'}</p>}
      </section>
    </div>
    <button className="quiet-button tr-empty-skip" onClick={onSkip}>Use channels without a project</button>
  </section>;
}
