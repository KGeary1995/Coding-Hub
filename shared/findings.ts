/**
 * A Round Table's review record: each problem the reviewer reports, with its evidence, what the driver did about it, and
 * whether the reviewer checked it. Agents write fixed one-line forms, which Trace reads; anything else stays conversation.
 *
 *   reviewer: FINDING high src/a.ts:12 — the problem          (severity high, medium or low; evidence optional)
 *   driver:   FIXED F1: what changed      DECLINED F1: why
 *   reviewer: VERIFIED F1                 REOPENED F1: why
 */
export type FindingSeverity = 'high' | 'medium' | 'low';
/** open: reported, or reopened. fixed: the driver says so, not yet checked. declined: the driver will not change it. verified: the reviewer checked the fix. */
export type FindingStatus = 'open' | 'fixed' | 'declined' | 'verified';
export interface Finding {
  id: string; severity: FindingSeverity; evidence: string; text: string; status: FindingStatus;
  /** The driver's latest answer, and the reviewer's latest word on it. */
  response: string; check: string;
  /** The files as they were when it was reported, and when its status last changed (repositoryState, shortened); null when not a Git folder. */
  reviewedAt: string | null; changedAt: string | null;
  /** Files changed while the turn it came from ran (the driver works at the same time), so which version was reviewed is uncertain. */
  filesChanged?: boolean;
  /** The round it was reported in, and when. */
  round: number; at: string;
  /**
   * Written by Trace 1.20's Gemini seat and no longer: who reported it, Gemini's word on it and why, and the finding it
   * repeats (closed then). Kept so records saved by 1.20 still read; nothing shows them.
   */
  source?: 'gemini'; gemini?: 'agree' | 'dispute'; geminiNote?: string; duplicateOf?: string;
}
export const MAX_FINDINGS = 50;
/**
 * Makes room for one more finding and gives its id: one past the highest given, worked out before the oldest verified
 * finding is dropped to make room (its work is done), so an id is never given twice (F1 to F999). Null when the record is
 * full of findings still waiting: a new one must not be dropped without a word.
 */
export function makeRoomForFinding(findings: Finding[]): string | null {
  const next = nextNumber(findings); if (next > 999) return null;
  if (findings.length >= MAX_FINDINGS) { const verified = findings.findIndex((finding) => finding.status === 'verified'); if (verified < 0) return null; findings.splice(verified, 1); }
  return `F${next}`;
}
const nextNumber = (findings: Finding[]) => findings.reduce((most, finding) => Math.max(most, Number(finding.id.slice(1)) || 0), 0) + 1;
const LINE_LIMIT = 500;

// The keyword in capitals only: an ordinary sentence ("Finding: high quality work overall", "Verified F3 still fails") is
// not a review line. A line may sit in a list ("- ", "1. "), a quote or a heading, and carry Markdown emphasis or code
// marks around its words. The severity and ids are whole words ("Higher" is no severity); `_` may follow them as emphasis.
// A heading is 1 to 6 '#' and no more, so a line of many '#' (a banner in a script) has one reading, not exponentially many.
const LEAD = String.raw`^\s*(?:(?:[-*+>]|\d{1,3}[.)]|#{1,6}(?!#))\s*)*[*_\x60]*`;
const MARK = String.raw`[*_\x60]*`; const END = '(?![A-Za-z0-9])';
/** Emphasis or a code mark closing right after a word ("**FINDING high**", "`F1`"). */
const CLOSE = String.raw`(?:\*{1,2}|_{1,2}|\x60)?`;
/** Emphasis the keyword's left open before the text ("**FIXED F1:** text"): only with a space after it, so a text's own first characters ("__init__.py", "*.test.ts") stay. */
const OPEN = String.raw`(?:(?:\*{1,2}|_{1,2})(?=\s))?`;
const SEVERITY = String.raw`(high|medium|low|High|Medium|Low|HIGH|MEDIUM|LOW)${END}`;
const headed = (keyword: string) => new RegExp(String.raw`${LEAD}${keyword}${MARK}\s*[:(\[]?\s*${MARK}${SEVERITY}${CLOSE}\s*(?:[)\]]${CLOSE})?\s*[:,.—–-]*\s*${OPEN}\s*(.+)$`);
const FINDING = headed('FINDING');
/**
 * One id, a list ("F1, F2, and F3", "F1/F2") or a range ("F1-F3": a dash with no space around it; a spaced dash starts
 * the note, as in "REJECTED C1 — C2 covers it"), then the note. `bare` also takes ids separated by spaces only ("F1 F2").
 */
