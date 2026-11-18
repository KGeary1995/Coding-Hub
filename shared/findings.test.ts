import { describe, expect, it } from 'vitest';
import { apply, type Finding, findingsFor, makeRoomForFinding, MAX_FINDINGS, parseAnswers, parseChallengeAnswers, parseChallenges, parseFindings, unreadLines, unreadNotice } from './findings';

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

describe('lines in common Markdown forms', () => {
  it('reads findings in a numbered list, a quote or a heading, with emphasis, and an em dash after the severity', () => {
    const expected = { severity: 'high', evidence: 'src/a.ts:12', text: 'leaks the token' };
    for (const line of ['1. FINDING high src/a.ts:12 — leaks the token', '2) FINDING high src/a.ts:12 — leaks the token', '> FINDING high src/a.ts:12 — leaks the token', '### FINDING high src/a.ts:12 — leaks the token',
      '**FINDING high** src/a.ts:12 — leaks the token', 'FINDING **high** src/a.ts:12 — leaks the token', '`FINDING high` src/a.ts:12 — leaks the token', 'FINDING high — src/a.ts:12 — leaks the token', '**FINDING high src/a.ts:12 — leaks the token**'])
      expect(parseFindings(line), line).toEqual([expected]);
    // A reply that verifies one finding and numbers new ones records both.
    expect(parseFindings('VERIFIED F1\n1. FINDING high src/a.ts:12 — leaks\n2. FINDING medium b.ts:3 — slow')).toHaveLength(2);
    expect(parseChallenges('1. CHALLENGE high — misses mobile\n> **CHALLENGE** low — simpler with CSS')).toEqual([{ severity: 'high', text: 'misses mobile' }, { severity: 'low', text: 'simpler with CSS' }]);
  });
  it('reads answers in those forms, and every finding a line names', () => {
    for (const line of ['1. FIXED F1: escaped it', '**FIXED** **F1**: escaped it', '`FIXED F1`: escaped it', '> FIXED F1: escaped it', '**FIXED F1:** escaped it', 'FIXED F1 — escaped it'])
      expect(parseAnswers(line, 'driver'), line).toEqual([{ id: 'F1', verb: 'FIXED', note: 'escaped it' }]);
    expect(parseAnswers('### VERIFIED F1', 'reviewer')).toEqual([{ id: 'F1', verb: 'VERIFIED', note: '' }]);
    const each = (line: string) => parseAnswers(line, 'driver').map((answer) => `${answer.id}:${answer.note}`);
    expect(each('FIXED F1, F2, F3: escaped all three')).toEqual(['F1:escaped all three', 'F2:escaped all three', 'F3:escaped all three']);
    expect(each('FIXED F1 and F2: done')).toEqual(['F1:done', 'F2:done']); expect(each('FIXED F1-F3: done')).toEqual(['F1:done', 'F2:done', 'F3:done']);
    expect(each('FIXED F1: also touched F2')).toEqual(['F1:also touched F2']); expect(each('DECLINED F2 - by design')).toEqual(['F2:by design']);
    expect(parseAnswers('VERIFIED F1, F2 and F3', 'reviewer').map((answer) => answer.id)).toEqual(['F1', 'F2', 'F3']);
    expect(parseChallengeAnswers('ACCEPTED C1, C2\nREJECTED C3-C4 — out of scope')).toEqual([{ id: 'C1', answer: 'accepted', reason: '' }, { id: 'C2', answer: 'accepted', reason: '' }, { id: 'C3', answer: 'rejected', reason: 'out of scope' }, { id: 'C4', answer: 'rejected', reason: 'out of scope' }]);
  });
  it('takes a spaced dash as the start of the note, not a range, and ids separated by spaces only before a colon, a dash or the end', () => {
    const each = (line: string) => parseAnswers(line, line.startsWith('REOPENED') ? 'reviewer' : 'driver').map((answer) => `${answer.id}:${answer.note}`);
    expect(each('FIXED F2 — F5 covers the same path')).toEqual(['F2:F5 covers the same path']); expect(each('FIXED F3 - F1 was the root cause')).toEqual(['F3:F1 was the root cause']);
    expect(each("REOPENED F2 — F1's fix broke this")).toEqual(["F2:F1's fix broke this"]); expect(each('FIXED F1–F3: done')).toEqual(['F1:done', 'F2:done', 'F3:done']);
    expect(each('FIXED F1, F2, and F3: done')).toEqual(['F1:done', 'F2:done', 'F3:done']); expect(each('FIXED F1, & F2: done')).toEqual(['F1:done', 'F2:done']);
    expect(each('DECLINED F1 F2 is the real problem')).toEqual(['F1:F2 is the real problem']); expect(each('FIXED F1 F2: done')).toEqual(['F1:done', 'F2:done']); expect(each('FIXED F1 F2')).toEqual(['F1:', 'F2:']);
    expect(each('FIXED F3-F1: done')).toEqual(['F3:done', 'F1:done']);
    expect(parseChallengeAnswers('REJECTED C1 — C2 already covers this')).toEqual([{ id: 'C1', answer: 'rejected', reason: 'C2 already covers this' }]);
  });
  it('keeps the characters that belong to the text: underscores, stars and code marks', () => {
    expect(parseFindings('FINDING medium __init__.py:3 — wrong import')).toEqual([{ severity: 'medium', evidence: '__init__.py:3', text: 'wrong import' }]);
    expect(parseFindings('FINDING high `src/a.ts:12` — x')).toEqual([{ severity: 'high', evidence: '`src/a.ts:12`', text: 'x' }]);
    expect(parseFindings('FINDING low *.test.ts files are not run')).toEqual([{ severity: 'low', evidence: '', text: '*.test.ts files are not run' }]);
    expect(parseFindings('FINDING low `npm test` skips `a.ts`')[0].text).toBe('`npm test` skips `a.ts`'); expect(parseFindings('FINDING low — **bold** claim')[0].text).toBe('**bold** claim');
    expect(parseChallenges('CHALLENGE low — `useMemo` is enough')).toEqual([{ severity: 'low', text: '`useMemo` is enough' }]);
    expect(parseAnswers('FIXED F1: `foo` renamed', 'driver')).toEqual([{ id: 'F1', verb: 'FIXED', note: '`foo` renamed' }]);
  });
  it('reads a line of many # or * at once, however long', () => {
    for (const line of ['#'.repeat(200), `${'#'.repeat(200)} FINDING high x`, `${'#'.repeat(5000)} text`, '*'.repeat(20000), `${'*'.repeat(20000)} FIXED F1`]) {
      const start = performance.now(); parseFindings(line); parseAnswers(line, 'driver'); parseChallenges(line); parseChallengeAnswers(line); unreadLines(line, 'reviewer');
      expect(performance.now() - start, line.slice(0, 20)).toBeLessThan(50);
    }
    expect(parseFindings('###### 1. **FINDING** high: y')).toEqual([{ severity: 'high', evidence: '', text: 'y' }]); expect(parseFindings('### FINDING high — x')).toHaveLength(1);
  });
  it('names the lines that start like a review line but cannot be read', () => {
    expect(unreadLines('FINDING: the cache never expires\nFINDING high a.ts:1 — fine\nVERIFIED the fix\nFixed it all', 'reviewer')).toEqual(['FINDING: the cache never expires', 'VERIFIED the fix']);
    expect(unreadLines('FIXED: everything\nFIXED F1: done', 'driver')).toEqual(['FIXED: everything']);
    expect(unreadNotice([])).toBeNull(); expect(unreadNotice(['FINDING: the cache never expires'])).toContain('“FINDING: the cache never expires”');
  });
});

