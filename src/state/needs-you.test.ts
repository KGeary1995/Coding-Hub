import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import type { Task } from '../../shared/workbench';
import { createSession } from './workspace-store';
import { needsYou, waited } from './needs-you';

const running = (extra: Partial<Session> = {}): Session => ({ ...createSession('claude'), status: 'running', runId: crypto.randomUUID(), ...extra });
const task = (extra: Partial<Task>): Task => ({ id: crypto.randomUUID(), title: 'Fix it', directory: '/p', sessionId: null, scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: '2026-11-10T00:00:00.000Z', sentAt: '2026-11-10T00:00:00.000Z', ...extra });

describe('Needs you', () => {
  it('lists approvals first, with the exact request, the task and since when; then failures, stopped, quiet and review tasks', () => {
    const asking = running({ attention: { message: 'Allow Bash: rm -rf build?', at: '2026-11-10T01:00:00.000Z' } });
    const failed = { ...createSession('codex'), status: 'error' as const, error: 'codex exited with code 1', endedAt: '2026-11-10T02:00:00.000Z' };
    const tasks = [task({ title: 'Clean build', sessionId: asking.id }), task({ title: 'Ship docs', sessionId: failed.id }), task({ title: 'Old work', sessionId: 'gone', outcome: 'stopped' }), task({ title: 'Maybe done', sessionId: 'x', outcome: 'quiet' }), task({ title: 'Ready', status: 'review' }), task({ title: 'Plain', sessionId: 'y' })];
    const items = needsYou([asking, failed], [], tasks);
    expect(items.map((item) => item.kind)).toEqual(['approval', 'failed', 'task-stopped', 'task-quiet', 'task-review']);
    expect(items[0]).toMatchObject({ detail: 'Allow Bash: rm -rf build? · task: Clean build', since: '2026-11-10T01:00:00.000Z', action: 'answer' });
    expect(items[1]).toMatchObject({ detail: 'codex exited with code 1 · task: Ship docs', action: 'retry' });
    expect(items.filter((item) => item.title.includes('Ship docs'))).toHaveLength(0);
  });
  it('lists a Round Table message kept from before a restart, but not one simply waiting for the agents', () => {
    const table = { partner: { sessionId: 'p', runId: 'r', engine: 'codex' as const }, driver: 'claude' as const, rounds: 2, round: 0, phase: 'idle' as const, agreed: false };
    expect(needsYou([], [], [], { lead: { ...table, waiting: 'Also update the docs.', waitingKept: true }, other: { ...table, waiting: 'In flight' } })).toMatchObject([{ kind: 'table-waiting', sessionId: 'lead', detail: 'Also update the docs.', action: 'answer' }]);
  });
  it('says how long something has waited', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    expect(waited('2026-11-10T11:56:00.000Z', now)).toBe('4 min'); expect(waited('2026-11-10T09:00:00.000Z', now)).toBe('3 h'); expect(waited('2026-11-07T12:00:00.000Z', now)).toBe('3 d'); expect(waited(null)).toBe('');
  });
});
