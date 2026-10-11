import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { ProjectResponse } from '../../../shared/projects';
import { findGitHub } from '../cli/account-connections';
import { hostEnvironment, type Executable } from '../cli/discovery';
import { HubError } from '../cli/engine-adapter';
const directory = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const owner = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const folder = z.string().regex(/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/).refine((value) => !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), 'Choose a regular folder name.');
const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/);
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('github-list'), owner: owner.optional() }).strict(), z.object({ action: z.literal('github-clone'), repository, parent: directory }).strict(), z.object({ action: z.literal('create'), parent: directory, name: folder, initializeGit: z.boolean() }).strict(), z.object({ action: z.literal('validate'), directory }).strict()]);
const repoSchema = z.array(z.object({ nameWithOwner: repository, description: z.string().max(10000).nullable(), isPrivate: z.boolean(), updatedAt: z.string().max(100) }).strict()).max(100);
function execute(file: string, args: string[], cwd?: string): Promise<string> { return new Promise((resolve, reject) => execFile(file, args, { cwd, env: hostEnvironment(), timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new HubError('PROJECT_COMMAND_FAILED', 'The CLI operation failed or timed out. Check Git/GitHub CLI installation, login, network access, and repository permissions.')) : resolve(stdout))); }
export class ProjectSetup {
  private busy = false;
  get active() { return this.busy; }
  constructor(private dependencies: { findGitHub?: () => Promise<Executable>; execute?: typeof execute } = {}) {}
  private canonical(directory: string) { try { const root = fs.realpathSync(directory); if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory'); return root; } catch { throw new HubError('PROJECT_DIRECTORY', 'This folder does not exist or is inaccessible. Browse an existing folder, or create a new project.'); } }
  async execute(input: unknown): Promise<ProjectResponse> {
    const parsed = schema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_PROJECT_REQUEST', 'Use an absolute folder path, a regular project name, and an owner/repository GitHub name.'); const request = parsed.data;
    if (request.action === 'validate') return { directory: this.canonical(request.directory) };
    if (this.busy) throw new HubError('PROJECT_BUSY', 'A project operation is already in progress.'); this.busy = true;
    const run = this.dependencies.execute ?? execute;
    try {
      if (request.action === 'github-list') {
        const gh = await (this.dependencies.findGitHub ?? findGitHub)();
        const args = ['repo', 'list', ...(request.owner ? [request.owner] : []), '--limit', '100', '--json', 'nameWithOwner,description,isPrivate,updatedAt'];
        const text = await run(gh.file, args); const result = repoSchema.safeParse(JSON.parse(text));
        if (!result.success) throw new HubError('GITHUB_REPOSITORIES', 'Repository list had an unsupported format. Refresh or update GitHub CLI.'); return result.data;
      }
      const parent = this.canonical(request.parent); const name = request.action === 'create' ? request.name : request.repository.split('/')[1];
      if (!folder.safeParse(name).success) throw new HubError('PROJECT_NAME', 'The repository name cannot be used as a local folder name on this system. Clone it under another name in your system terminal, then browse and open it.'); const target = path.join(parent, name);
      // Reserve an empty destination atomically. Never replace or delete existing user folders.
      try { fs.mkdirSync(target, { recursive: false, mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HubError('PROJECT_EXISTS', 'That project folder already exists. Browse and open it, or choose a different parent folder.'); throw error; }
      try {
        if (request.action === 'github-clone') {
          const gh = await (this.dependencies.findGitHub ?? findGitHub)();
          await run(gh.file, ['repo', 'clone', request.repository, target, '--', '--config', 'core.hooksPath='], parent);
        } else if (request.initializeGit) await run('git', ['-c', 'core.hooksPath=', 'init', '-b', 'main', '--', target], parent);
      } catch { throw new HubError('PROJECT_SETUP_FAILED', `Setup could not finish. The folder and any partial files were preserved at ${target}. Check CLI installation, login, network access, and permissions. You can browse and open this folder.`); }
      return { directory: this.canonical(target) };
    } finally { this.busy = false; }
  }
}
