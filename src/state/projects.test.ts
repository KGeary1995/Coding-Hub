import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import { channelProject, inActiveProject, mergeTiles, otherProjects, shownTiles, openProject, projectLabel, setAllProjects, shownChannels, useAllProjects, useShownChannels, useWorktrees, within } from './projects';
import { arrangeTiles, useWorkspaceStore } from './workspace-store';

const channel = (id: string, binding: Session['binding'] = { mode: 'workspace' }, patch: Partial<Session> = {}): Session => ({ id, title: id, config: { engine: 'shell' }, binding, status: 'idle', pid: null, runId: null, error: null, createdAt: '', endedAt: null, exitCode: null, logFile: null, ...patch } as Session);
const tree = { id: 'w1', repository: '/code/alpha', directory: '/home/.coding-hub/worktrees/w1', branch: 'coding-hub/w1', createdAt: '' };

describe('a channel’s project (several projects, step 6)', () => {
  it('is its folder, the repository a managed worktree came from, or the project for a folder inside it', () => {
    expect(channelProject(channel('a'), '/code/alpha', [])).toBe('/code/alpha');
    expect(channelProject(channel('b', { mode: 'independent', cwd: '/code/beta' }), '/code/alpha', [])).toBe('/code/beta');
    expect(channelProject(channel('w', { mode: 'independent', cwd: tree.directory }), '/code/beta', [tree])).toBe('/code/alpha');
    expect(within('/code/alpha/web', '/code/alpha')).toBe(true); expect(within('/code/alphabet', '/code/alpha')).toBe(false);
    expect(within('C:\\Code\\Alpha\\', 'c:/code/alpha')).toBe(true);
  });
  it('decides which channels the grid shows, and lists the other projects with how many channels', () => {
    const all = [channel('a'), channel('b', { mode: 'independent', cwd: '/code/beta' }), channel('c', { mode: 'independent', cwd: '/code/beta' }), channel('w', { mode: 'independent', cwd: tree.directory })];
    expect(all.filter((item) => inActiveProject(item, '/code/alpha', [tree])).map((item) => item.id)).toEqual(['a', 'w']);
    expect(otherProjects(all, '/code/alpha', [tree])).toEqual([{ folder: '/code/beta', channels: 2 }]);
    // Under All projects the open one is listed first, as one to go back to (it was missing from the menu).
    expect(otherProjects(all, '/code/alpha', [tree], true)[0]).toEqual({ folder: '/code/alpha', channels: all.filter((session) => inActiveProject(session, '/code/alpha', [tree])).length });
    expect(otherProjects([], '/code/alpha', [], true)).toEqual([{ folder: '/code/alpha', channels: 0 }]);
    // No project open: every channel shows.
    expect(all.every((item) => inActiveProject(item, null, []))).toBe(true);
  });
  it('keeps the open project’s channels with it when another project opens', () => {
    useWorkspaceStore.setState({ rootDirectory: '/code/alpha', sessions: [channel('a'), channel('b', { mode: 'independent', cwd: '/code/beta' })] });
    useWorkspaceStore.getState().setRootDirectory('/code/beta');
    expect(useWorkspaceStore.getState().sessions.map((item) => item.binding)).toEqual([{ mode: 'independent', cwd: '/code/alpha' }, { mode: 'independent', cwd: '/code/beta' }]);
    // The first project opened: channels set to the workspace follow it, as before.
    useWorkspaceStore.setState({ rootDirectory: null, sessions: [channel('a')] }); useWorkspaceStore.getState().setRootDirectory('/code/alpha');
    expect(useWorkspaceStore.getState().sessions[0].binding).toEqual({ mode: 'workspace' });
  });
  it('settles which channels show when a project opens: a folder typed in a channel\'s settings does not hide it', async () => {
    useWorktrees.setState({ list: [], loaded: true }); useWorkspaceStore.setState({ rootDirectory: '/code/alpha' }); useShownChannels.setState({ settled: null });
    const a = channel('a'); const b = channel('b', { mode: 'independent', cwd: '/code/beta' });
    expect(shownChannels([a, b], '/code/alpha', []).map((item) => item.id)).toEqual(['a']); await Promise.resolve();
    // Channel a now has another folder (being typed); a new channel c is added: both show until another project opens.
    const moved = channel('a', { mode: 'independent', cwd: '/code/gam' }); const added = channel('c', { mode: 'independent', cwd: '/code/delta' });
    expect(shownChannels([moved, b, added], '/code/alpha', []).map((item) => item.id)).toEqual(['a', 'c']);
    useWorkspaceStore.setState({ rootDirectory: '/code/one' }); useWorkspaceStore.setState({ rootDirectory: '/code/alpha' });
    expect(useShownChannels.getState().settled).toBeNull();
    expect(shownChannels([moved, b, added], '/code/alpha', []).map((item) => item.id)).toEqual([]);
  });
  it('keeps the hidden channels\' tiles below the shown ones, so the saved grid never overlaps', () => {
    const tile = (sessionId: string, x: number, y: number) => ({ sessionId, x, y, w: 6, h: 12, minW: 3, minH: 10 });
    // c and d (another project) sat at the top; a and b were laid out afresh there too.
    const merged = mergeTiles([tile('a', 0, 12), tile('c', 0, 0), tile('d', 6, 0), tile('b', 6, 12)], [tile('a', 0, 0), tile('b', 6, 0)]);
    expect(merged).toEqual([tile('c', 0, 12), tile('d', 6, 12), tile('a', 0, 0), tile('b', 6, 0)]);
    const overlaps = merged.some((one, index) => merged.slice(index + 1).some((other) => one.x < other.x + other.w && one.x + one.w > other.x && one.y < other.y + other.h && one.y + one.h > other.y));
    expect(overlaps).toBe(false);
    // Nothing hidden: the grid's own layout.
    expect(mergeTiles([tile('a', 0, 5)], [tile('a', 0, 0)])).toEqual([tile('a', 0, 0)]);
  });
});

