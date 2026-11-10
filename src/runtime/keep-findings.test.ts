import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../../shared/findings';

const calls: Record<string, unknown>[] = []; let failWrites = false;
vi.mock('../state/hub-store', () => ({ hubCall: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); if (request.action === 'memory-write' && failWrites) throw new Error('Drive folder is offline'); return request.action === 'memory-key' ? 'project-abc' : null; }) }));
vi.mock('./use-native-host', () => ({ settled: vi.fn(async () => {}), startSession: vi.fn(async () => {}), stopSession: vi.fn(async () => {}) }));
const { archiveFindings, forgetTable, keepFindings } = await import('./round-table');
const { createSession, useWorkspaceStore } = await import('../state/workspace-store');
const { needsYou } = await import('../state/needs-you');

const finding = (id: string, status: Finding['status']): Finding => ({ id, severity: 'high', evidence: 'src/a.ts:3', text: `problem ${id}`, status, response: status === 'fixed' ? 'patched' : '', check: status === 'verified' ? 'looked again' : '', reviewedAt: 'abc123abc123', changedAt: null, round: 1, at: '2026-11-10T00:00:00.000Z' });
const leadWith = (findings: Finding[]) => ({ ...createSession('claude'), runningCwd: '/project', roundTable: { partner: 'gone', driver: 'claude' as const, rounds: 2, findings } });

describe('findings outlive a closed Round Table', () => {
  beforeEach(() => { calls.length = 0; failWrites = false; });
  it('saves the whole review record, verified findings included, and each unverified one as an open item', async () => {
    expect(await keepFindings(leadWith([finding('F1', 'open'), finding('F2', 'fixed'), finding('F3', 'verified')]))).toBe(3);
    const writes = calls.filter((call) => call.action === 'memory-write');
    expect(writes.map((call) => call.title)).toEqual(['Round Table review record: 3 findings, 1 verified', 'Open item: Round Table F1 (high, open): problem F1', 'Open item: Round Table F2 (high, fixed): problem F2']);
    expect(String(writes[0].content)).toContain('F3 (high), verified'); expect(String(writes[0].content)).toContain('Reviewer: looked again'); expect(writes[0]).toMatchObject({ project: 'project-abc', author: 'human' });
  });
  it('keeps the findings with the channel when memory cannot be written, says so, and Needs you can save them later', async () => {
    const lead = leadWith([finding('F1', 'open')]); useWorkspaceStore.setState({ sessions: [lead] });
    failWrites = true;
    expect(await archiveFindings(lead.id)).toMatch(/could not be saved to shared memory \(Drive folder is offline\)/);
    await forgetTable(lead.id); expect(useWorkspaceStore.getState().sessions[0].roundTable?.findings).toHaveLength(1);
    expect(needsYou(useWorkspaceStore.getState().sessions, [], [])).toMatchObject([{ kind: 'findings-unsaved', sessionId: lead.id, action: 'save-findings' }]);
    failWrites = false;
    expect(await archiveFindings(lead.id)).toBeNull(); expect(useWorkspaceStore.getState().sessions[0].roundTable?.findings).toBeUndefined();
    calls.length = 0; expect(await archiveFindings(lead.id)).toBeNull(); expect(calls).toEqual([]);
  });
});
