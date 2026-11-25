import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import { channelProject, inActiveProject, mergeTiles, otherProjects, shownChannels, useShownChannels, useWorktrees, within } from './projects';
import { useWorkspaceStore } from './workspace-store';

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
    useWorktrees.setState({ list: [], loaded: true }); useShownChannels.setState({ settled: null });
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

