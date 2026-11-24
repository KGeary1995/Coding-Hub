import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { UndoStatus } from '../../../shared/undo';
import { snapshotsFor, TurnSnapshots, SNAPSHOT_KEEP } from './turn-snapshots';
/** Many real Git commands in each test: a busy Windows runner can take longer than the 5 s default. */
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function fixture(commit = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-undo-'))); roots.push(root);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  const write = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
  const read = (name: string) => fs.existsSync(path.join(repo, name)) ? fs.readFileSync(path.join(repo, name), 'utf8') : null;
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  write('.gitignore', 'node_modules/\n*.log\n'); write('keep.txt', 'one\n'); write('src/edit.txt', 'original\n'); write('src/gone.txt', 'still here\n');
  if (commit) { git('add', '.'); git('commit', '-q', '-m', 'Baseline'); }
  const published: UndoStatus[] = []; const snapshots = new TurnSnapshots({ publish: (status) => published.push(status), settleMs: 10 });
  return { root, repo, git, write, read, published, snapshots };
}
const agent = { id: 'ch-1', engine: 'claude' };
const refs = (git: (...args: string[]) => string) => git('for-each-ref', '--format=%(refname)', 'refs/trace').split('\n').filter(Boolean);

describe('Undo last turn', () => {
  it('snapshots every agent channel, Gemini too, and never a shell or a Round Table seat', async () => {
    expect(['claude', 'codex', 'gemini'].map((engine) => snapshotsFor({ id: 'x', engine }))).toEqual([true, true, true]);
    expect(snapshotsFor({ id: 'x', engine: 'shell' })).toBe(false); expect(snapshotsFor({ id: 'x', engine: 'codex', seatedAt: 'lead' })).toBe(false);
    const { repo, git, write, snapshots, published } = fixture();
    const gemini = { id: 'gem-1', engine: 'gemini' };
    await snapshots.started(gemini, repo); write('src/edit.txt', 'Gemini changed this\n'); await snapshots.turnEnded(gemini, repo);
    expect(refs(git)).toEqual(['refs/trace/snapshots/gem-1/1', 'refs/trace/snapshots/gem-1/2']);
    expect(published.at(-1)).toEqual({ sessionId: 'gem-1', available: true, canUndo: true, canRedo: false });
    const shell = { id: 'sh-1', engine: 'shell' };
    await snapshots.started(shell, repo); await snapshots.turnEnded(shell, repo);
    expect(refs(git).some((ref) => ref.includes('sh-1'))).toBe(false);
  });

  it('takes a snapshot without changing the index, HEAD, branches or stash, and skips one when nothing changed', async () => {
    const { repo, git, write, snapshots } = fixture();
    write('src/edit.txt', 'staged\n'); git('add', 'src/edit.txt'); write('src/edit.txt', 'staged then edited\n'); git('stash', 'list');
    const before = { head: git('rev-parse', 'HEAD'), branches: git('branch', '--list'), staged: git('diff', '--cached', '--name-only'), status: git('status', '--porcelain'), stash: git('stash', 'list'), index: fs.readFileSync(path.join(repo, '.git', 'index')) };
    await snapshots.started(agent, repo); await snapshots.turnEnded(agent, repo);
    expect(refs(git)).toEqual(['refs/trace/snapshots/ch-1/1']);
    expect({ head: git('rev-parse', 'HEAD'), branches: git('branch', '--list'), staged: git('diff', '--cached', '--name-only'), status: git('status', '--porcelain'), stash: git('stash', 'list'), index: fs.readFileSync(path.join(repo, '.git', 'index')) }).toEqual(before);
    // The snapshot holds the file as it is on disk, not as staged.
    expect(git('show', 'refs/trace/snapshots/ch-1/1:src/edit.txt')).toBe('staged then edited\n');
  });

  it('puts back modified and deleted files, removes added ones, leaves ignored files, and Redo takes it back', async () => {
    const { repo, write, read, snapshots, published } = fixture();
    write('node_modules/lib/index.js', 'ignored\n'); write('debug.log', 'ignored log\n');
    await snapshots.started(agent, repo);
    write('src/edit.txt', 'agent edit\n'); fs.rmSync(path.join(repo, 'src', 'gone.txt')); write('src/new/added.txt', 'new file\n'); write('node_modules/lib/index.js', 'changed while ignored\n');
    await snapshots.turnEnded(agent, repo);
    expect(await snapshots.preview(agent, repo)).toMatchObject({ files: 3 });
    expect(await snapshots.restore(agent, repo)).toMatchObject({ files: 3, status: { canUndo: false, canRedo: true } });
    expect([read('src/edit.txt'), read('src/gone.txt'), read('src/new/added.txt'), fs.existsSync(path.join(repo, 'src', 'new'))]).toEqual(['original\n', 'still here\n', null, false]);
    expect([read('node_modules/lib/index.js'), read('debug.log')]).toEqual(['changed while ignored\n', 'ignored log\n']);
    // The turn ending after the undo (nothing changed since) keeps Redo.
    await snapshots.turnEnded(agent, repo); expect(published.at(-1)).toMatchObject({ canRedo: true });
    expect(await snapshots.preview(agent, repo, true)).toMatchObject({ files: 3 });
    expect(await snapshots.restore(agent, repo, true)).toMatchObject({ files: 3, status: { canUndo: true, canRedo: false } });
    expect([read('src/edit.txt'), read('src/gone.txt'), read('src/new/added.txt')]).toEqual(['agent edit\n', null, 'new file\n']);
    await expect(snapshots.restore(agent, repo, true)).rejects.toMatchObject({ code: 'REDO_NOTHING' });
  });

  it('undoes turn by turn, and files changed after an undo end its Redo', async () => {
    const { repo, write, read, snapshots } = fixture();
    await snapshots.started(agent, repo);
    write('keep.txt', 'turn 1\n'); await snapshots.turnEnded(agent, repo);
    write('keep.txt', 'turn 2\n'); await snapshots.turnEnded(agent, repo);
    await snapshots.restore(agent, repo); expect(read('keep.txt')).toBe('turn 1\n');
    await snapshots.restore(agent, repo); expect(read('keep.txt')).toBe('one\n');
    await expect(snapshots.restore(agent, repo)).rejects.toMatchObject({ code: 'UNDO_NOTHING' });
    write('keep.txt', 'turn 3\n'); expect((await snapshots.turnEnded(agent, repo), await snapshots.status(agent, repo))).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('puts back files changed by a turn whose end has not settled yet', async () => {
    const { repo, write, read, snapshots } = fixture();
    await snapshots.started(agent, repo); write('keep.txt', 'mid-turn\n');
    expect(await snapshots.restore(agent, repo)).toMatchObject({ files: 1 }); expect(read('keep.txt')).toBe('one\n');
  });

  it('keeps the newest snapshots only', async () => {
    const { repo, git, write, snapshots } = fixture();
    await snapshots.started(agent, repo);
    for (let turn = 1; turn <= SNAPSHOT_KEEP + 2; turn++) { write('keep.txt', `turn ${turn}\n`); await snapshots.started(agent, repo); }
    const kept = refs(git); expect(kept).toHaveLength(SNAPSHOT_KEEP); expect(kept).not.toContain('refs/trace/snapshots/ch-1/1');
  }, 60_000);

  it('works in a repository with no commits yet', async () => {
    const { repo, git, write, read, snapshots } = fixture(false);
    await snapshots.started(agent, repo); write('keep.txt', 'agent\n'); write('fresh.txt', 'new\n'); await snapshots.turnEnded(agent, repo);
    expect(git('cat-file', '-p', 'refs/trace/snapshots/ch-1/1')).not.toMatch(/^parent /m);
    await snapshots.restore(agent, repo);
    expect([read('keep.txt'), read('fresh.txt')]).toEqual(['one\n', null]);
    expect(() => git('rev-parse', '-q', '--verify', 'HEAD')).toThrow();
  });

  it('refuses a folder that is not a Git repository', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-undo-plain-'))); roots.push(root);
    const published: UndoStatus[] = []; const snapshots = new TurnSnapshots({ publish: (status) => published.push(status), settleMs: 10 });
    await snapshots.started(agent, root);
    expect(published).toEqual([expect.objectContaining({ available: false, reason: expect.stringContaining('not one') })]);
    await expect(snapshots.restore(agent, root)).rejects.toMatchObject({ code: 'UNDO_NOT_GIT' });
  });

  it('never runs a filter, hook or fsmonitor that the repository’s config names, and restores bytes exactly', async () => {
    const { root, repo, git, write, snapshots } = fixture(); const marker = path.join(root, 'ran').replace(/\\/g, '/');
    git('config', 'core.fsmonitor', `echo fsmonitor >> "${marker}"; false`);
    git('config', 'filter.evil.clean', `echo clean >> "${marker}"; cat`); git('config', 'filter.evil.smudge', `echo smudge >> "${marker}"; cat`); git('config', 'filter.evil.required', 'true');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true }); for (const hook of ['reference-transaction', 'post-index-change', 'pre-commit']) fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
    write('.gitattributes', '*.txt filter=evil text eol=crlf\n'); write('src/edit.txt', 'lf only\nline two\n');
    await snapshots.started(agent, repo); write('src/edit.txt', 'agent\n'); await snapshots.turnEnded(agent, repo);
    await snapshots.restore(agent, repo); await snapshots.restore(agent, repo, true); await snapshots.restore(agent, repo);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'src', 'edit.txt'), 'utf8')).toBe('lf only\nline two\n');
  });

  it('knows when a channel is mid-turn', () => {
    const { snapshots } = fixture();
    expect(snapshots.busy('t')).toBe(false);
    snapshots.activity({ type: 'data', sessionId: 't' }); expect(snapshots.busy('t')).toBe(true);
    snapshots.activity({ type: 'exit', sessionId: 't' }); expect(snapshots.busy('t')).toBe(false);
    snapshots.activity({ type: 'attention', sessionId: 't' }); expect(snapshots.busy('t')).toBe(true);
    snapshots.activity({ type: 'answered', sessionId: 't' }); expect(snapshots.busy('t')).toBe(false);
    snapshots.chatActivity('c', 'user'); expect(snapshots.busy('c')).toBe(true);
    snapshots.chatActivity('c', 'done'); expect(snapshots.busy('c')).toBe(false);
  });
});
