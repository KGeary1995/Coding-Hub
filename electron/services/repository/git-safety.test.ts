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
    // A name holding `=` cannot be blanked with -c (it would set another key), so Trace refuses to read rather than run it.
    git('config', 'filter.a=b.clean', 'cat'); await expect(readOnlyGitOptions(repo)).rejects.toMatchObject({ code: 'GIT_UNSAFE_CONFIG' });
  });
  it('never runs a filter that a submodule’s own config names, while the status shown still sees new submodule commits', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-safety-'))); roots.push(root);
    const marker = path.join(root, 'ran').replace(/\\/g, '/');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    const library = path.join(root, 'library'); const repo = path.join(root, 'repo'); fs.mkdirSync(library); fs.mkdirSync(repo);
    git(library, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(library, '.gitattributes'), '*.txt filter=evil\n'); fs.writeFileSync(path.join(library, 'note.txt'), 'hello\n'); git(library, 'add', '.'); git(library, 'commit', '-q', '-m', 'Library');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'submodule', 'add', '-q', library, 'sub'); git(repo, 'commit', '-q', '-m', 'Add submodule');
    // Written into the submodule's own config (.git/modules/sub/config), which the top repository's listing does not show.
    git(path.join(repo, 'sub'), 'config', 'filter.evil.clean', `echo clean >> "${marker}"; cat`);
    const touch = () => { const file = path.join(repo, 'sub', 'note.txt'); const later = new Date(Date.now() + 5000 + Math.random() * 1000); fs.utimesSync(file, later, later); };
    const safe = await readOnlyGitOptions(repo);
    touch(); execFileSync('git', ['--no-optional-locks', ...safe, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty'], { cwd: repo, stdio: 'pipe' });
    touch(); execFileSync('git', ['--no-optional-locks', ...safe, 'status', '--porcelain'], { cwd: repo, stdio: 'pipe' });
    touch(); execFileSync('git', ['--no-pager', ...safe, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(marker)).toBe(false);
    // A new commit checked out in the submodule is still reported.
    git(path.join(repo, 'sub'), '-c', 'filter.evil.clean=cat', 'commit', '-q', '--allow-empty', '-m', 'Moved');
    expect(execFileSync('git', ['--no-optional-locks', ...safe, 'status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })).toContain('sub');
    expect(fs.existsSync(marker)).toBe(false);
    // `submodule.<name>.ignore=none` wins over diff.ignoreSubmodules, from .git/config, from the .gitmodules file, and
    // from the index's .gitmodules when the file is gone. Each is overridden by name.
    const read = async () => { const options = await readOnlyGitOptions(repo); touch(); execFileSync('git', ['--no-optional-locks', ...options, 'status', '--porcelain'], { cwd: repo, stdio: 'pipe' }); touch(); execFileSync('git', ['--no-pager', ...options, 'diff', '--no-ext-diff', '--no-textconv'], { cwd: repo, stdio: 'pipe' }); return options; };
    git(repo, 'config', 'submodule.sub.ignore', 'none'); expect(await read()).toContain('submodule.sub.ignore=dirty'); expect(fs.existsSync(marker)).toBe(false);
    git(repo, 'config', '--unset', 'submodule.sub.ignore'); git(repo, 'config', '-f', '.gitmodules', 'submodule.sub.ignore', 'none'); await read(); expect(fs.existsSync(marker)).toBe(false);
    git(repo, 'add', '.gitmodules'); fs.rmSync(path.join(repo, '.gitmodules')); await read(); expect(fs.existsSync(marker)).toBe(false);
    // The options read before that setting existed do not hold against it: the per-name override is what keeps it safe.
    touch(); execFileSync('git', ['--no-optional-locks', ...safe, 'status', '--porcelain'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(marker)).toBe(true); fs.rmSync(marker);
    // Without the guard, the same status runs the submodule's filter (the problem this guards against).
    touch(); execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--ignore-submodules=none'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(marker)).toBe(true);
  }, 60000);
});
