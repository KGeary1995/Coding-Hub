import { useEffect, useState } from 'react';
import { workbench } from '../../runtime/workbench';
import type { PluginData } from '../../../shared/plugins';
import { useShallow } from 'zustand/react/shallow';
import { seatRoom } from '../../runtime/round-table';
import type { TableKind } from '../../../shared/table-seats';
import { TableSetup } from '../chat/TableSetup';
import { addLinkedChannel, useLinkedStore, waitingOn } from '../../state/linked-store';
import { BookOpen, Cable, Puzzle, ChartColumn, CircleHelp, CircleUserRound, Columns2, Files, Folder, FolderCog, FolderOpen, Grid2X2, GraduationCap, History, ListChecks, Monitor, Network, PanelLeft, Plus, Rows2, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Search, UsersRound, type LucideIcon } from 'lucide-react';
import { channelsFullNote, channelsOf, useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { CommandMenu } from '../CommandMenu';
import { StartOrderButton } from './StartOrderButton';
import { MenuButton, type MenuItem } from './MenuButton';
import { TraceMark } from './TraceMark';
import { ENGINE_ICONS } from '../tile/engine-icons';
import { MAX_CHANNELS } from '../../../shared/schemas';

/** Daily views sit in the tab row; the rest are one menu away, grouped by how often they are used. */
export const PRIMARY_VIEWS: { view: NavigationView; label: string }[] = [{ view: 'workspace', label: 'Workspace' }, { view: 'diff', label: 'Changes' }, { view: 'tasks', label: 'Tasks' }, { view: 'projects', label: 'Projects' }];
/** `icon` is the view's own: its menu entry shows it, and its page heading should show the same one. */
export const INSIGHT_VIEWS: { view: NavigationView; label: string; icon: LucideIcon }[] = [
  { view: 'usage', label: 'Usage', icon: ChartColumn }, { view: 'history', label: 'Session history', icon: History }, { view: 'files', label: 'Files', icon: Files }, { view: 'search', label: 'Search', icon: Search },
  // AI coaching and Verification sit here too (1.31.5): a More tools page that held only these two was one step more.
  { view: 'coaching', label: 'AI coaching', icon: GraduationCap }, { view: 'verification', label: 'Verification profiles', icon: ListChecks },
];
export const SETUP_VIEWS: { view: NavigationView; label: string; icon: LucideIcon }[] = [
  { view: 'accounts', label: 'Accounts & connections', icon: CircleUserRound }, { view: 'memory', label: 'Shared memory', icon: BookOpen }, { view: 'rules', label: 'Shared rules', icon: ShieldCheck }, { view: 'connectors', label: 'MCP servers', icon: Cable },
  { view: 'skills', label: 'Skills & plugins', icon: Sparkles }, { view: 'settings', label: 'Settings', icon: Settings2 },
];
/** What + Channel adds, each with its avatar: an engine's is the one its tile shows. */
const CHANNEL_KINDS = {
  shell: { label: 'Terminal', icon: ENGINE_ICONS.shell, tone: 'shell' }, claude: { label: 'Claude Code', icon: ENGINE_ICONS.claude, tone: 'claude' }, codex: { label: 'Codex', icon: ENGINE_ICONS.codex, tone: 'codex' }, gemini: { label: 'Gemini CLI', icon: ENGINE_ICONS.gemini, tone: 'gemini' },
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
    <TraceMark size={20} /><span className="tr-wordmark-text">Trace</span>
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
  /** The Round Table setup panel, opened by the two Round Table items; it outlives the menu that opened it. */
  const [setup, setSetup] = useState<TableKind | null>(null);
  const linkedComputers = useLinkedStore((state) => state.computers); const computerId = useWorkspaceStore((state) => state.computerId);
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const toItems = (views: { view: NavigationView; label: string; icon: LucideIcon }[]): MenuItem[] => views.map(({ view, label, icon: Icon }) => ({ label, icon: <Icon size={16} aria-hidden="true" />, current: activeView === view, onSelect: () => setView(view) }));
  const insight = INSIGHT_VIEWS.find((item) => item.view === activeView);
  const setupActive = SETUP_VIEWS.some((item) => item.view === activeView);
  // Each channel is its own CLI process; past four, say so where the next one is added.
  // On a linked computer's tab, + Channel adds the channel on that computer (chat channels are answered only there).
  // The order is the person's: Terminal, Claude Code, Codex, Gemini CLI, then the Round Tables (on the phone too).
  const other = activeView === 'computer' ? linkedComputers.find((item) => item.id === computerId) : undefined;
  // The tiles of the plugins that are on (docs/plugins.md), read again when the view changes (after Skills & plugins).
  const [tiles, setTiles] = useState<{ plugin: string; tile: string; title: string; name: string }[]>([]);
  useEffect(() => { void workbench<PluginData>({ action: 'plugin-list' }).then((data) => setTiles(data.plugins.filter((plugin) => plugin.enabled && !plugin.problem).flatMap((plugin) => plugin.tiles.map((tile) => ({ plugin: plugin.id, tile: tile.id, title: tile.title, name: plugin.name }))))).catch(() => setTiles([])); }, [activeView]);
  const addPluginTile = useWorkspaceStore((state) => state.addPluginTile);
  const channelMenu: MenuItem[] = other
    ? (['shell', 'claude', 'codex', 'gemini'] as const).map((engine) => channelItem(engine, () => void addLinkedChannel(other.id, engine)))
    : [...(['shell', 'claude', 'codex', 'gemini'] as const).map((engine) => channelItem(engine, () => addSession(engine))),
      // A table is at least two agents, each a channel's worth of the eight: offered while two places are free. The panel opens with that kind's built-in (or last-used) table.
      ...(seatRoom() >= 2 ? [channelItem('table', () => setSetup('discussion')), channelItem('hierarchy', () => setSetup('hierarchy'))] : []),
      ...tiles.map((item): MenuItem => ({ label: `${item.title} (${item.name})`, icon: <span className="ui-avatar small shell" aria-hidden="true"><Puzzle /></span>, onSelect: () => addPluginTile({ id: item.plugin, tile: item.tile }, item.title) }))];
  return <header className="tr-topbar">
    <Wordmark />
    {/* A secondary button with a folder mark; the chosen tab beside it takes the accent (shell.css). */}
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
    {activeView === 'workspace' && <StartOrderButton />}
    <CommandMenu />
    <button className="tr-icon icon-button" aria-label="Open help" title="Help & AI guide" onClick={() => setView('help')}><CircleHelp size={16} /></button>
    <MenuButton ariaLabel="Agent setup" active={setupActive} label={<><SlidersHorizontal size={16} aria-hidden="true" /><span className="tr-wide-label">Agent setup</span></>} items={toItems(SETUP_VIEWS)} />
    {setup && <TableSetup mode={{ type: 'new', table: setup }} onFailure={tableFailed} onClose={() => { setSetup(null); document.querySelector<HTMLElement>('.tr-new-channel .tr-menu-button')?.focus(); }} />}
    <MenuButton className="tr-new-channel" buttonClassName="button primary" ariaLabel="New channel" title={!other && sessions.length >= MAX_CHANNELS ? channelsFullNote(sessions) ?? undefined : undefined} disabled={other ? !other.connected || other.channels.length >= MAX_CHANNELS : sessions.length >= MAX_CHANNELS} label={<><Plus size={16} aria-hidden="true" /><span className="tr-wide-label">Channel</span></>} items={channelMenu} />
  </header>;
}
