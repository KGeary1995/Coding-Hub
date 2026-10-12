import { describe, expect, it } from 'vitest';
import { coachingFindings, coachingPacket, type PromptExample } from './coaching';
import type { UsageRecord } from './hub';
const record: UsageRecord = { runId: 'one', sessionId: 's', engine: 'codex', model: 'm', cwd: '/project', timestamp: '2026-10-11T00:00:00Z', input: 100, output: 25, cached: 20, cacheWrite: 0, reasoning: 10, context: null, cost: null };
const example: PromptExample = { id: 'e', text: 'Just fix it', outcome: 'partial', notes: 'Required rework', createdAt: record.timestamp };
describe('local coaching summaries and reviewed packets', () => {
  it('deduplicates runs and keeps reasoning/cache counts from inflating Codex totals', () => {
    const findings = coachingFindings([record, record], [example]); expect(findings.tokens).toBe(125); expect(findings.runs).toBe(1); expect(findings.reasoning).toBe(10); expect(findings.cost).toBeNull(); expect(findings.days[0].tokens).toBe(125);
    expect(findings.advice.some((tip) => tip.includes('very short'))).toBe(true);
  });
  it('counts Claude cache separately and labels missing evidence instead of inventing savings', () => {
    expect(coachingFindings([{ ...record, engine: 'claude' }], []).tokens).toBe(145); expect(coachingFindings([], []).advice[0]).toContain('No CLI-reported usage');
    const packet = coachingPacket(coachingFindings([record], []), []); expect(packet).not.toContain('/project'); expect(packet).not.toContain('Just fix it'); expect(packet).toContain('Do not infer');
  });
  it('includes selected wording and outcomes as quoted data, with no environment or full-log fields', () => {
    const packet = coachingPacket(coachingFindings([], [example]), [example]); expect(packet).toContain('Just fix it'); expect(packet).toContain('Required rework'); expect(packet).toContain('quoted data'); expect(packet).not.toContain('cwd');
  });
});
