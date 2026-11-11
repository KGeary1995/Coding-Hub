import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types';
import { arrangeTiles, createSession, useWorkspaceStore } from '../state/workspace-store';
import { permissionsRefused, setPermissions } from './permissions';

const RUN_A = '11111111-1111-4111-8111-111111111111'; const RUN_B = '22222222-2222-4222-8222-222222222222';
/** A running Round Table: a Claude chat leading, a Codex chat seated as its partner, both at Full access. */
function table() {
  const partner: Session = { ...createSession('codex'), status: 'running', runId: RUN_B, config: { engine: 'codex', chat: true, model: '', reasoningEffort: null, permissions: 'full' } };
  const lead: Session = { ...createSession('claude'), status: 'running', runId: RUN_A, roundTable: { partner: partner.id, driver: 'claude', rounds: 2 }, config: { engine: 'claude', chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null }, permissions: 'full' } };
  useWorkspaceStore.setState({ sessions: [lead, partner], tiles: arrangeTiles([lead, partner], 'grid') });
  const chat = vi.fn(async (_request: Record<string, unknown>) => ({ ok: true }));
  vi.stubGlobal('window', { codingHub: { chat } });
  const level = (id: string) => { const config = useWorkspaceStore.getState().sessions.find((session) => session.id === id)!.config; return config.engine === 'shell' ? null : config.permissions; };
  return { lead, partner, chat, level };
}
const RUN_C = '33333333-3333-4333-8333-333333333333';
/** A running hierarchy table: the Claude builder leading, a Codex reviewer and a hidden Claude planner (Fable), all at Ask. */
function hierarchy() {
  const claude = (permissions: 'ask' | 'edits' | 'full') => ({ engine: 'claude' as const, chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null }, permissions });
  const reviewer: Session = { ...createSession('codex'), status: 'running', runId: RUN_B, config: { engine: 'codex', chat: true, model: '', reasoningEffort: null, permissions: 'ask' } };
  const planner: Session = { ...createSession('claude'), status: 'running', runId: RUN_C, config: claude('ask') };
  const lead: Session = { ...createSession('claude'), status: 'running', runId: RUN_A, roundTable: { partner: reviewer.id, planner: planner.id, driver: 'claude', rounds: 2 }, config: claude('ask') };
  useWorkspaceStore.setState({ sessions: [lead, reviewer, planner], tiles: arrangeTiles([lead, reviewer, planner], 'grid') });
  const chat = vi.fn(async (_request: Record<string, unknown>) => ({ ok: true }));
  vi.stubGlobal('window', { codingHub: { chat } });
  const level = (id: string) => { const config = useWorkspaceStore.getState().sessions.find((session) => session.id === id)!.config; return config.engine === 'shell' ? null : config.permissions; };
  return { lead, reviewer, planner, chat, level };
}
afterEach(() => vi.unstubAllGlobals());

describe('channel permissions', () => {
  it('sets both agents at a Round Table, saves Ask explicitly, and undoes everything if a chat refuses', async () => {
    const { lead, partner, chat, level } = table();
    expect(await setPermissions(lead.id, 'ask')).toBeNull();
    expect([level(lead.id), level(partner.id)]).toEqual(['ask', 'ask']);
    expect(chat.mock.calls.map(([request]) => request.sessionId)).toEqual([lead.id, partner.id]);
    // The partner refuses: both channels show their old level, and the lead is switched back.
    chat.mockReset(); chat.mockImplementation(async (request) => (request.sessionId === partner.id && request.level === 'edits' ? { ok: false, error: { message: 'No.' } } : { ok: true }) as never);
    expect(await setPermissions(lead.id, 'edits')).toBe('No.');
    expect([level(lead.id), level(partner.id)]).toEqual(['ask', 'ask']);
    expect(chat.mock.calls.at(-1)![0]).toMatchObject({ sessionId: lead.id, level: 'ask' });
  });
  it('sets the other agent back too when one refuses later, so one control never stands for two levels', async () => {
    const { lead, partner, chat, level } = table();
    await setPermissions(lead.id, 'edits'); chat.mockClear();
    // Claude (the lead) refused after accepting the request: it is still at Full access.
    await permissionsRefused(lead.id, RUN_A, 'full');
    expect([level(lead.id), level(partner.id)]).toEqual(['full', 'full']);
    expect(chat.mock.calls.map(([request]) => request)).toEqual([{ action: 'permissions', sessionId: partner.id, runId: RUN_B, level: 'full' }]);
    // A refusal from an earlier run of the channel changes nothing.
    chat.mockClear(); await permissionsRefused(lead.id, '33333333-3333-4333-8333-333333333333', 'ask');
    expect(level(lead.id)).toBe('full'); expect(chat).not.toHaveBeenCalled();
  });
  it('sets the hidden planner of a hierarchy table with the builder and reviewer, both ways, and undoes it with them', async () => {
    const { lead, reviewer, planner, chat, level } = hierarchy();
    // The table's control is the builder's: Full reaches the planner too, so it stops asking.
    expect(await setPermissions(lead.id, 'full')).toBeNull();
    expect([level(lead.id), level(reviewer.id), level(planner.id)]).toEqual(['full', 'full', 'full']);
    expect(chat.mock.calls.map(([request]) => [request.sessionId, request.level])).toEqual([[lead.id, 'full'], [reviewer.id, 'full'], [planner.id, 'full']]);
    // Back to Ask: the planner goes back too, so it no longer runs commands without asking.
    chat.mockClear(); expect(await setPermissions(lead.id, 'ask')).toBeNull();
    expect([level(lead.id), level(reviewer.id), level(planner.id)]).toEqual(['ask', 'ask', 'ask']);
    expect(chat.mock.calls.map(([request]) => request.sessionId)).toEqual([lead.id, reviewer.id, planner.id]);
    // The planner refuses Accept edits: all three keep Ask, and the two already switched go back.
    chat.mockReset(); chat.mockImplementation(async (request) => (request.sessionId === planner.id && request.level === 'edits' ? { ok: false, error: { message: 'No.' } } : { ok: true }) as never);
    expect(await setPermissions(lead.id, 'edits')).toBe('No.');
    expect([level(lead.id), level(reviewer.id), level(planner.id)]).toEqual(['ask', 'ask', 'ask']);
    expect(chat.mock.calls.slice(-2).map(([request]) => [request.sessionId, request.level])).toEqual([[lead.id, 'ask'], [reviewer.id, 'ask']]);
    // A seat that refuses later (Claude answers after accepting) sets the whole table back, the planner included.
    chat.mockReset(); chat.mockImplementation(async () => ({ ok: true }));
    await setPermissions(lead.id, 'full'); chat.mockClear();
    await permissionsRefused(planner.id, RUN_C, 'ask');
    expect([level(lead.id), level(reviewer.id), level(planner.id)]).toEqual(['ask', 'ask', 'ask']);
    expect(chat.mock.calls.map(([request]) => [request.sessionId, request.level])).toEqual([[lead.id, 'ask'], [reviewer.id, 'ask']]);
  });
});
