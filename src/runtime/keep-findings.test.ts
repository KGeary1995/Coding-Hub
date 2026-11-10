import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '../../shared/findings';

const calls: Record<string, unknown>[] = [];
vi.mock('../state/hub-store', () => ({ hubCall: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.action === 'memory-key' ? 'project-abc' : null; }) }));
vi.mock('./use-native-host', () => ({ settled: vi.fn(async () => {}), startSession: vi.fn(async () => {}), stopSession: vi.fn(async () => {}) }));
const { keepFindings } = await import('./round-table');
const { createSession } = await import('../state/workspace-store');

const finding = (id: string, status: Finding['status']): Finding => ({ id, severity: 'high', evidence: 'src/a.ts:3', text: `problem ${id}`, status, response: status === 'fixed' ? 'patched' : '', check: '', reviewedAt: 'abc123abc123', changedAt: null, round: 1, at: '2026-11-10T00:00:00.000Z' });

describe('findings outlive a closed Round Table', () => {
  it('saves each finding not yet verified as an open item in the channel’s memory project', async () => {
    const lead = { ...createSession('claude'), runningCwd: '/project', roundTable: { partner: 'p', driver: 'claude' as const, rounds: 2, findings: [finding('F1', 'open'), finding('F2', 'fixed'), finding('F3', 'verified')] } };
    expect(await keepFindings(lead)).toBe(2);
    const writes = calls.filter((call) => call.action === 'memory-write');
    expect(writes.map((call) => call.title)).toEqual(['Open item: Round Table F1 (high, open): problem F1', 'Open item: Round Table F2 (high, fixed): problem F2']);
    expect(writes[1]).toMatchObject({ project: 'project-abc', author: 'human' }); expect(String(writes[1].content)).toContain('Driver: patched');
    calls.length = 0; expect(await keepFindings({ ...lead, config: { ...lead.config, memoryKey: 'chosen' } as never, roundTable: { ...lead.roundTable, findings: [finding('F9', 'declined')] } })).toBe(1);
    expect(calls.map((call) => call.action)).toEqual(['memory-write']); expect(calls[0].project).toBe('chosen');
  });
});
