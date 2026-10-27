import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readOnlyGitOptions } from './git-safety';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('reading a repository', () => {
  it('never runs programs the repository’s own config names (fsmonitor, filter drivers)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-safety-'))); roots.push(root);
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo); const marker = path.join(root, 'ran').replace(/\\/g, '/');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'Baseline');
    // Written by the repository, not the person: each would leave a mark if Git ran it.
    git('config', 'core.fsmonitor', `echo fsmonitor >> "${marker}"; false`);
    git('config', 'filter.evil.clean', `echo clean >> "${marker}"; cat`); git('config', 'filter.evil.required', 'true');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n'); fs.writeFileSync(path.join(repo, 'note.txt'), 'hello\n');
    const safe = await readOnlyGitOptions(repo);
    execFileSync('git', ['--no-optional-locks', ...safe, 'status', '--porcelain'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', [...safe, 'add', '--intent-to-add', 'note.txt'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['--no-pager', ...safe, 'diff', '--no-ext-diff', '--no-textconv'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(safe).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'filter.evil.clean=', 'filter.evil.process=', 'filter.evil.required=false']));
    // Without the options the same status runs the repository's filter (the problem this guards against).
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(marker)).toBe(true);
  });
});