const ids = (letter: string, bare: boolean) => String.raw`${MARK}(${letter}\d{1,3}(?:${MARK}(?:[-–—]|\s*(?:,\s*(?:and${END}|&)?|&|\/|and${END})\s*${bare ? String.raw`|\s+` : ''})${MARK}${letter}\d{1,3})*)${END}${CLOSE}\s*([:,.—–-]*)\s*${OPEN}\s*(.*)$`;
/** Ids separated by spaces only. They count as a list only when a colon, a dash or the line's end follows ("DECLINED F1 F2 is the real problem" answers F1). */
const answerPattern = (verbs: string, letter: string) => {
  const loose = new RegExp(String.raw`${LEAD}(${verbs})${MARK}\s+${ids(letter, true)}`); const strict = new RegExp(String.raw`${LEAD}(${verbs})${MARK}\s+${ids(letter, false)}`);
  const spaced = new RegExp(String.raw`\d${MARK}\s+${MARK}${letter}\d`);
  return (line: string) => { const match = loose.exec(line); return match && spaced.test(match[2]) && match[4] && !/[:—–-]/.test(match[3]) ? strict.exec(line) : match; };
};
const ANSWER = answerPattern('FIXED|DECLINED|VERIFIED|REOPENED', 'F');
/** Every id a list names, ranges spelled out (at most MAX_FINDINGS from one range; a backwards one names its two ends). */
function listed(list: string, letter: string): string[] {
  const out: string[] = []; const number = new RegExp(String.raw`${letter}(\d{1,3})(?:${MARK}[-–—]${MARK}${letter}(\d{1,3}))?`, 'g');
  const add = (n: number) => { if (!out.includes(`${letter}${n}`)) out.push(`${letter}${n}`); };
  for (const match of list.matchAll(number)) { const from = Number(match[1]); const to = match[2] ? Number(match[2]) : from; if (to < from) { add(from); add(to); } else for (let n = from; n <= to && n - from < MAX_FINDINGS; n++) add(n); }
  return out;
}
/** Text read from a line, without emphasis left open at its end ("…the token**" when the line began "**FINDING"): only an unpaired mark goes, and code marks stay. */
const tidy = (text: string) => { const out = text.trim(); const mark = /([*_]{1,2})$/.exec(out)?.[1]; return mark && (out.split(mark).length - 1) % 2 ? out.slice(0, -mark.length).trim() : out; };
/** Lines of an answer, each cut to SCAN_LIMIT before any pattern runs on it (they run on the main process). */
const SCAN_LIMIT = 2000;
const linesOf = (answer: string) => answer.split(/\r?\n/).map((line) => line.slice(0, SCAN_LIMIT));
/** "path:line — problem" or "path — problem": the evidence is the first word when it looks like a file reference. */
function split(rest: string) {
  const match = /^(\S+?(?::\d+(?:-\d+)?)?)\s+[—–-]{1,2}\s+(.+)$/.exec(rest.trim());
  return match && /[/\\.]/.test(match[1]) ? { evidence: match[1], text: tidy(match[2]) } : { evidence: '', text: tidy(rest) };
}

/** New findings in a reviewer's answer. */
export function parseFindings(answer: string): { severity: FindingSeverity; evidence: string; text: string }[] {
  const out: { severity: FindingSeverity; evidence: string; text: string }[] = [];
  for (const line of linesOf(answer)) {
    const match = FINDING.exec(line); if (!match) continue;
    const { evidence, text } = split(match[2].slice(0, LINE_LIMIT)); if (text) out.push({ severity: match[1].toLowerCase() as FindingSeverity, evidence, text });
  }
  return out;
}

/** FIXED / DECLINED (the driver's) or VERIFIED / REOPENED (the reviewer's) lines in an answer; a line naming several findings answers each. */
export function parseAnswers(answer: string, from: 'driver' | 'reviewer'): { id: string; verb: 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; note: string }[] {
  const allowed = from === 'driver' ? ['FIXED', 'DECLINED'] : ['VERIFIED', 'REOPENED']; const out: { id: string; verb: 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; note: string }[] = [];
  for (const line of linesOf(answer)) {
    const match = ANSWER(line); if (!match) continue;
    const verb = match[1] as 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; if (!allowed.includes(verb)) continue;
    const note = tidy(match[4]).slice(0, LINE_LIMIT); for (const id of listed(match[2], 'F')) out.push({ id, verb, note });
  }
  return out;
}
/** Review keywords each role writes, for unreadLines. */
const KEYWORDS = { reviewer: ['FINDING', 'VERIFIED', 'REOPENED'], driver: ['FIXED', 'DECLINED'] } as const;
/**
 * Lines of an answer that start with one of the role's review keywords (in capitals) but that Trace could not read, so
 * the person can be told rather than the line being left out of the record without a word.
 */
