import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositoryFiles } from './filesystem';
import { LOG_LIMIT, parseLog, parseNumstat, RepositoryGit } from './git';
/** Many real Git commands in each test: a busy Windows runner can take longer than the 5 s default. */
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
async function repository() {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'hub-history-'))); roots.push(directory);
  let clock = 1_700_000_000;
  // A fixed clock a minute apart per commit, so date order is the order they were made.
  const git = (...args: string[]) => { clock += 60; return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } }).toString().trim(); };
  git('init', '-q', '-b', 'main');
  const files = new RepositoryFiles(); const context = await files.open(10, { directory });
  const write = (name: string, text: string | Buffer) => writeFileSync(path.join(directory, name), text);
  const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  return { directory, git, write, commit, request: { repositoryId: context.id }, history: new RepositoryGit(files) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('Git history', () => {
  it('reads HEAD, local branches and their upstreams with parents and badges, but not other remote branches', async () => {
    const { git, write, commit, request, history } = await repository();
    write('a.txt', 'one\n'); const first = commit('First');
    git('tag', '-a', 'v1', '-m', 'Release one');
    git('checkout', '-q', '-b', 'topic'); write('b.txt', 'two\n'); const topic = commit('Topic work');
    git('checkout', '-q', 'main'); write('c.txt', 'three\n'); const main = commit('Main work');
    git('merge', '-q', '--no-ff', 'topic', '-m', 'Merge topic'); const merge = git('rev-parse', 'HEAD');
    // An upstream for main one commit behind, and a remote branch nobody tracks.
    git('update-ref', 'refs/remotes/origin/main', main); git('config', 'branch.main.remote', 'origin'); git('config', 'branch.main.merge', 'refs/heads/main');
    git('checkout', '-q', '-b', 'stray', first); write('d.txt', 'four\n'); const stray = commit('Remote only'); git('update-ref', 'refs/remotes/origin/stray', stray);
    git('checkout', '-q', 'main'); git('branch', '-q', '-D', 'stray');
    // topic's upstream is gone: the history is still read.
    git('config', 'branch.topic.remote', 'origin'); git('config', 'branch.topic.merge', 'refs/heads/missing');

    const log = await history.log(10, request);
    expect(log).toMatchObject({ head: merge, branch: 'main', limited: false });
    expect(log.commits.map((item) => item.sha)).toEqual([merge, main, topic, first]);
    expect(log.commits[0]).toMatchObject({ parents: [main, topic], author: 'Fixture', subject: 'Merge topic', refs: [{ name: 'main', kind: 'branch', current: true }] });
    expect(log.commits[0].date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(log.commits[1].refs).toEqual([{ name: 'origin/main', kind: 'remote' }]);
    expect(log.commits[2].refs).toEqual([{ name: 'topic', kind: 'branch' }]);
    // The annotated tag points at its commit, not the tag object; the untracked remote branch is not read.
    expect(log.commits[3]).toMatchObject({ parents: [], refs: [{ name: 'v1', kind: 'tag' }] });
    expect(log.commits.some((item) => item.sha === stray)).toBe(false);
  });

  it('shows a commit’s message and files, renames and binary files included, and refuses anything but a commit id', async () => {
    const { git, write, commit, request, history } = await repository();
    write('a.txt', 'one\ntwo\n'); write('image.bin', Buffer.from([0, 1, 2, 0, 255])); const first = commit('First\n\nThe body,\nover two lines.');
    git('mv', 'a.txt', 'renamed.txt'); write('renamed.txt', 'one\ntwo\nthree\n'); write('image.bin', Buffer.from([0, 9, 9, 0])); const second = commit('Second');
    expect(await history.commit(10, { ...request, sha: first })).toMatchObject({ sha: first, parents: [], author: 'Fixture', message: 'First\n\nThe body,\nover two lines.', limited: false,
      files: [{ path: 'a.txt', originalPath: null, additions: 2, deletions: 0 }, { path: 'image.bin', originalPath: null, additions: null, deletions: null }] });
    const detail = await history.commit(10, { ...request, sha: second });
    expect(detail.parents).toEqual([first]);
    expect(detail.files).toContainEqual({ path: 'renamed.txt', originalPath: 'a.txt', additions: 1, deletions: 0 });
    expect(detail.files).toContainEqual({ path: 'image.bin', originalPath: null, additions: null, deletions: null });
    for (const sha of ['HEAD', '--output=x', second.slice(0, 12), second.toUpperCase()]) await expect(history.commit(10, { ...request, sha })).rejects.toMatchObject({ code: 'INVALID_COMMIT' });
    await expect(history.commit(10, { ...request, sha: second, extra: 1 })).rejects.toMatchObject({ code: 'INVALID_COMMIT' });
    await expect(history.commit(10, { ...request, sha: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'COMMIT_UNAVAILABLE' });
    // A blob's id is a valid object id but not a commit: its contents are never shown.
    const blob = git('rev-parse', `${second}:renamed.txt`);
    await expect(history.commit(10, { ...request, sha: blob })).rejects.toMatchObject({ code: 'COMMIT_UNAVAILABLE' });
    await expect(history.commit(11, { ...request, sha: second })).rejects.toMatchObject({ code: 'STALE_REPOSITORY' });
  });

  it('is empty before the first commit, and follows a detached HEAD', async () => {
    const { git, write, commit, request, history } = await repository();
    expect(await history.log(10, request)).toEqual({ head: null, branch: null, commits: [], limited: false });
    write('a.txt', 'one\n'); const first = commit('First'); write('a.txt', 'two\n'); commit('Second');
    git('checkout', '-q', '--detach', first); write('a.txt', 'three\n'); const detached = commit('Detached');
    const log = await history.log(10, request);
    expect(log).toMatchObject({ head: detached, branch: null }); expect(log.commits.map((item) => item.subject)).toEqual(['Detached', 'Second', 'First']);
  });

  it('parses at most the limit and says when there were more', () => {
    const sha = (index: number) => index.toString(16).padStart(40, '0');
    const output = Buffer.from(Array.from({ length: LOG_LIMIT + 1 }, (_, index) => [sha(index + 1), sha(index + 2), '2026-01-01T00:00:00+00:00', 'A', 'x'.repeat(300)].join('\0')).join('\0') + '\0');
    const { commits, limited } = parseLog(output, new Map());
    expect(commits).toHaveLength(LOG_LIMIT); expect(limited).toBe(true); expect(commits[0].subject).toHaveLength(200); expect(commits[0].parents).toEqual([sha(2)]);
  });

  it('reads numstat records with tabs and spaces in paths', () => {
    expect(parseNumstat(Buffer.from('3\t1\tdir/with space.txt\0' + '0\t0\t\0old\tname\0new name\0' + '-\t-\tlogo.png\0')).files).toEqual([
      { path: 'dir/with space.txt', originalPath: null, additions: 3, deletions: 1 },
      { path: 'new name', originalPath: 'old\tname', additions: 0, deletions: 0 },
      { path: 'logo.png', originalPath: null, additions: null, deletions: null },
    ]);
  });
});