describe('All projects (the project menu)', () => {
  it('names the project button All projects while it is on, and the open project’s folder otherwise', () => {
    expect(projectLabel(null, false)).toBeNull(); expect(projectLabel(null, true)).toBeNull();
    expect(projectLabel('/code/alpha/', false)).toBe('alpha'); expect(projectLabel('C:\\Code\\Beta', false)).toBe('Beta');
    expect(projectLabel('/code/alpha', true)).toBe('All projects');
  });
  it('ends when a project opens, whichever way it was opened', () => {
    useWorkspaceStore.setState({ rootDirectory: '/code/alpha', sessions: [] }); useAllProjects.setState({ on: true });
    useWorkspaceStore.setState({ activeView: 'workspace' }); expect(useAllProjects.getState().on).toBe(true);
    useWorkspaceStore.getState().setRootDirectory('/code/beta'); expect(useAllProjects.getState().on).toBe(false);
  });
  it('lays the tiles out again to fit when it is turned on or off, or another project opens', () => {
    const dragged = [{ sessionId: 'a', x: 0, y: 0, w: 3, h: 10, minW: 3, minH: 10 }, { sessionId: 'b', x: 0, y: 40, w: 3, h: 10, minW: 3, minH: 10 }];
    const sessions = [channel('a'), channel('b', { mode: 'independent', cwd: '/code/beta' })];
    useWorkspaceStore.setState({ rootDirectory: '/code/alpha', sessions, layoutMode: 'grid', tiles: dragged });
    setAllProjects(true); expect(useWorkspaceStore.getState().tiles).toEqual(arrangeTiles(sessions, 'grid'));
    useWorkspaceStore.setState({ tiles: dragged }); setAllProjects(false); expect(useWorkspaceStore.getState().tiles).toEqual(arrangeTiles(sessions, 'grid'));
    useWorkspaceStore.setState({ tiles: dragged }); useWorkspaceStore.getState().setRootDirectory('/code/beta'); expect(useWorkspaceStore.getState().tiles).toEqual(arrangeTiles(useWorkspaceStore.getState().sessions, 'grid'));
    // The same project again: the person's own layout stays.
    useWorkspaceStore.setState({ tiles: dragged }); useWorkspaceStore.getState().setRootDirectory('/code/beta'); expect(useWorkspaceStore.getState().tiles).toBe(dragged);
    // Turned off with another project's channel maximised: not kept so; one of the open project stays.
    useWorkspaceStore.setState({ rootDirectory: '/code/alpha', sessions, focusedSessionId: 'b' }); setAllProjects(true); setAllProjects(false); expect(useWorkspaceStore.getState().focusedSessionId).toBeNull();
    useWorkspaceStore.setState({ focusedSessionId: 'a' }); setAllProjects(true); setAllProjects(false); expect(useWorkspaceStore.getState().focusedSessionId).toBe('a');
    // Restored maximised but in another project: not kept so once the worktrees are known (which channels show is known then).
    useWorktrees.setState({ list: [], loaded: false }); useShownChannels.setState({ settled: null }); useWorkspaceStore.setState({ focusedSessionId: 'b' });
    useWorktrees.setState({ list: [], loaded: true }); expect(useWorkspaceStore.getState().focusedSessionId).toBeNull();
    // Opening the project already open ends All projects too.
    setAllProjects(true); openProject('/code/alpha'); expect(useAllProjects.getState().on).toBe(false);
    useWorkspaceStore.getState().setRootDirectory('/code/beta');
    // A channel maximised in the last project is not kept so.
    useWorkspaceStore.setState({ focusedSessionId: 'a' }); useWorkspaceStore.getState().setRootDirectory('/code/alpha'); expect(useWorkspaceStore.getState().focusedSessionId).toBeNull();
  });
});

