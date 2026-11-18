import { useShallow } from 'zustand/react/shallow';
import { startHierarchyTable, startRoundTable } from '../../runtime/round-table';
import { addLinkedChannel, useLinkedStore, waitingOn } from '../../state/linked-store';
import { Asterisk, BookOpen, Cable, ChartColumn, CircleHelp, CircleUserRound, Columns2, Files, Folder, FolderCog, FolderOpen, Grid2X2, History, LayoutGrid, Monitor, Network, PanelLeft, Plus, Rows2, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, SquareChevronRight, TerminalSquare, UsersRound, Workflow, type LucideIcon } from 'lucide-react';
import { channelsFullNote, channelsOf, useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { CommandMenu } from '../CommandMenu';
import { MenuButton, type MenuItem } from './MenuButton';
import { MAX_CHANNELS } from '../../../shared/schemas';

/** Daily views sit in the tab row; the rest are one menu away, grouped by how often they are used. */
export const PRIMARY_VIEWS: { view: NavigationView; label: string }[] = [{ view: 'workspace', label: 'Workspace' }, { view: 'diff', label: 'Changes' }, { view: 'tasks', label: 'Tasks' }, { view: 'projects', label: 'Projects' }];
/** `icon` is the view's own: its menu entry shows it, and its page heading should show the same one. */
export const INSIGHT_VIEWS: { view: NavigationView; label: string; icon: LucideIcon }[] = [
  { view: 'usage', label: 'Usage', icon: ChartColumn }, { view: 'history', label: 'Session history', icon: History }, { view: 'files', label: 'Files', icon: Files }, { view: 'tools', label: 'More tools', icon: LayoutGrid },
];
/** Rarely used tools, listed on the More tools page instead of in the menus. */
export const MORE_TOOLS: { view: NavigationView; label: string; detail: string }[] = [
  { view: 'coaching', label: 'AI coaching', detail: 'Prompt examples, usage trends and A/B wording experiments, with an optional coaching report from an agent.' },
  { view: 'verification', label: 'Verification profiles', detail: 'Saved test and lint commands for a project, and their recorded results.' },
];
export const SETUP_VIEWS: { view: NavigationView; label: string; icon: LucideIcon }[] = [
  { view: 'accounts', label: 'Accounts & connections', icon: CircleUserRound }, { view: 'memory', label: 'Shared memory', icon: BookOpen }, { view: 'rules', label: 'Shared rules', icon: ShieldCheck }, { view: 'connectors', label: 'MCP servers', icon: Cable },
  { view: 'skills', label: 'Skills & plugins', icon: Sparkles }, { view: 'settings', label: 'Settings', icon: Settings2 }, { view: 'workflow', label: 'Workflow center', icon: Workflow },
];
/** What + Channel adds, each with its avatar: an engine's is the one its tile shows. */
const CHANNEL_KINDS = {
  shell: { label: 'Terminal', icon: SquareChevronRight, tone: 'shell' }, claude: { label: 'Claude Code', icon: Asterisk, tone: 'claude' }, codex: { label: 'Codex', icon: TerminalSquare, tone: 'codex' },
  table: { label: 'Round Table', icon: UsersRound, tone: 'you' }, hierarchy: { label: 'Round Table (hierarchy)', icon: Network, tone: 'planner' },
} as const;
const channelItem = (kind: keyof typeof CHANNEL_KINDS, onSelect: () => void): MenuItem => { const { label, icon: Icon, tone } = CHANNEL_KINDS[kind]; return { label, icon: <span className={`ui-avatar small ${tone}`} aria-hidden="true"><Icon /></span>, onSelect }; };

/** Opens the native folder picker; the browser preview uses the typed path in Projects. */
export async function openProjectFolder() {
  const state = useWorkspaceStore.getState();
  if (!window.codingHub) { state.setView('projects'); return; }
  const selected = await window.codingHub.pickDirectory();
  if (selected) state.setRootDirectory(selected);
}

/** The keycap and the name; it leads back to the workspace. */
function Wordmark() {
  return <a className="tr-wordmark" href="#workspace" aria-label="Trace home" onClick={(event) => { event.preventDefault(); useWorkspaceStore.getState().setView('workspace'); }}>
    {/* The app icon's keycap (scripts/make-icon.cjs, its 32 px drawing): amber face on a darker lip, the T cut through both. shell.css colours the two. */}
    <svg className="tr-keycap" width="20" height="20" viewBox="34 33 188 188" aria-hidden="true"><path className="tr-keycap-lip" transform="translate(0 16)" fillRule="evenodd" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 50H180A8 8 0 0 1 188 58V78A8 8 0 0 1 180 86H154A6 6 0 0 0 148 92V150A8 8 0 0 1 140 158H116A8 8 0 0 1 108 150V92A6 6 0 0 0 102 86H76A8 8 0 0 1 68 78V58A8 8 0 0 1 76 50Z" /><path className="tr-keycap-face" fillRule="evenodd" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 66H180A8 8 0 0 1 188 74V94A8 8 0 0 1 180 102H154A6 6 0 0 0 148 108V166A8 8 0 0 1 140 174H116A8 8 0 0 1 108 166V108A6 6 0 0 0 102 102H76A8 8 0 0 1 68 94V74A8 8 0 0 1 76 66Z" /></svg><span className="tr-wordmark-text">Trace</span>
  </a>;
}

/**
 * A Round Table that could not open: the error goes on its tile (the newest channel). Marked a failed launch only when
 * that channel is not running: the Claude chat that did start keeps its Stop, so it is never hidden while it runs.
 */
function tableFailed(error: string) {
  const tile = channelsOf(useWorkspaceStore.getState().sessions).at(-1); if (!tile) return;
  useWorkspaceStore.getState().setSessionError(tile.id, error, tile.status !== 'running' && tile.status !== 'starting');
}
export function Topbar({ explorer, onToggleExplorer }: { explorer: boolean; onToggleExplorer: () => void }) {
  const { activeView, setView, rootDirectory, sessions, layoutMode, arrange, addSession } = useWorkspaceStore(useShallow((s) => ({ activeView: s.activeView, setView: s.setView, rootDirectory: s.rootDirectory, sessions: s.sessions, layoutMode: s.layoutMode, arrange: s.arrange, addSession: s.addSession })));
  const linkedComputers = useLinkedStore((state) => state.computers); const computerId = useWorkspaceStore((state) => state.computerId);
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const toItems = (views: { view: NavigationView; label: string; icon: LucideIcon }[]): MenuItem[] => views.map(({ view, label, icon: Icon }) => ({ label, icon: <Icon size={16} aria-hidden="true" />, current: activeView === view, onSelect: () => setView(view) }));
  const insight = INSIGHT_VIEWS.find((item) => item.view === activeView) ?? (MORE_TOOLS.some((item) => item.view === activeView) ? INSIGHT_VIEWS.find((item) => item.view === 'tools') : undefined);
  const setupActive = SETUP_VIEWS.some((item) => item.view === activeView);
  // Each channel is its own CLI process; past four, say so where the next one is added.
  // On a linked computer's tab, + Channel adds the channel on that computer (chat channels are answered only there).
  // The order is the person's: Terminal, Claude Code, Codex, then the Round Tables (on the phone too).
  const other = activeView === 'computer' ? linkedComputers.find((item) => item.id === computerId) : undefined;
  const channelMenu: MenuItem[] = other
    ? (['shell', 'claude', 'codex'] as const).map((engine) => channelItem(engine, () => void addLinkedChannel(other.id, engine)))
    : [...(['shell', 'claude', 'codex'] as const).map((engine) => channelItem(engine, () => addSession(engine))),
      ...(sessions.length <= MAX_CHANNELS - 2 ? [channelItem('table', () => void startRoundTable().then((error) => { if (error) tableFailed(error); }))] : []),
      ...(sessions.length <= MAX_CHANNELS - 3 ? [channelItem('hierarchy', () => void startHierarchyTable().then((error) => { if (error) tableFailed(error); }))] : [])];
  return <header className="tr-topbar">
    <Wordmark />
    {/* The folder mark tells the project switcher from the tab beside it, whose chosen form has nearly the same fill and border. */}
    {project
      ? <MenuButton className="tr-project" buttonClassName="button secondary" ariaLabel={`Project ${project}`} label={<><Folder className="tr-project-icon" size={16} aria-hidden="true" /><span className="tr-project-name" title={rootDirectory ?? undefined}>{project}</span></>} items={[{ label: 'Change project', icon: <FolderOpen size={16} aria-hidden="true" />, onSelect: () => void openProjectFolder() }, { label: 'Manage projects', icon: <FolderCog size={16} aria-hidden="true" />, onSelect: () => setView('projects') }]} />
      : <button className="tr-project button secondary" onClick={() => void openProjectFolder()}><Folder className="tr-project-icon" size={16} aria-hidden="true" />Open project</button>}
    <nav className="tr-tabs" aria-label="Main views">
      {PRIMARY_VIEWS.map(({ view, label }) => <button key={view} className={activeView === view ? 'active' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setView(view)}>{label}</button>)}
      {linkedComputers.filter((computer) => computer.linked).map((computer) => { const current = activeView === 'computer' && computerId === computer.id; const waiting = waitingOn(computer);
        return <button key={computer.id} className={`tr-computer-tab ${current ? 'active' : ''} ${computer.connected ? '' : 'offline'}`} aria-current={current ? 'page' : undefined} title={computer.connected ? `${computer.name}: ${computer.channels.length} channels` : `${computer.name}: not connected`} onClick={() => useWorkspaceStore.setState({ computerId: computer.id, activeView: 'computer' })}>
          <Monitor size={16} aria-hidden="true" />{computer.name}{waiting > 0 && <span className="tr-tab-badge ui-count waiting" aria-label={`${waiting} waiting`}>{waiting}</span>}</button>; })}
    </nav>
    <span className="tr-divider" aria-hidden="true" />
    <MenuButton ariaLabel="Insight views" active={Boolean(insight)} label={<span className="tr-menu-label">{insight?.label ?? 'Insight'}</span>} items={toItems(INSIGHT_VIEWS)} />
    <span className="tr-spacer" />
    {activeView === 'workspace' && <div className="tr-seg tr-segmented" role="group" aria-label="Grid arrangement">
      <button className={explorer ? 'active' : ''} aria-label={explorer ? 'Hide explorer' : 'Show explorer'} title={explorer ? 'Hide explorer' : 'Show explorer'} aria-pressed={explorer} onClick={onToggleExplorer}><PanelLeft size={16} /></button>
      {[{ mode: 'columns' as const, icon: Columns2, label: 'Split vertically: columns' }, { mode: 'rows' as const, icon: Rows2, label: 'Split horizontally: rows' }, { mode: 'grid' as const, icon: Grid2X2, label: 'Arrange in grid' }].map(({ mode, icon: Icon, label }) =>
        <button key={mode} className={layoutMode === mode ? 'active' : ''} aria-label={label} title={label} aria-pressed={layoutMode === mode} onClick={() => arrange(mode)}><Icon size={16} /></button>)}
    </div>}
    <CommandMenu />
    <button className="tr-icon icon-button" aria-label="Open help" title="Help & AI guide" onClick={() => setView('help')}><CircleHelp size={16} /></button>
    <MenuButton ariaLabel="Agent setup" active={setupActive} label={<><SlidersHorizontal size={16} aria-hidden="true" /><span className="tr-wide-label">Agent setup</span></>} items={toItems(SETUP_VIEWS)} />
    <MenuButton className="tr-new-channel" buttonClassName="button primary" ariaLabel="New channel" title={!other && sessions.length >= MAX_CHANNELS ? channelsFullNote(sessions) ?? undefined : undefined} disabled={other ? !other.connected || other.channels.length >= MAX_CHANNELS : sessions.length >= MAX_CHANNELS} label={<><Plus size={16} aria-hidden="true" /><span className="tr-wide-label">Channel</span></>} items={channelMenu} />
  </header>;
}
