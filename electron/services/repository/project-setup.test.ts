import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSetup } from './project-setup';
const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() { const parent = mkdtempSync(path.join(os.tmpdir(), 'hub-project-')); roots.push(parent); const execute = vi.fn(async () => ''); const findGitHub = vi.fn(async () => ({ file: '/gh', prefixArgs: [], extraEnv: {}, displayPath: '/gh' })); return { parent, execute, findGitHub, service: new ProjectSetup({ execute, findGitHub }) }; }
it('creates local folders without login, validates paths, and preserves existing files', async () => {
  const { parent, service, execute } = fixture(); const result = await service.execute({ action: 'create', parent, name: 'new-project', initializeGit: false }); expect(result).toEqual({ directory: path.join(parent, 'new-project') }); expect(execute).not.toHaveBeenCalled();
  writeFileSync(path.join(parent, 'new-project', 'preserve.txt'), 'keep');
  await expect(service.execute({ action: 'create', parent, name: 'new-project', initializeGit: true })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' }); expect(readFileSync(path.join(parent, 'new-project', 'preserve.txt'), 'utf8')).toBe('keep');
  expect(await service.execute({ action: 'validate', directory: parent })).toEqual({ directory: parent });
  for (const name of ['../outside', 'CON', 'bad.', '--flags']) await expect(service.execute({ action: 'create', parent, name, initializeGit: false })).rejects.toMatchObject({ code: 'INVALID_PROJECT_REQUEST' });
});
it('uses fixed GitHub CLI listing/clone arguments and never accepts URLs or arbitrary commands', async () => {
  const { parent, service, execute } = fixture(); const repos = [{ nameWithOwner: 'owner/project', description: 'Code', isPrivate: true, updatedAt: '2026-01-01' }]; execute.mockResolvedValueOnce(JSON.stringify(repos));
  expect(await service.execute({ action: 'github-list' })).toEqual(repos); expect(execute.mock.calls[0][1]).toEqual(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,description,isPrivate,updatedAt']);
  await service.execute({ action: 'github-clone', repository: 'owner/project', parent }); expect(execute.mock.calls[1][1]).toEqual(['repo', 'clone', 'owner/project', path.join(parent, 'project'), '--', '--config', 'core.hooksPath=']);
  expect(execute.mock.calls[2]).toEqual(['git', ['-C', path.join(parent, 'project'), 'config', '--unset', 'core.hooksPath'], parent]);
  await expect(service.execute({ action: 'github-clone', repository: 'https://evil.invalid/repo', parent })).rejects.toMatchObject({ code: 'INVALID_PROJECT_REQUEST' });
  execute.mockRejectedValueOnce(new Error('private token')); await expect(service.execute({ action: 'github-clone', repository: 'owner/other', parent })).rejects.toMatchObject({ code: 'PROJECT_SETUP_FAILED' }); expect(existsSync(path.join(parent, 'other'))).toBe(true);
});
