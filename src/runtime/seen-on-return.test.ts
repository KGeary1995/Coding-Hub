import { afterEach, describe, expect, it } from 'vitest';
import { createSession, useWorkspaceStore } from '../state/workspace-store';
import { seenOnReturn } from './use-native-host';

afterEach(() => { delete (globalThis as { document?: unknown }).document; });
const focusIn = (id: string | null) => { (globalThis as { document?: unknown }).document = { activeElement: id === null ? null : { closest: () => ({ getAttribute: () => id }) } }; };

describe('a channel marked Done', () => {
  it('counts as seen when the person comes back to Trace with focus in its tile', () => {
    const done = { ...createSession('claude'), status: 'running' as const, unseen: true }; const other = { ...createSession('codex'), status: 'running' as const, unseen: true };
    useWorkspaceStore.setState({ sessions: [done, other], activeView: 'workspace' });
    focusIn(done.id); seenOnReturn();
    expect(useWorkspaceStore.getState().sessions.map((session) => session.unseen)).toEqual([false, true]);
  });
  it('stays Done when focus is in no channel, or another view is open', () => {
    const done = { ...createSession('claude'), status: 'running' as const, unseen: true };
    useWorkspaceStore.setState({ sessions: [done], activeView: 'workspace' }); focusIn(null); seenOnReturn();
    useWorkspaceStore.setState({ activeView: 'tasks' }); focusIn(done.id); seenOnReturn();
    expect(useWorkspaceStore.getState().sessions[0].unseen).toBe(true);
  });
});
