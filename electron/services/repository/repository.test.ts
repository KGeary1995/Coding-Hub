import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { FILE_PREVIEW_LIMIT, RepositoryFiles } from './filesystem';
import { RepositoryGit } from './git';

const roots: string[] = [];
async function fixture(withGit = false) {
  // Windows temp paths can use 8.3 short names (RUNNER~1); Git reports the long form.
  const directory = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'hub-repository-'))); roots.push(directory);
  const files = new RepositoryFiles(); const context = await files.open(10, { directory });
  const request = { repositoryId: context.id };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).toString();
  if (withGit) git('init', '-b', 'main');
  return { directory, files, context, request, git, changes: new RepositoryGit(files) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('scoped project filesystem', () => {
  it('lists sorted directories/files lazily and previews Unicode while hiding Git metadata', async () => {
    const { directory, files, request } = await fixture();
    await mkdir(path.join(directory, '.git')); await mkdir(path.join(directory, 'src'));
    await expect(files.open(10, { directory: path.join(directory, '.git') })).rejects.toThrow('rather than Git metadata');
    await writeFile(path.join(directory, 'source.ts'), 'const message = "Hello 🚀";\n');
    const list = await files.list(10, { ...request, path: '' });
    expect(list.entries.map((entry) => [entry.name, entry.kind])).toEqual([['src', 'directory'], ['source.ts', 'file']]);
    expect(await files.read(10, { ...request, path: 'source.ts' })).toMatchObject({ text: 'const message = "Hello 🚀";\n', encoding: 'utf-8', binary: false });
  });

  it('rejects traversal, absolute paths, metadata, unknown IPC fields and other owners', async () => {
    const { files, request } = await fixture();
    for (const relative of ['../other', '/etc/passwd', 'C:\\Windows\\file', '.git/config', 'nested/../other']) {
      await expect(files.read(10, { ...request, path: relative })).rejects.toThrow();
    }
    await expect(files.list(11, { ...request, path: '' })).rejects.toThrow('no longer available');
    await expect(files.list(10, { ...request, path: '', executable: 'shell' })).rejects.toThrow();
    files.closeOwner(10);
    await expect(files.list(10, { ...request, path: '' })).rejects.toThrow('no longer available');
  });

  it('cancels an in-flight open when its owning view closes', async () => {
    const { directory, files } = await fixture();
    const pending = files.open(10, { directory });
    files.closeOwner(10);
    await expect(pending).rejects.toThrow('closed before this request completed');
  });

  it.skipIf(process.platform === 'win32')('shows but rejects linked files and directories outside the root', async () => {
    const { directory, files, request } = await fixture();
    const outside = await fixture(); await writeFile(path.join(outside.directory, 'secret.txt'), 'outside');
    await symlink(outside.directory, path.join(directory, 'linked-directory'));
    await symlink(path.join(outside.directory, 'secret.txt'), path.join(directory, 'linked-file'));
    expect((await files.list(10, { ...request, path: '' })).entries.every((entry) => entry.kind === 'symlink')).toBe(true);
    await expect(files.read(10, { ...request, path: 'linked-file' })).rejects.toThrow('Symbolic links');
    await expect(files.read(10, { ...request, path: 'linked-directory/secret.txt' })).rejects.toThrow('Symbolic links');
  });

  it('bounds large UTF-8 files and distinguishes binary data and UTF-16 text', async () => {
    const { directory, files, request } = await fixture();
    await writeFile(path.join(directory, 'large.txt'), 'x'.repeat(FILE_PREVIEW_LIMIT - 2) + '🚀after');
    const large = await files.read(10, { ...request, path: 'large.txt' });
    expect(large.truncated).toBe(true); expect(large.binary).toBe(false); expect(large.text).toHaveLength(FILE_PREVIEW_LIMIT - 2);
    await writeFile(path.join(directory, 'binary.bin'), Buffer.from([1, 2, 0, 0xff]));
    expect(await files.read(10, { ...request, path: 'binary.bin' })).toMatchObject({ binary: true, text: null });
    await writeFile(path.join(directory, 'windows.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Windows 🚀\r\n', 'utf16le')]));
    expect(await files.read(10, { ...request, path: 'windows.txt' })).toMatchObject({ text: 'Windows 🚀\r\n', encoding: 'utf-16le', binary: false });
  });

  it('caps each directory listing and rejects missing or special files', async () => {
    const { directory, files, request } = await fixture();
    await Promise.all(Array.from({ length: 502 }, (_, index) => writeFile(path.join(directory, `${index}.txt`), '')));
    const list = await files.list(10, { ...request, path: '' });
    expect(list.entries).toHaveLength(500); expect(list.limited).toBe(true);
    await expect(files.read(10, { ...request, path: 'absent.txt' })).rejects.toThrow('could not be read');
    await mkdir(path.join(directory, 'folder'));
    await expect(files.read(10, { ...request, path: 'folder' })).rejects.toThrow('regular file');
  });
});

