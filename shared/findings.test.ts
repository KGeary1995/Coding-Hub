import { describe, expect, it } from 'vitest';
import { apply, type Finding, findingsFor, parseAnswers, parseChallengeAnswers, parseChallenges, parseFindings } from './findings';

const finding = (extra: Partial<Finding> = {}): Finding => ({ id: 'F1', severity: 'high', evidence: 'src/a.ts:12', text: 'Leaks the token', status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: 0, at: '2026-11-10T00:00:00.000Z', ...extra });

describe('review record lines', () => {
  it('reads findings with or without evidence, in the forms agents write them', () => {
    expect(parseFindings('Looks fine overall.\n- FINDING high src/a.ts:12 — leaks the token\n**FINDING** (low): wording in the help text\nFINDING: medium README.md - stale link\nfinding nonsense')).toEqual([
      { severity: 'high', evidence: 'src/a.ts:12', text: 'leaks the token' },
      { severity: 'low', evidence: '', text: 'wording in the help text' },
      { severity: 'medium', evidence: 'README.md', text: 'stale link' },
    ]);
  });
  it('reads only the answers each role may give', () => {
    const text = 'FIXED F1: escaped it\nDECLINED F2 - by design\nVERIFIED F1\nREOPENED F3: still there';
    expect(parseAnswers(text, 'driver')).toEqual([{ id: 'F1', verb: 'FIXED', note: 'escaped it' }, { id: 'F2', verb: 'DECLINED', note: 'by design' }]);
    expect(parseAnswers(text, 'reviewer')).toEqual([{ id: 'F1', verb: 'VERIFIED', note: '' }, { id: 'F3', verb: 'REOPENED', note: 'still there' }]);
  });
  it('moves a finding only along open → fixed or declined → verified, or back to open', () => {
    const item = finding();
    expect(apply(item, 'VERIFIED', '')).toBe(false); expect(item.status).toBe('open');
    expect(apply(item, 'FIXED', 'escaped it')).toBe(true); expect(item).toMatchObject({ status: 'fixed', response: 'escaped it' });
    expect(apply(item, 'FIXED', 'again')).toBe(false);
    expect(apply(item, 'REOPENED', 'still leaks')).toBe(true); expect(item).toMatchObject({ status: 'open', check: 'still leaks' });
    expect(apply(item, 'DECLINED', 'by design')).toBe(true); expect(apply(item, 'VERIFIED', 'agreed')).toBe(true); expect(item.status).toBe('verified');
  });
  it('lists what each agent owes', () => {
    const list = [finding(), finding({ id: 'F2', status: 'fixed', response: 'done' }), finding({ id: 'F3', status: 'verified' })];
    expect(findingsFor(list, 'driver')).toContain('F1 (high, src/a.ts:12): Leaks the token'); expect(findingsFor(list, 'driver')).not.toContain('F2');
    expect(findingsFor(list, 'reviewer')).toContain('F2 (high, src/a.ts:12, fixed: done)'); expect(findingsFor([finding({ status: 'verified' })], 'driver')).toBe('');
  });
  it('reads the reviewer’s challenges and the planner’s answers, in the forms agents write them', () => {
    expect(parseChallenges('Notes\nCHALLENGE high — misses mobile\n- **CHALLENGE** (low): simpler with CSS\nCHALLENGE nope')).toEqual([{ severity: 'high', text: 'misses mobile' }, { severity: 'low', text: 'simpler with CSS' }]);
    expect(parseChallengeAnswers('ACCEPTED C1\nREJECTED C2 — out of scope\nREJECTED X3')).toEqual([{ id: 'C1', answer: 'accepted', reason: '' }, { id: 'C2', answer: 'rejected', reason: 'out of scope' }]);
  });
  it('writes nothing about Gemini, even for a finding saved by 1.20 with Gemini’s marks, and leaves 1.20’s duplicates out of what is waiting', () => {
    const waiting = findingsFor([finding({ source: 'gemini', gemini: 'agree', geminiNote: 'right' }), finding({ id: 'F2', duplicateOf: 'F1' })], 'driver');
    expect(waiting).toContain('F1 (high, src/a.ts:12): '); expect(waiting).not.toMatch(/gemini/i); expect(waiting).not.toContain('F2 (');
  });
});

describe('only the fixed forms count', () => {
  it('takes FINDING and CHALLENGE in capitals, any case of severity, and leaves ordinary sentences alone', () => {
    expect(parseFindings('Finding: high quality work overall\nFinding: low-risk change\nfinding medium nothing')).toEqual([]);
    expect(parseFindings('FINDING High a.ts:1 — real')).toEqual([{ severity: 'high', evidence: 'a.ts:1', text: 'real' }]);
    expect(parseChallenges('Challenge: high hopes for this plan')).toEqual([]);
    expect(parseChallenges('CHALLENGE MEDIUM — misses tests')).toEqual([{ severity: 'medium', text: 'misses tests' }]);
  });
});
