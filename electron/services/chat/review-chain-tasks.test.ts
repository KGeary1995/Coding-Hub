import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/workbench';
import { promptMark, SIGNAL_INSTRUCTION } from '../../../shared/task-signal';
import { legacySeats, ReviewChains } from './review-chain';

const calls: Record<string, unknown>[] = []; let listed: Task[] = [];
vi.mock('../../../src/runtime/workbench', () => ({ workbench: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.action === 'task-list' ? listed : null; }) }));
vi.mock('../../../src/runtime/terminals', () => ({ writeTerminal: vi.fn(async () => true) }));
const { chainTasks, useTaskStore } = await import('../../../src/state/task-store');

const B = '11111111-1111-4111-8111-111111111111'; const R = '22222222-2222-4222-8222-222222222222'; const P = '33333333-3333-4333-8333-333333333333';
const base: Task = { id: '', title: '', directory: '/p', sessionId: 'lead', scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: '2026-11-10T00:00:00.000Z', sentAt: '2026-11-10T00:00:00.000Z' };
const footer: Task = { ...base, id: crypto.randomUUID(), title: 'Add a footer' };
const header: Task = { ...base, id: crypto.randomUUID(), title: 'Add a header', createdAt: '2026-11-10T00:01:00.000Z', sentAt: '2026-11-10T00:01:00.000Z' };
const finished = () => calls.filter((call) => call.action === 'task-status' && call.outcome === 'finished').map((call) => call.id);

/** The chain on the host and Tasks in the window, joined as the window joins them (use-native-host.ts: every table goes to chainTasks). */
describe('two tasks from Tasks at one hierarchy table', () => {
  beforeEach(() => { calls.length = 0; listed = [header, footer]; useTaskStore.setState({ tasks: [header, footer] }); });
  it('a task sent during the final review of another finishes only once its own work is approved', async () => {
    const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number }> = { [B]: { sessionId: 'lead', engine: 'claude', cwd: '/p', owner: 1 }, [R]: { sessionId: 'rev', engine: 'codex', cwd: '/p', owner: 1 }, [P]: { sessionId: 'plan', engine: 'claude', cwd: '/p', owner: 1 } };
    const chains = new ReviewChains({ run: (id) => runs[id] ?? null, send: () => {}, setReadOnly: () => {}, answer: () => {}, interrupt: () => {}, emit: (_o, envelope) => { if (envelope.event.type === 'table' && envelope.event.table) chainTasks('lead', envelope.event.table); } });
    const reply = async (runId: string, text: string) => {
      chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'assistant', messageId: crypto.randomUUID(), blocks: [{ type: 'text', text }] } });
      chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } }); await new Promise((resolve) => setTimeout(resolve, 0));
    };
    chains.open(1, B, legacySeats(R, P)); chains.send(B, `${promptMark(footer)} ${SIGNAL_INSTRUCTION}`, []);
    await reply(P, 'Plan'); await reply(R, 'NO CHALLENGES'); chains.plan(B, true); await reply(B, 'Built.'); await reply(R, 'NO FINDINGS');
    // The header task arrives while the planner reviews the footer.
    chains.send(B, `${promptMark(header)} ${SIGNAL_INSTRUCTION}`, []);
    await reply(P, 'CHANGES NEEDED: rename it'); await reply(B, 'Renamed.'); await reply(R, 'NO FINDINGS');
    await reply(P, 'APPROVED');
    await vi.waitFor(() => expect(finished()).toEqual([footer.id]));
    // The header task starts now, on its own; it finishes only on its own APPROVED.
    await reply(P, 'Plan H'); await reply(R, 'NO CHALLENGES'); chains.plan(B, true); await reply(B, 'Built.'); await reply(R, 'NO FINDINGS');
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(finished()).toEqual([footer.id]);
    await reply(P, 'APPROVED'); await vi.waitFor(() => expect(finished()).toEqual([footer.id, header.id]));
  });
});
