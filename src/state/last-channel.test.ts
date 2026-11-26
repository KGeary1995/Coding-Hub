import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import { startingChoice, useChannel, useLastChannel } from './last-channel';

const channel = (id: string, binding: Session['binding'] = { mode: 'workspace' }): Session => ({ id, title: id, config: { engine: 'shell' }, binding, status: 'idle', pid: null, runId: null, error: null, createdAt: '', endedAt: null, exitCode: null, logFile: null } as Session);

describe('where Changes and Files start', () => {
  const root = channel('root'); const other = channel('other', { mode: 'independent', cwd: '/other' }); const all = [root, other];
  it('at the channel reviewed, else the last one used in another folder, else the workspace root', () => {
    expect(startingChoice(all, '/project', 'root', 'other')).toBe('root');
    expect(startingChoice(all, '/project', null, 'other')).toBe('other');
    // The last channel works in the root itself: the root, as before.
    expect(startingChoice(all, '/project', null, 'root')).toBe('workspace');
    expect(startingChoice(all, '/project', null, 'gone')).toBe('workspace'); expect(startingChoice(all, '/project', null, null)).toBe('workspace');
  });
  it('remembers the channel last used', () => {
    useChannel('other'); expect(useLastChannel.getState().sessionId).toBe('other');
  });
});
