import { describe, expect, it } from 'vitest';
import type { Finding } from '../../shared/findings';
import type { Task } from '../../shared/workbench';
import { findingsForTask } from './task-evidence';

const task = (id: string, sessionId: string | null, sentAt?: string): Task => ({ id, title: id, directory: '/p', sessionId, scope: ['**'], status: 'review', notes: '', verificationId: null, createdAt: '2026-11-10T00:00:00.000Z', ...(sentAt ? { sentAt } : {}) });
const finding = (id: string, at: string): Finding => ({ id, severity: 'low', evidence: '', text: id, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: 0, at });

describe('findings belong to one task', () => {
  it('takes only those reported between its send and the next task sent on its channel', () => {
    const first = task('first', 'ch', '2026-11-10T01:00:00.000Z'); const second = task('second', 'ch', '2026-11-10T02:00:00.000Z'); const elsewhere = task('elsewhere', 'other', '2026-11-10T01:30:00.000Z');
    const findings = [finding('F1', '2026-11-10T00:30:00.000Z'), finding('F2', '2026-11-10T01:10:00.000Z'), finding('F3', '2026-11-10T02:10:00.000Z')];
    const all = [first, second, elsewhere];
    expect(findingsForTask(first, all, findings).map((f) => f.id)).toEqual(['F2']);
    expect(findingsForTask(second, all, findings).map((f) => f.id)).toEqual(['F3']);
    expect(findingsForTask(task('unsent', 'ch'), all, findings)).toEqual([]);
  });
});