describe('the record over time', () => {
  it('tells the driver why a finding was reopened, and what it answered before', () => {
    const item = finding({ id: 'F1', severity: 'low', evidence: '', text: 't' }); apply(item, 'FIXED', 'added a guard'); apply(item, 'REOPENED', 'still leaks in the retry path');
    expect(findingsFor([item], 'driver')).toContain('F1 (low, reopened: still leaks in the retry path; your earlier answer: added a guard): t');
    expect(findingsFor([finding({ severity: 'low', evidence: '', text: 't' })], 'driver')).toContain('F1 (low): t');
  });
  it('never gives an id twice, also when the finding dropped to make room had the highest', () => {
    const full = Array.from({ length: MAX_FINDINGS }, (_, index) => finding({ id: `F${index + 1}`, status: index === MAX_FINDINGS - 1 ? 'verified' : 'open' }));
    expect(makeRoomForFinding(full)).toBe(`F${MAX_FINDINGS + 1}`); expect(full).toHaveLength(MAX_FINDINGS - 1); expect(full.at(-1)!.id).toBe(`F${MAX_FINDINGS - 1}`);
    expect(makeRoomForFinding([finding({ id: 'F3' })])).toBe('F4');
    expect(makeRoomForFinding(Array.from({ length: MAX_FINDINGS }, (_, index) => finding({ id: `F${index + 1}` })))).toBeNull();
    expect(makeRoomForFinding([finding({ id: 'F999' })])).toBeNull();
  });
});

describe('only the fixed forms count', () => {
  it('needs the severity as a whole word and the answer keywords in capitals', () => {
    expect(parseFindings('FINDING: Higher-order component leaks listeners\nFINDING lower bound is off by one in src/a.ts:3\nFINDING Mediumship')).toEqual([]);
    expect(parseChallenges('CHALLENGE Higher risk than stated\nCHALLENGE lowercase names break on Linux')).toEqual([]);
    expect(parseAnswers('Verified F3 still fails on Windows\nI verified F3', 'reviewer')).toEqual([]); expect(parseChallengeAnswers('Accepted C1 in part')).toEqual([]);
  });
  it('takes FINDING and CHALLENGE in capitals, any case of severity, and leaves ordinary sentences alone', () => {
    expect(parseFindings('Finding: high quality work overall\nFinding: low-risk change\nfinding medium nothing')).toEqual([]);
    expect(parseFindings('FINDING High a.ts:1 — real')).toEqual([{ severity: 'high', evidence: 'a.ts:1', text: 'real' }]);
    expect(parseChallenges('Challenge: high hopes for this plan')).toEqual([]);
    expect(parseChallenges('CHALLENGE MEDIUM — misses tests')).toEqual([{ severity: 'medium', text: 'misses tests' }]);
  });
});
