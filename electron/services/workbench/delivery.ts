import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DeliveryStatus, DeliveryResult } from '../../../shared/productivity';
import { directory } from './local-store';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';
import { parseStatus } from '../repository/git';
import { readOnlyGitOptions } from '../repository/git-safety';
import { validateRelativePath } from '../repository/filesystem';
const run = promisify(execFile);
const reference = { directory: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{64}$/) };
const schema = z.discriminatedUnion('action', [
 z.object({ action: z.literal('flow-git-inspect'), directory: reference.directory }).strict(),
 z.object({ action: z.enum(['flow-git-stage','flow-git-unstage']), ...reference, paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict(),
 z.object({ action: z.literal('flow-git-commit'), ...reference, message: z.string().trim().min(1).max(2000) }).strict(),
 z.object({ action: z.literal('flow-git-push'), ...reference, remote: z.string().min(1).max(100) }).strict(),
 z.object({ action: z.literal('flow-git-pr'), ...reference, title: z.string().trim().min(1).max(200), body: z.string().max(10000), base: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(150), draft: z.boolean() }).strict(),
]);
export class Delivery {
 private busy = new Set<string>();
 constructor(private confirm: (title: string, detail: string) => Promise<boolean>, private ready: () => void) {}
 private async command(cwd: string, file: string, args: string[], timeout = 15000) {
  try { const result = await run(file, args, { cwd, env: { ...hostEnvironment(), GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, windowsHide: true, encoding: 'buffer', timeout, maxBuffer: 4 * 1024 * 1024 }); return Buffer.from(result.stdout); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; throw new HubError('DELIVERY_FAILED', code === 'ENOENT' ? `${file} was not found on PATH.` : 'The command failed or timed out. Check local Git/GitHub authentication, hooks, branch protection, and remote access. Refresh before retrying.'); }
 }
 /** Streams command output into the review hash; whole-repository diffs can exceed any reasonable buffer. */
 private hashOutput(cwd: string, args: string[], hash: ReturnType<typeof createHash>, timeout = 15000) {
  return new Promise<void>((resolve, reject) => {
   const child = spawn('git', args, { cwd, env: { ...hostEnvironment(), GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
   const timer = setTimeout(() => child.kill(), timeout);
   child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
   child.on('error', (error) => { clearTimeout(timer); reject(new HubError('DELIVERY_FAILED', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git was not found on PATH.' : 'The command failed or timed out. Refresh before retrying.')); });
   child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new HubError('DELIVERY_FAILED', 'Git could not read the pending changes or timed out. Refresh before retrying.')); });
  });
 }
 async inspect(input: string): Promise<DeliveryStatus> {
  const cwd = directory(input); const root = directory((await this.command(cwd, 'git', [...await readOnlyGitOptions(cwd), 'rev-parse','--show-toplevel'])).toString().trim());
  // The review only reads: the repository's own config must not run programs (fsmonitor, filters) before the person
  // has confirmed anything. The confirmed commit and push below run the repository's hooks as usual.
  const safe = await readOnlyGitOptions(root);
  // --no-optional-locks: never take index.lock while agents may be running their own git commands.
  const status = parseStatus(await this.command(root, 'git', ['--no-optional-locks',...safe,'status','--porcelain=v2','-z','--branch','--untracked-files=all']), root);
  if (status.limited) throw new HubError('DELIVERY_LIMIT', 'Too many changes for a safe delivery review. Use local Git tools.');
  const hash = createHash('sha256').update(JSON.stringify(status));
  await this.hashOutput(root, [...safe,'diff','--no-ext-diff','--no-textconv','--binary'], hash); hash.update('\0cached\0'); await this.hashOutput(root, [...safe,'diff','--cached','--no-ext-diff','--no-textconv','--binary'], hash);
  let reviewedBytes = 0;
  for (const item of status.changes.filter((change) => change.untracked)) {
   // Git lists an untracked nested repository or worktree as a directory with a trailing slash.
   if (item.path.endsWith('/')) { validateRelativePath(item.path.slice(0, -1)); hash.update(JSON.stringify({path:item.path,kind:'directory'})); continue; }
   validateRelativePath(item.path); const file = path.join(root, item.path); if (fs.lstatSync(file).isSymbolicLink()) hash.update(JSON.stringify({path:item.path,kind:'link',value:fs.readlinkSync(file)})); else { reviewedBytes += fs.statSync(file).size; if (fs.statSync(file).size > 4 * 1024 * 1024 || reviewedBytes > 16 * 1024 * 1024) throw new HubError('DELIVERY_LIMIT', 'An untracked file exceeds the review limit. Use local Git tools.'); hash.update(JSON.stringify({path:item.path,kind:'file',digest:createHash('sha256').update(fs.readFileSync(file)).digest('hex')})); } }
  const remotes = (await this.command(root, 'git', ['remote'])).toString().trim().split(/\r?\n/).filter(Boolean);
  for (const remote of remotes) hash.update(JSON.stringify({remote,urls:(await this.command(root, 'git', ['remote', 'get-url', '--all', remote])).toString(),pushUrls:(await this.command(root, 'git', ['remote', 'get-url', '--push', '--all', remote])).toString()}));
  return { directory: root, branch: status.branch, head: status.head, revision: hash.digest('hex'), renames: Object.fromEntries(status.changes.filter((item) => item.originalPath).map((item) => [item.path, item.originalPath!])), staged: status.changes.filter((item) => !item.untracked && item.indexStatus !== ' ').map((item) => item.path), unstaged: status.changes.filter((item) => (item.untracked && !item.path.endsWith('/')) || (!item.untracked && item.worktreeStatus !== ' ')).map((item) => item.path), remotes };
 }
 async execute(input: unknown): Promise<DeliveryStatus | DeliveryResult | null> {
  const request = schema.parse(input); if (request.action === 'flow-git-inspect') return this.inspect(request.directory);
  this.ready(); const status = await this.inspect(request.directory); const cwd = status.directory;
  if (this.busy.has(cwd)) throw new HubError('DELIVERY_BUSY', 'Another delivery operation is running for this repository.');
  if (request.revision !== status.revision) throw new HubError('DELIVERY_STALE', 'Changes have moved since review. Refresh and review again.');
  if (!status.branch && ['flow-git-push','flow-git-pr'].includes(request.action)) throw new HubError('DELIVERY_BRANCH', 'Check out a named branch before delivering it.');
  this.busy.add(cwd);
  try {
   let args: string[]; let detail: string; let file = 'git'; let temp: string | null = null;
   if (request.action === 'flow-git-stage' || request.action === 'flow-git-unstage') {
    for (const item of request.paths) { validateRelativePath(item); if (!(request.action === 'flow-git-stage' ? status.unstaged : status.staged).includes(item)) throw new HubError('DELIVERY_PATH', 'A selected path is no longer in this change list.'); }
    // Unstaging a rename must reset both sides; staging only names the new path (the old one no longer exists).
    const paths = request.action === 'flow-git-stage' ? request.paths : [...new Set(request.paths.flatMap((item) => status.renames[item] ? [item, status.renames[item]] : [item]))]; paths.forEach((item) => validateRelativePath(item));
    args = request.action === 'flow-git-stage' ? ['add','--',...paths] : status.head ? ['reset','-q','HEAD','--',...paths] : ['reset','-q','--',...paths]; detail = `Update the index for these paths. Working files are preserved.\n${request.paths.join('\n')}`;
   } else if (request.action === 'flow-git-commit') {
    if (!status.staged.length) throw new HubError('DELIVERY_EMPTY', 'Stage reviewed changes before committing.');
    args = ['commit','-m',request.message]; detail = `Commit ALL staged paths:\n${status.staged.join('\n')}\n\nMessage:\n${request.message}\nLocal Git hooks may execute project code.`;
   } else if (request.action === 'flow-git-push') {
    if (!status.remotes.includes(request.remote)) throw new HubError('DELIVERY_REMOTE', 'Select an existing remote.');
    args = ['push','--',request.remote,`HEAD:refs/heads/${status.branch}`]; detail = `Push current HEAD to ${request.remote}/${status.branch}. No force push. Remote hooks and local Git configuration apply.`;
   } else if (request.action === 'flow-git-pr') {
    if (status.staged.length || status.unstaged.length) throw new HubError('DELIVERY_DIRTY', 'Commit or otherwise review pending changes before creating a pull request.');
    file = 'gh'; args = ['pr','create','--head',status.branch!,'--base',request.base,'--title',request.title,...(request.draft ? ['--draft'] : [])]; detail = `Create ${request.draft ? 'draft ' : ''}pull request using your local gh account. Push the branch first.\n${status.branch} → ${request.base}\n${request.title}\n\n${request.body}`;
   } else { throw new HubError('INVALID_REQUEST', 'Unknown delivery action.'); }
   if (!await this.confirm('Review Git delivery', `${cwd}\n\n${detail}`)) return null;
   this.ready(); if ((await this.inspect(cwd)).revision !== status.revision) throw new HubError('DELIVERY_STALE', 'The repository changed while confirmation was open. Nothing was executed.');
   try {
    if (request.action === 'flow-git-pr') { temp = fs.mkdtempSync(path.join(os.tmpdir(),'hub-pr-')); const body = path.join(temp,'body.md'); fs.writeFileSync(body, request.body, { mode: 0o600 }); args.push('--body-file',body); }
    const output = (await this.command(cwd,file,args,120000)).toString().slice(-4096).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@');
    const candidate = request.action === 'flow-git-pr' ? output.trim().split('\n').at(-1) ?? '' : '';
    const url = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(candidate) ? candidate : null;
    return { output: output || 'Command completed successfully. Refresh to review current state.', url };
   } finally { if (temp) fs.rmSync(temp,{ recursive:true,force:true }); }
  } finally { this.busy.delete(cwd); }
 }
 get running() { return this.busy.size > 0; }
}
