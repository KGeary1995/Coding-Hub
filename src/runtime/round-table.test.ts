import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoundTableState } from '../../shared/chat';
import { savedWorkspaceSchema } from '../../shared/schemas';
import { arrangeTiles, createSession, savedWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useChatStore } from '../state/chat-store';
import { forgetTable, rememberTable, restoreTables } from './round-table';

const RUN_A = '11111111-1111-4111-8111-111111111111'; const RUN_B = '22222222-2222-4222-8222-222222222222';
afterEach(() => { vi.unstubAllGlobals(); useChatStore.setState({ threads: {} }); });

function seated() {
  const lead = { ...createSession('claude'), config: { engine: 'claude' as const, chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } };
  const partner = { ...createSession('codex'), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null } };
  useWorkspaceStore.setState({ sessions: [lead, partner], tiles: arrangeTiles([lead, partner], 'columns') });
  const table: RoundTableState = { partner: { sessionId: partner.id, runId: RUN_B, engine: 'codex' }, driver: 'codex', rounds: 3, round: 0, phase: 'idle', agreed: false };
  return { lead, partner, table };
}
const run = (id: string, runId: string) => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, status: 'running' as const, runId } : session) }));

describe('Round Tables across restarts', () => {
  it('saves the table with the leading channel and opens it again once both chats run, once per pair of runs', () => {
    const { lead, partner, table } = seated();
    rememberTable(lead.id, table);
    const saved = savedWorkspace();
    expect(saved.sessions[0].roundTable).toEqual({ partner: partner.id, driver: 'codex', rounds: 3 });
    expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true);
    const chat = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', { codingHub: { chat } });
    run(lead.id, RUN_A); restoreTables();
    expect(chat).not.toHaveBeenCalled();
    run(partner.id, RUN_B); restoreTables(); restoreTables();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith({ action: 'table-open', sessionId: lead.id, runId: RUN_A, partner: { sessionId: partner.id, runId: RUN_B }, driver: 'codex', rounds: 3 });
  });
  it('forgets a table the person closed, and does not save one whose partner channel is gone', () => {
    const { lead, partner, table } = seated();
    rememberTable(lead.id, table); forgetTable(lead.id);
    expect(savedWorkspace().sessions[0].roundTable).toBeUndefined();
    rememberTable(lead.id, table);
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.filter((session) => session.id !== partner.id) }));
    expect(savedWorkspace().sessions[0].roundTable).toBeUndefined();
  });
});
