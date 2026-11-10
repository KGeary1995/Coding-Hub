/**
 * Commits a memory note names in a fixed form: Trace's session summaries ("Commits made during the session:" then
 * "- <sha> <subject>" lines) and handoffs given `commits` ("Commits: <sha>, <sha>"). Hashes in ordinary prose are not
 * read: a word that looks like a hash is too often something else.
 */
export const MAX_REFS = 10;
const SHA = /^[0-9a-f]{7,40}$/i;
export function commitRefs(content: string): string[] {
  const out = new Set<string>(); let summary = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Commits made during the session:$/i.test(line)) { summary = true; continue; }
    if (summary) { const match = /^-\s+([0-9a-f]{7,40})\b/i.exec(line); if (match) { out.add(match[1].toLowerCase()); continue; } summary = false; }
    const trailer = /^Commits:\s*(.+)$/i.exec(line);
    if (trailer) for (const part of trailer[1].split(/[\s,]+/)) if (SHA.test(part)) out.add(part.toLowerCase());
  }
  return [...out].slice(0, MAX_REFS);
}
/** The trailer write_handoff adds for `commits`. */
export const commitsTrailer = (shas: string[]) => `Commits: ${shas.map((sha) => sha.toLowerCase()).join(', ')}`;
export const isSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);

/** Whether each commit is in this clone and on which remote-tracking branches, as of the last fetch (Git cannot know newer). */
export interface CommitStatus { checkedAt: string; fetchedAt: string | null; commits: { sha: string; known: boolean; remotes: string[] }[] }
/** "abc1234 on origin/main" / "not on any remote branch" / "not in this clone", for people and agents. */
export function describeCommits(status: CommitStatus): string {
  const fetched = status.fetchedAt ? `remote branches as of the last fetch, ${status.fetchedAt.slice(0, 16).replace('T', ' ')} UTC` : 'no fetch recorded';
  return `Checked ${status.checkedAt.slice(0, 16).replace('T', ' ')} UTC (${fetched}): ` + status.commits.map((commit) => `${commit.sha.slice(0, 9)} ${!commit.known ? 'not in this clone' : commit.remotes.length ? `on ${commit.remotes.slice(0, 3).join(', ')}` : 'not on any remote branch'}`).join('; ');
}