describe('local read-only Git review', () => {
  it('separates staged and working changes and preserves index/worktree bytes', async () => {
    const { directory, request, git, changes } = await fixture(true);
    await writeFile(path.join(directory, 'source.txt'), 'baseline\n'); git('add', '.'); git('commit', '-m', 'Fixture baseline');
    await writeFile(path.join(directory, 'source.txt'), 'staged\n'); git('add', 'source.txt');
    await writeFile(path.join(directory, 'source.txt'), 'working\n');
    const indexBefore = await readFile(path.join(directory, '.git/index'));
    const status = await changes.status(10, request);
    expect(status).toMatchObject({ branch: 'main', root: directory, changes: [{ path: 'source.txt', indexStatus: 'M', worktreeStatus: 'M' }] });
    expect((await changes.diff(10, { ...request, path: 'source.txt', area: 'staged' })).patch).toContain('+staged');
    expect((await changes.diff(10, { ...request, path: 'source.txt', area: 'working' })).patch).toContain('+working');
    expect(await readFile(path.join(directory, '.git/index'))).toEqual(indexBefore);
    expect(await readFile(path.join(directory, 'source.txt'), 'utf8')).toBe('working\n');
  });

  it('handles unborn branches, literal pathspec characters and untracked files with newlines', async () => {
    const { directory, request, git, changes } = await fixture(true);
    expect(await changes.status(10, request)).toMatchObject({ branch: 'main', head: null, changes: [] });
    // Windows file names cannot contain newlines.
    const filename = process.platform === 'win32' ? 'odd [name] 雪.txt' : 'odd [name]\n雪.txt'; await writeFile(path.join(directory, filename), 'new content');
    const status = await changes.status(10, request);
    expect(status.changes[0]).toMatchObject({ path: filename, untracked: true });
    expect((await changes.diff(10, { ...request, path: filename, area: 'untracked' })).patch).toContain('+new content');
    git('add', '--', filename); git('commit', '-m', 'Literal filename');
    await writeFile(path.join(directory, filename), 'modified literal content\n');
    expect((await changes.diff(10, { ...request, path: filename, area: 'working' })).patch).toContain('+modified literal content');
  });

  it('reviews renames, deletions and binary files, and rejects stale change requests', async () => {
    const { directory, request, git, changes } = await fixture(true);
    await writeFile(path.join(directory, 'old name.txt'), 'rename baseline\n');
    await writeFile(path.join(directory, 'deleted.txt'), 'delete me\n');
    await writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2])); git('add', '.'); git('commit', '-m', 'Baseline');
    git('mv', 'old name.txt', 'new name.txt'); await rm(path.join(directory, 'deleted.txt'));
    await writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 2, 3]));
    const status = await changes.status(10, request);
    expect(status.changes.find((item) => item.path === 'new name.txt')).toMatchObject({ originalPath: 'old name.txt', indexStatus: 'R' });
    expect((await changes.diff(10, { ...request, path: 'new name.txt', area: 'staged' })).patch).toContain('rename to new name.txt');
    expect((await changes.diff(10, { ...request, path: 'deleted.txt', area: 'working' })).patch).toContain('-delete me');
    expect((await changes.diff(10, { ...request, path: 'binary.bin', area: 'working' })).binary).toBe(true);
    await expect(changes.diff(10, { ...request, path: 'deleted.txt', area: 'staged' })).rejects.toThrow('no longer present');
    await expect(changes.diff(10, { ...request, path: '../escape', area: 'working' })).rejects.toThrow();
  });

  it('uses the real repository root from a selected subdirectory and reports non-repositories', async () => {
    const fixtureRepo = await fixture(true); await mkdir(path.join(fixtureRepo.directory, 'src'));
    const child = await fixtureRepo.files.open(10, { directory: path.join(fixtureRepo.directory, 'src') });
    expect((await fixtureRepo.changes.status(10, { repositoryId: child.id })).root).toBe(fixtureRepo.directory);
    const plain = await fixture(); await expect(plain.changes.status(10, plain.request)).rejects.toThrow('not an accessible Git working tree');
  });

  it('reports unsupported diff encodings rather than replacing source bytes', async () => {
    const { directory, request, git, changes } = await fixture(true);
    await writeFile(path.join(directory, 'legacy.txt'), Buffer.from([0xe9, 10])); git('add', '.'); git('commit', '-m', 'Legacy encoding');
    await writeFile(path.join(directory, 'legacy.txt'), Buffer.from([0xea, 10]));
    await expect(changes.diff(10, { ...request, path: 'legacy.txt', area: 'working' })).rejects.toThrow('unsupported text encoding');
  });

  it('identifies real merge conflicts and exposes their combined diff', async () => {
    const { directory, request, git, changes } = await fixture(true);
    await writeFile(path.join(directory, 'conflict.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'Base');
    git('checkout', '-b', 'other'); await writeFile(path.join(directory, 'conflict.txt'), 'other\n'); git('commit', '-am', 'Other');
    git('checkout', 'main'); await writeFile(path.join(directory, 'conflict.txt'), 'main\n'); git('commit', '-am', 'Main');
    expect(() => git('merge', '--no-edit', 'other')).toThrow();
    expect((await changes.status(10, request)).changes[0]).toMatchObject({ conflicted: true, indexStatus: 'U', worktreeStatus: 'U' });
    expect(await changes.diff(10, { ...request, path: 'conflict.txt', area: 'working' })).toMatchObject({ conflicted: true });
  });
});
