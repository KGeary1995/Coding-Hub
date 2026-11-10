import { startRoundTable } from '../../runtime/round-table';
import { addLinkedChannel, useLinkedStore, waitingOn } from '../../state/linked-store';
import { CircleHelp, Columns2, Grid2X2, Monitor, PanelLeft, Rows2, SlidersHorizontal } from 'lucide-react';
import { channelsFullNote, channelsOf, useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { CommandMenu } from '../CommandMenu';
import { MenuButton, type MenuItem } from './MenuButton';
import { MAX_CHANNELS } from '../../../shared/schemas';

/** Daily views sit in the tab row; the rest are one menu away, grouped by how often they are used. */
export const PRIMARY_VIEWS: { view: NavigationView; label: string }[] = [{ view: 'workspace', label: 'Workspace' }, { view: 'diff', label: 'Changes' }, { view: 'tasks', label: 'Tasks' }, { view: 'projects', label: 'Projects' }];
export const INSIGHT_VIEWS: { view: NavigationView; label: string }[] = [
  { view: 'usage', label: 'Usage' }, { view: 'history', label: 'Session history' }, { view: 'files', label: 'Files' }, { view: 'tools', label: 'More tools' },
];
/** Rarely used tools, listed on the More tools page instead of in the menus. */
export const MORE_TOOLS: { view: NavigationView; label: string; detail: string }[] = [
  { view: 'coaching', label: 'AI coaching', detail: 'Prompt examples, usage trends and A/B wording experiments, with an optional coaching report from an agent.' },
  { view: 'verification', label: 'Verification profiles', detail: 'Saved test and lint commands for a project, and their recorded results.' },
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
    {/* The app icon's keycap (scripts/make-icon.cjs, its 32 px drawing): amber face on a darker lip, the T cut through both. */}
    <svg className="tr-wordmark-reticle" width="20" height="20" viewBox="34 33 188 188" aria-hidden="true"><path transform="translate(0 16)" fillRule="evenodd" fill="#b9700f" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 50H180A8 8 0 0 1 188 58V78A8 8 0 0 1 180 86H154A6 6 0 0 0 148 92V150A8 8 0 0 1 140 158H116A8 8 0 0 1 108 150V92A6 6 0 0 0 102 86H76A8 8 0 0 1 68 78V58A8 8 0 0 1 76 50Z" /><path fillRule="evenodd" fill="#ffb547" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 66H180A8 8 0 0 1 188 74V94A8 8 0 0 1 180 102H154A6 6 0 0 0 148 108V166A8 8 0 0 1 140 174H116A8 8 0 0 1 108 166V108A6 6 0 0 0 102 102H76A8 8 0 0 1 68 94V74A8 8 0 0 1 76 66Z" /></svg><span className="tr-wordmark-text">trace</span>
  </a>;
}

export function Topbar({ explorer, onToggleExplorer }: { explorer: boolean; onToggleExplorer: () => void }) {
  const { activeView, setView, rootDirectory, sessions, layoutMode, arrange, addSession } = useWorkspaceStore();
  const linkedComputers = useLinkedStore((state) => state.computers); const computerId = useWorkspaceStore((state) => state.computerId);
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const toItems = (views: { view: NavigationView; label: string }[]): MenuItem[] => views.map(({ view, label }) => ({ label, current: activeView === view, onSelect: () => setView(view) }));
  const insight = INSIGHT_VIEWS.find((item) => item.view === activeView) ?? (MORE_TOOLS.some((item) => item.view === activeView) ? INSIGHT_VIEWS.find((item) => item.view === 'tools') : undefined);
  const setupActive = SETUP_VIEWS.some((item) => item.view === activeView);
  // Each channel is its own CLI process; past four, say so where the next one is added.
  // On a linked computer's tab, + Channel adds the channel on that computer (chat channels are answered only there).
  const other = activeView === 'computer' ? linkedComputers.find((item) => item.id === computerId) : undefined;
  const channelMenu: MenuItem[] = other
    ? (['claude', 'codex', 'shell'] as const).map((engine) => ({ label: { claude: 'Claude Code', codex: 'Codex CLI', shell: 'Terminal' }[engine], onSelect: () => void addLinkedChannel(other.id, engine) }))
    : [{ label: 'Claude Code', onSelect: () => addSession('claude') }, { label: 'Claude chat', onSelect: () => useWorkspaceStore.getState().addChatSession('claude') }, { label: 'Codex chat', onSelect: () => useWorkspaceStore.getState().addChatSession('codex') }, { label: 'Codex CLI', onSelect: () => addSession('codex') }, { label: 'Terminal', onSelect: () => addSession('shell') },
      ...(sessions.length <= MAX_CHANNELS - 2 ? [{ label: 'Round Table', onSelect: () => void startRoundTable().then((error) => { if (error) useWorkspaceStore.getState().setSessionError(channelsOf(useWorkspaceStore.getState().sessions).at(-1)?.id ?? '', error, true); }) }] : [])];
  return <header className="tr-topbar">
    <Wordmark />
    {project
      ? <MenuButton className="tr-project" ariaLabel={`Project ${project}`} label={<span className="tr-project-name" title={rootDirectory ?? undefined}>{project}</span>} items={[{ label: 'Change project', onSelect: () => void openProjectFolder() }, { label: 'Manage projects', onSelect: () => setView('projects') }]} />
      : <button className="tr-project tr-menu-button" onClick={() => void openProjectFolder()}>Open project</button>}
    <nav className="tr-tabs" aria-label="Main views">
      {PRIMARY_VIEWS.map(({ view, label }) => <button key={view} className={activeView === view ? 'active' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setView(view)}>{label}</button>)}
      {linkedComputers.filter((computer) => computer.linked).map((computer) => { const current = activeView === 'computer' && computerId === computer.id; const waiting = waitingOn(computer);
        return <button key={computer.id} className={`tr-computer-tab ${current ? 'active' : ''} ${computer.connected ? '' : 'offline'}`} aria-current={current ? 'page' : undefined} title={computer.connected ? `${computer.name}: ${computer.channels.length} channels` : `${computer.name}: not connected`} onClick={() => useWorkspaceStore.setState({ computerId: computer.id, activeView: 'computer' })}>
          <Monitor size={13} aria-hidden="true" />{computer.name}{waiting > 0 && <span className="tr-tab-badge" aria-label={`${waiting} waiting`}>{waiting}</span>}</button>; })}
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
    <MenuButton className="tr-new-channel" ariaLabel="New channel" title={!other && sessions.length >= MAX_CHANNELS ? channelsFullNote(sessions) ?? undefined : undefined} disabled={other ? !other.connected || other.channels.length >= MAX_CHANNELS : sessions.length >= MAX_CHANNELS} label={<>+<span className="tr-wide-label">Channel</span></>} items={channelMenu} />
  </header>;
}
