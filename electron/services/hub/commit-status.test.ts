import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitRefs, commitsTrailer, describeCommits } from '../../../shared/commit-refs';
import { commitStatus } from './commit-status';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-commits-'))); roots.push(root); return root; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

describe('commits named in memory notes', () => {
  it('reads only the fixed forms: session summaries and the Commits trailer', () => {
    const summary = 'Files changed:\n- a.ts\n\nCommits made during the session:\n- 846dc43 Trustworthy task status\n- 69E9994 Review fixes\n\nThe agent said: done, see b1cffee in prose.';
    expect(commitRefs(summary)).toEqual(['846dc43', '69e9994']);
    expect(commitRefs(`Handoff text.\n\n${commitsTrailer(['ABC1234', 'def5678'])}`)).toEqual(['abc1234', 'def5678']);
    expect(commitRefs('Fixed in 34ccd2b, local only.')).toEqual([]);
  });
  it('says which commits are pushed, as of the last fetch, and which are only local or unknown', async () => {
    const root = temp(); const remote = path.join(root, 'remote.git'); const clone = path.join(root, 'clone');
    git(root, 'init', '--bare', remote); git(root, 'init', clone); fs.writeFileSync(path.join(clone, 'a.txt'), 'a'); git(clone, 'add', '.'); git(clone, 'commit', '-m', 'pushed');
    const pushed = git(clone, 'rev-parse', 'HEAD'); git(clone, 'remote', 'add', 'origin', remote); git(clone, 'push', '-q', 'origin', 'HEAD:main'); git(clone, 'fetch', '-q', 'origin');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'b'); git(clone, 'commit', '-qam', 'local'); const local = git(clone, 'rev-parse', 'HEAD');
    const status = (await commitStatus(clone, [pushed.slice(0, 7), local, 'deadbeef']))!;
    expect(status.commits).toEqual([{ sha: pushed.slice(0, 7), known: true, remotes: ['origin/main'] }, { sha: local, known: true, remotes: [] }, { sha: 'deadbeef', known: false, remotes: [] }]);
    expect(status.fetchedAt).not.toBeNull();
    expect(describeCommits(status)).toMatch(/on origin\/main; .* not on any remote branch; deadbeef not in this clone$/);
    expect(await commitStatus(temp(), [pushed])).toBeNull();
  });
});