describe('which channels show, settled when a project opens', () => {
  it('is not settled for the project opened before, when another opens before it settles', async () => {
    const a = channel('a', { mode: 'independent', cwd: '/a' }); const b = channel('b', { mode: 'independent', cwd: '/b' });
    useWorktrees.setState({ list: [], loaded: true }); useWorkspaceStore.setState({ rootDirectory: '/b', sessions: [a, b], focusedSessionId: 'a' });
    useShownChannels.setState({ settled: null }); setAllProjects(true); openProject('/a'); await Promise.resolve();
    expect(shownChannels([a, b], '/a', []).map((item) => item.id)).toEqual(['a']);
  });
});

describe('the shown channels’ tiles while another project’s are hidden', () => {
  const tile = (sessionId: string, x: number, y: number, w = 6, h = 12) => ({ sessionId, x, y, w, h, minW: 3, minH: 10 });
  const shown = [channel('a'), channel('b')];
  it('keep a layout made while they were shown (above the hidden ones)', () => {
    const made = [tile('h', 0, 30), tile('a', 0, 0, 4), tile('b', 4, 0, 8, 20)];
    expect(shownTiles(made, shown, 'grid')).toEqual([tile('a', 0, 0, 4), tile('b', 4, 0, 8, 20)]);
  });
  it('are laid out afresh from every channel as Trace arranged them (a project switch), not left at their share of the grid', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => channel(id)); const three = six.slice(0, 3);
    expect(shownTiles(arrangeTiles(six, 'grid'), three, 'grid')).toEqual(arrangeTiles(three, 'grid'));
  });
  it('are laid out afresh among the hidden ones, or when one has no tile', () => {
    expect(shownTiles([tile('a', 0, 0), tile('h', 6, 0), tile('b', 0, 12)], shown, 'grid')).toEqual(arrangeTiles(shown, 'grid'));
    expect(shownTiles([tile('a', 0, 0), tile('h', 0, 12)], shown, 'grid')).toEqual(arrangeTiles(shown, 'grid'));
  });
});
