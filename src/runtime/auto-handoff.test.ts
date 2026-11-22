import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import type { UsageRecord } from '../../shared/hub';
import { handoffDue, handoffRequest, handoffSaved } from './auto-handoff';

const session = (patch: Partial<Session> = {}): Session => ({ id: 's1', title: 'Claude', config: { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, binding: { mode: 'workspace' },
  status: 'running', pid: 1, runId: 'r1', runningCwd: '/p', error: null, createdAt: new Date().toISOString(), endedAt: null, exitCode: null, logFile: null, ...patch });
const usage = (used: number, limit: number): UsageRecord => ({ runId: 'r1', sessionId: 's1', engine: 'claude', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: null, context: { used, limit }, cost: null });

describe('asking an agent for a handoff near its context limit', () => {
  it('is due for a running agent at 80% of its context, with automatic memory on', () => {
    const one = session();
    expect(handoffDue(one, [one], usage(800_000, 1_000_000), {})).toBe(true);
    expect(handoffDue(one, [one], usage(790_000, 1_000_000), {})).toBe(false);
    // Just compacted: what was kept, not the old size.
    expect(handoffDue(one, [one], usage(34_597, 1_000_000), {})).toBe(false);
    // Claude has not reported its window yet: no share is guessed.
    expect(handoffDue(one, [one], usage(800_000, 0), {})).toBe(false); expect(handoffDue(one, [one], undefined, {})).toBe(false);
    expect(handoffDue(one, [one], usage(900_000, 1_000_000), { automaticMemory: false })).toBe(false);
  });
  it('is not due while the agent waits for an approval, is stopped, is a terminal or Gemini CLI, or sits at a Round Table', () => {
    const full = usage(900_000, 1_000_000);
    const waiting = session({ attention: { message: 'Approve npm test?', at: new Date().toISOString() } }); expect(handoffDue(waiting, [waiting], full, {})).toBe(false);
    const stopped = session({ status: 'exited', runId: null }); expect(handoffDue(stopped, [stopped], full, {})).toBe(false);
    const shell = session({ config: { engine: 'shell' } }); expect(handoffDue(shell, [shell], full, {})).toBe(false);
    const gemini = session({ config: { engine: 'gemini', model: '' } }); expect(handoffDue(gemini, [gemini], full, {})).toBe(false);
    const lead = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2 } }); const seat = session({ id: 's2' });
    expect(handoffDue(lead, [lead, seat], full, {})).toBe(false); expect(handoffDue(seat, [lead, seat], full, {})).toBe(false);
    const codex = session({ config: { engine: 'codex', model: '', reasoningEffort: null } }); expect(handoffDue(codex, [codex], full, {})).toBe(true);
  });
  it('counts a handoff as saved only when that agent wrote a note after it was asked', () => {
    const asked = Date.parse('2026-11-22T14:00:00Z'); const note = (author: 'claude' | 'codex' | 'human', at: string) => ({ author, createdAt: at });
    expect(handoffSaved([note('claude', '2026-11-22T14:01:10Z')], 'claude', asked)).toBe(true);
    expect(handoffSaved([note('claude', '2026-11-22T13:20:00Z'), note('codex', '2026-11-22T14:01:10Z'), note('human', '2026-11-22T14:02:00Z')], 'claude', asked)).toBe(false);
    expect(handoffSaved([], 'codex', asked)).toBe(false);
  });
  it('asks in one line, naming the tool and how full the context is', () => {
    const text = handoffRequest(84); expect(text).toContain('84%'); expect(text).toContain('write_handoff'); expect(text).not.toContain('\n');
  });
});
