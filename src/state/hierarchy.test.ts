import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundTableState, SavedChain } from '../../shared/chat';
import type { Task } from '../../shared/workbench';

const calls: Record<string, unknown>[] = []; let listed: Task[] = [];
vi.mock('../runtime/workbench', () => ({ workbench: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.action === 'task-list' ? listed : null; }) }));
vi.mock('../runtime/terminals', () => ({ writeTerminal: vi.fn(async () => true) }));
const { chainTasks, useTaskStore } = await import('./task-store');
const { needsYou } = await import('./needs-you');
const { channelsOf, createSession, leadOf, plannerOf } = await import('./workspace-store');
const { modelName } = await import('../components/chat/ChatParts');
const { savedWorkspaceSchema: workspaceSchema } = await import('../../shared/schemas');

const chain = (step: SavedChain['step'], extra: Partial<SavedChain> = {}): SavedChain => ({ step, task: 'Add a footer', plan: '1. Edit', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', ...extra });
const table = (c: SavedChain): RoundTableState => ({ kind: 'hierarchy', partner: { sessionId: 'rev', runId: 'r', engine: 'codex' }, planner: { sessionId: 'plan', runId: 'p', engine: 'claude' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false, chain: c });
const task: Task = { id: crypto.randomUUID(), title: 'Add a footer', directory: '/p', sessionId: 'lead', scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: '2026-11-10T00:00:00.000Z', sentAt: '2026-11-10T00:00:00.000Z' };
const statusCalls = () => calls.filter((call) => call.action === 'task-status');

describe('a task given to a hierarchy Round Table', () => {
  beforeEach(() => { calls.length = 0; listed = [task]; useTaskStore.setState({ tasks: [task] }); });
  it('is done only on the planner’s APPROVED', async () => {
    chainTasks('lead', table(chain('reviewing'))); chainTasks('lead', table(chain('final')));
    expect(statusCalls()).toEqual([]);
    chainTasks('lead', table(chain('done', { verdict: 'approved' }))); await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(statusCalls()[0]).toEqual({ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' });
  });
  it('waits for the person while the plan waits, or when the table needs them, and says why', async () => {
    chainTasks('lead', table(chain('plan-review'))); chainTasks('lead', table(chain('needs-you', { note: 'The planner still asks for changes' })));
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(2));
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'blocked', outcomeNote: 'The plan is waiting for your approval.' }, { action: 'task-status', id: task.id, status: 'active', outcome: 'blocked', outcomeNote: 'The planner still asks for changes' }]);
  });
});

describe('the hierarchy table in the window', () => {
  it('lists a plan waiting for approval in Needs you', () => {
    expect(needsYou([], [], [], { lead: table(chain('plan-review')) })).toMatchObject([{ kind: 'plan-review', sessionId: 'lead', detail: 'Add a footer', action: 'answer' }]);
  });
  it('hides the planner like the partner, saves without tiles for either, and names models as people do', () => {
    const lead = { ...createSession('claude'), roundTable: { partner: 'rev', planner: 'plan', kind: 'hierarchy' as const, driver: 'claude' as const, rounds: 2, chain: chain('final') } };
    const reviewer = { ...createSession('codex'), id: 'rev' }; const planner = { ...createSession('claude'), id: 'plan' };
    const sessions = [lead, reviewer, planner];
    expect(channelsOf(sessions).map((s) => s.id)).toEqual([lead.id]); expect(leadOf(sessions, 'plan')?.id).toBe(lead.id); expect(plannerOf(sessions, lead.id)?.id).toBe('plan');
    const saved = { version: 1, rootDirectory: null, sessions: sessions.map(({ id, title, config, binding, createdAt, roundTable }) => ({ id, title, config, binding, createdAt, ...(roundTable ? { roundTable } : {}) })), tiles: [{ sessionId: lead.id, x: 0, y: 0, w: 6, h: 10, minW: 3, minH: 10 }], layoutMode: 'grid', focusedSessionId: null };
    const parsed = workspaceSchema.safeParse(saved); if (!parsed.success) expect(parsed.error.issues).toEqual([]);
    expect(modelName('claude-fable-5-2')).toBe('Fable 5.2'); expect(modelName('claude-opus-5-5')).toBe('Opus 5.5'); expect(modelName('')).toBe('Claude');
  });
});