export function unreadLines(answer: string, role: 'driver' | 'reviewer'): string[] {
  const start = new RegExp(String.raw`${LEAD}(?:${KEYWORDS[role].join('|')})${END}`);
  return linesOf(answer).filter((line) => start.test(line) && !parseFindings(line).length && !parseAnswers(line, role).length).map((line) => line.trim().slice(0, 200));
}
/** What the person is told about lines unreadLines found; null when there are none. */
export function unreadNotice(lines: string[]): string | null {
  if (!lines.length) return null;
  return `Trace could not read ${lines.length === 1 ? 'this line' : `${lines.length} lines`} of the review, so ${lines.length === 1 ? 'it is' : 'they are'} not in the review record: “${lines[0]}”. The forms Trace reads are “FINDING high path:line — problem”, “FIXED F1: what changed” and “VERIFIED F1”.`;
}

/** What a status change does: the driver can only answer open or reopened ones; the reviewer only checks fixed or declined ones. */
export function apply(finding: Finding, verb: 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED', note: string): boolean {
  if ((verb === 'FIXED' || verb === 'DECLINED') && finding.status === 'open') { finding.status = verb === 'FIXED' ? 'fixed' : 'declined'; finding.response = note; return true; }
  if (verb === 'VERIFIED' && (finding.status === 'fixed' || finding.status === 'declined')) { finding.status = 'verified'; finding.check = note; return true; }
  if (verb === 'REOPENED' && finding.status !== 'open') { finding.status = 'open'; finding.check = note; return true; }
  return false;
}

/** One line per finding still needing someone, for the agent it is waiting on. */
export function findingsFor(findings: Finding[], role: 'driver' | 'reviewer'): string {
  const waiting = findings.filter((finding) => !finding.duplicateOf && (role === 'driver' ? finding.status === 'open' : finding.status === 'fixed' || finding.status === 'declined'));
  if (!waiting.length) return '';
  // A finding reopened after the driver answered it carries the reviewer's reason and the earlier answer: the driver
  // cannot see the reviewer's reply (each agent has its own conversation).
  const reopened = (finding: Finding) => finding.status === 'open' && (finding.check || finding.response) ? `, reopened: ${finding.check || 'no reason given'}${finding.response ? `; your earlier answer: ${finding.response}` : ''}` : '';
  const lines = waiting.map((finding) => `${finding.id} (${finding.severity}${finding.evidence ? `, ${finding.evidence}` : ''}${finding.status !== 'open' ? `, ${finding.status}: ${finding.response || 'no reason given'}` : reopened(finding)}): ${finding.text}`);
  return role === 'driver'
    ? `Open findings, waiting for you. Answer each on its own line as "FIXED F<n>: what you changed" or "DECLINED F<n>: why":\n${lines.join('\n')}`
    : `Findings the driver answered, waiting for your check. Check each, then answer on its own line "VERIFIED F<n>" or "REOPENED F<n>: why":\n${lines.join('\n')}`;
}

const CHALLENGE = headed('CHALLENGE');
const RESPONSE = answerPattern('ACCEPTED|REJECTED', 'C');
/** The reviewer's challenges to a plan: "CHALLENGE high|medium|low — text" lines (Trace numbers them C1, C2, …). */
export function parseChallenges(answer: string): { severity: FindingSeverity; text: string }[] {
  const out: { severity: FindingSeverity; text: string }[] = [];
  for (const line of linesOf(answer)) { const match = CHALLENGE.exec(line); const text = match ? tidy(match[2]) : ''; if (match && text) out.push({ severity: match[1].toLowerCase() as FindingSeverity, text: text.slice(0, LINE_LIMIT) }); }
  return out;
}
/** The planner's answers to challenges: "ACCEPTED C1" or "REJECTED C1 — why" (one line may answer several: "ACCEPTED C1, C2"). */
export function parseChallengeAnswers(answer: string): { id: string; answer: 'accepted' | 'rejected'; reason: string }[] {
  const out: { id: string; answer: 'accepted' | 'rejected'; reason: string }[] = [];
  for (const line of linesOf(answer)) { const match = RESPONSE(line); if (match) for (const id of listed(match[2], 'C')) out.push({ id, answer: match[1] === 'ACCEPTED' ? 'accepted' : 'rejected', reason: tidy(match[4]).slice(0, LINE_LIMIT) }); }
  return out;
}
