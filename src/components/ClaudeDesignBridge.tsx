import { useState } from 'react';
import { ArrowDownToLine, FolderInput, PackageOpen, RefreshCw } from 'lucide-react';
import type { DesignSnapshot, HandoffResult } from '../../shared/design';
import { arrangeTiles, createSession, useWorkspaceStore } from '../state/workspace-store';

/** Opens an idle Claude Code tile in the project with a request the user sends once the CLI is ready. */
function openClaudeTile(directory: string, title: string, prompt: string, label: string, showWorkspace = true) {
  const state = useWorkspaceStore.getState();
  if (state.sessions.length >= 4) throw new Error('Close an idle session tile to make room for a Claude Design session.');
  const session = createSession('claude', { mode: 'independent', cwd: directory }); session.title = title;
  session.preparedRequest = { prompt, label };
  const sessions = [...state.sessions, session];
  useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid', focusedSessionId: null, ...(showWorkspace ? { activeView: 'workspace' as const } : {}) });
}

/** Claude Design lives on claude.ai; Claude Code's /design and /design-sync commands connect it to a project. */
export function ClaudeDesignBridge({ projectDirectory, onImported }: { projectDirectory: string | null; onImported: (snapshot: DesignSnapshot | null) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const run = (action: () => void | Promise<void>) => void (async () => { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Claude Design action failed.'); } finally { setBusy(false); } })();
  const needProject = () => { if (!projectDirectory) throw new Error('Choose a project folder first (Projects, or the folder picker in the top bar).'); return projectDirectory; };
  async function importBundle(source: 'zip' | 'folder') {
    const directory = needProject();
    if (!window.codingHub) throw new Error('Bundle import requires the desktop app.');
    const result = await window.codingHub.designs({ action: 'handoff-import', source, projectDirectory: directory });
    if (!result.ok) throw new Error(result.error.message);
    const bundle = result.value as HandoffResult | null; if (!bundle) return;
    onImported(bundle.snapshot);
    const start = bundle.readme ? `Start with ${bundle.readme}.` : 'Start by listing its files.';
    openClaudeTile(directory, 'Claude · design handoff', `Implement the Claude Design handoff bundle in ${bundle.relative}/. ${start} Build it into this project using its existing framework, components and conventions. Ask before adding dependencies or changing unrelated files.`, 'Send design handoff', false);
    setNotice(`Copied ${bundle.files} files to ${bundle.relative}/${bundle.snapshot ? ' and saved a preview in the archive' : ''}. A Claude tile is ready: use Show sessions, start it, then send the handoff.${bundle.warning ? ' ' + bundle.warning : ''}`);
  }
  return <article className="storage-card claude-design-bridge">
    <h2>Claude Design</h2>
    <p>Move work between Claude Design (claude.ai) and this project with Claude Code. Each button opens a Claude tile in the current project; start it, finish any sign-in or trust prompts, then press the send button on the tile.</p>
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="control-note" role="status">{notice}</p>}
    <div className="hub-toolbar">
      <button className="button secondary" disabled={busy} onClick={() => run(() => openClaudeTile(needProject(), 'Claude · design import', '/design import', 'Run /design import'))}><ArrowDownToLine size={14} />Bring a design into code</button>
      <button className="button secondary" disabled={busy} onClick={() => run(() => openClaudeTile(needProject(), 'Claude · design sync', '/design-sync', 'Run /design-sync'))}><RefreshCw size={14} />Sync design system</button>
      <button className="button secondary" disabled={busy} onClick={() => run(() => importBundle('zip'))}><PackageOpen size={14} />Import handoff bundle (.zip)</button>
      <button className="button secondary" disabled={busy} onClick={() => run(() => importBundle('folder'))}><FolderInput size={14} />Import handoff folder</button>
    </div>
    <small className="control-note">Requires Claude Code signed in with a claude.ai Pro, Max, Team or Enterprise account (not an API key). The first use opens your browser to authorize Claude Design. Handoff bundles are copied into the project's design-handoff folder; review them before committing.</small>
  </article>;
}
