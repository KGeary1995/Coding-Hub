import { describe, expect, it } from 'vitest';
import { channelDirectory, setTerminalTitle, useTitleStore } from './channel-names';
import type { Session } from '../../shared/types';

describe('the title a CLI gives its terminal', () => {
  it('loses its spinner but keeps its own first character', () => {
    setTerminalTitle('a', '✳ .env handling'); expect(useTitleStore.getState().titles.a).toBe('.env handling');
    setTerminalTitle('a', '⠐ /review'); expect(useTitleStore.getState().titles.a).toBe('/review');
    setTerminalTitle('a', '· `npm test` fails\x07'); expect(useTitleStore.getState().titles.a).toBe('`npm test` fails');
  });
});

describe('a channel’s folder', () => {
  const session = (patch: Partial<Session>): Session => ({ id: 's', title: 'Claude', config: { engine: 'shell' }, binding: { mode: 'workspace' }, status: 'idle', pid: null, runId: null, error: null, createdAt: '', endedAt: null, exitCode: null, logFile: null, ...patch } as Session);
  it('is where it runs, else its own folder (running or not), else the project’s', () => {
    expect(channelDirectory(session({ runningCwd: '/run' , binding: { mode: 'independent', cwd: '/own' } }), '/root')).toBe('/run');
    // An idle channel with an independent repository: its folder, not the project's (a Round Table it led used the project's).
    expect(channelDirectory(session({ binding: { mode: 'independent', cwd: '/own' } }), '/root')).toBe('/own');
    expect(channelDirectory(session({}), '/root')).toBe('/root'); expect(channelDirectory(session({}), null)).toBeNull();
  });
});
