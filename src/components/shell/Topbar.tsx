import { CircleHelp, Columns2, Grid2X2, PanelLeft, Rows2, SlidersHorizontal } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { CommandMenu } from '../CommandMenu';
import { MenuButton, type MenuItem } from './MenuButton';

/** Daily views sit in the tab row; the rest are one menu away, grouped by how often they are used. */
export const PRIMARY_VIEWS: { view: NavigationView; label: string }[] = [{ view: 'workspace', label: 'Workspace' }, { view: 'diff', label: 'Changes' }, { view: 'projects', label: 'Projects' }];
export const INSIGHT_VIEWS: { view: NavigationView; label: string }[] = [
  { view: 'usage', label: 'Usage' }, { view: 'history', label: 'Session history' }, { view: 'files', label: 'Files' }, { view: 'tasks', label: 'Task coordination' },
  { view: 'verification', label: 'Verification profiles' }, { view: 'design', label: 'Design workspace' }, { view: 'coaching', label: 'AI coaching' },
];
export const SETUP_VIEWS: { view: NavigationView; label: string }[] = [
  { view: 'accounts', label: 'Accounts & connections' }, { view: 'memory', label: 'Shared memory' }, { view: 'rules', label: 'Shared rules' }, { view: 'connectors', label: 'MCP servers' },
  { view: 'skills', label: 'Skills & plugins' }, { view: 'settings', label: 'Settings' }, { view: 'workflow', label: 'Workflow center' },
];

/** Opens the native folder picker; the browser preview uses the typed path in Projects. */
export async function openProjectFolder() {
  const state = useWorkspaceStore.getState();
  if (!window.codingHub) { state.setView('projects'); return; }
  const selected = await window.codingHub.pickDirectory();
  if (selected) state.setRootDirectory(selected);
}

/** Four bars in the channel colours: two for Claude (CH1 yellow), two for Codex (CH2 cyan). */
function Wordmark() {
  return <a className="tr-wordmark" href="#workspace" aria-label="Trace home" onClick={(event) => { event.preventDefault(); useWorkspaceStore.getState().setView('workspace'); }}>
    <span className="tr-wordmark-bars" aria-hidden="true"><i style={{ height: 6 }} /><i style={{ height: 14 }} /><i style={{ height: 9 }} /><i style={{ height: 4 }} /></span><span className="tr-wordmark-text">trace</span>
  </a>;
}

export function Topbar({ explorer, onToggleExplorer }: { explorer: boolean; onToggleExplorer: () => void }) {
  const { activeView, setView, rootDirectory, sessions, layoutMode, arrange, addSession } = useWorkspaceStore();
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const toItems = (views: { view: NavigationView; label: string }[]): MenuItem[] => views.map(({ view, label }) => ({ label, current: activeView === view, onSelect: () => setView(view) }));
  const insight = INSIGHT_VIEWS.find((item) => item.view === activeView);
  const setupActive = SETUP_VIEWS.some((item) => item.view === activeView);
  return <header className="tr-topbar">
    <Wordmark />
    {project
      ? <MenuButton className="tr-project" ariaLabel={`Project ${project}`} label={<span className="tr-project-name" title={rootDirectory ?? undefined}>{project}</span>} items={[{ label: 'Change project', onSelect: () => void openProjectFolder() }, { label: 'Manage projects', onSelect: () => setView('projects') }]} />
      : <button className="tr-project tr-menu-button" onClick={() => void openProjectFolder()}>Open project</button>}
    <nav className="tr-tabs" aria-label="Main views">
      {PRIMARY_VIEWS.map(({ view, label }) => <button key={view} className={activeView === view ? 'active' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setView(view)}>{label}</button>)}
    </nav>
    <span className="tr-divider" aria-hidden="true" />
    <MenuButton ariaLabel="Insight views" active={Boolean(insight)} label={<span className="tr-menu-label">{insight?.label ?? 'Insight'}</span>} items={toItems(INSIGHT_VIEWS)} />
    <span className="tr-spacer" />
    {activeView === 'workspace' && <div className="tr-segmented" role="group" aria-label="Grid arrangement">
      <button className={explorer ? 'active' : ''} aria-label={explorer ? 'Hide explorer' : 'Show explorer'} title={explorer ? 'Hide explorer' : 'Show explorer'} aria-pressed={explorer} onClick={onToggleExplorer}><PanelLeft size={14} /></button>
      {[{ mode: 'columns' as const, icon: Columns2, label: 'Split vertically: columns' }, { mode: 'rows' as const, icon: Rows2, label: 'Split horizontally: rows' }, { mode: 'grid' as const, icon: Grid2X2, label: 'Arrange in grid' }].map(({ mode, icon: Icon, label }) =>
        <button key={mode} className={layoutMode === mode ? 'active' : ''} aria-label={label} title={label} aria-pressed={layoutMode === mode} onClick={() => arrange(mode)}><Icon size={14} /></button>)}
    </div>}
    <CommandMenu />
    <button className="tr-icon" aria-label="Open help" title="Help & AI guide" onClick={() => setView('help')}><CircleHelp size={16} /></button>
    <MenuButton ariaLabel="Agent setup" active={setupActive} label={<><SlidersHorizontal className="tr-narrow-icon" size={14} aria-hidden="true" /><span className="tr-wide-label">Agent setup</span></>} items={toItems(SETUP_VIEWS)} />
    <MenuButton className="tr-new-channel" ariaLabel="New channel" disabled={sessions.length >= 4} label={<>+<span className="tr-wide-label">Channel</span></>} items={[{ label: 'Claude Code', onSelect: () => addSession('claude') }, { label: 'Codex CLI', onSelect: () => addSession('codex') }]} />
  </header>;
}
