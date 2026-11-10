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
  /** The round it was reported in, and when. */
  round: number; at: string;
}
export const MAX_FINDINGS = 50;
const LINE_LIMIT = 500;

const FINDING = /^\s*(?:[-*]\s*)?\**FINDING\**\s*[:(\[]?\s*(high|medium|low)\s*[)\]]?\s*[:,-]?\s*(.+)$/i;
const ANSWER = /^\s*(?:[-*]\s*)?\**(FIXED|DECLINED|VERIFIED|REOPENED)\**\s+F(\d{1,3})\b\s*[:,.-]?\s*(.*)$/i;
/** "path:line — problem" or "path — problem": the evidence is the first word when it looks like a file reference. */
function split(rest: string) {
  const match = /^(\S+?(?::\d+(?:-\d+)?)?)\s+[—–-]{1,2}\s+(.+)$/.exec(rest.trim());
  return match && /[/\\.]/.test(match[1]) ? { evidence: match[1], text: match[2].trim() } : { evidence: '', text: rest.trim() };
}

/** New findings in a reviewer's answer. */
export function parseFindings(answer: string): { severity: FindingSeverity; evidence: string; text: string }[] {
  const out: { severity: FindingSeverity; evidence: string; text: string }[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = FINDING.exec(line); if (!match) continue;
    const { evidence, text } = split(match[2].slice(0, LINE_LIMIT)); if (text) out.push({ severity: match[1].toLowerCase() as FindingSeverity, evidence, text });
  }
  return out;
}

/** FIXED / DECLINED (the driver's) or VERIFIED / REOPENED (the reviewer's) lines in an answer. */
export function parseAnswers(answer: string, from: 'driver' | 'reviewer'): { id: string; verb: 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; note: string }[] {
  const allowed = from === 'driver' ? ['FIXED', 'DECLINED'] : ['VERIFIED', 'REOPENED']; const out: { id: string; verb: 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; note: string }[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = ANSWER.exec(line); if (!match) continue;
    const verb = match[1].toUpperCase() as 'FIXED' | 'DECLINED' | 'VERIFIED' | 'REOPENED'; if (allowed.includes(verb)) out.push({ id: `F${Number(match[2])}`, verb, note: match[3].trim().slice(0, LINE_LIMIT) });
  }
  return out;
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
  const waiting = findings.filter((finding) => role === 'driver' ? finding.status === 'open' : finding.status === 'fixed' || finding.status === 'declined');
  if (!waiting.length) return '';
  const lines = waiting.map((finding) => `${finding.id} (${finding.severity}${finding.evidence ? `, ${finding.evidence}` : ''}${finding.status !== 'open' ? `, ${finding.status}: ${finding.response || 'no reason given'}` : ''}): ${finding.text}`);
  return role === 'driver'
    ? `Open findings, waiting for you. Answer each on its own line as "FIXED F<n>: what you changed" or "DECLINED F<n>: why":\n${lines.join('\n')}`
    : `Findings the driver answered, waiting for your check. Check each, then answer on its own line "VERIFIED F<n>" or "REOPENED F<n>: why":\n${lines.join('\n')}`;
}
