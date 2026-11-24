import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/workbench';
import { Delivery } from './delivery';
import { Tasks } from './tasks';
import type { Verification } from './verification';
import { branchName, TaskPullRequests, withNote, type GitHubSignIn, type TaskPullRequestDeps } from './task-pr';
/** Many real Git commands in each test: a busy Windows runner can take longer than the 5 s default. */
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
// The commit runs git with the user's environment; CI runners have no commit identity configured.
const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }; const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [key, value] of Object.entries(identity)) { saved[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
function folder() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-task-pr-')); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const PR = 'https://github.com/owner/repo/pull/12';

/** A project on "GitHub" (a bare repository standing in for it) with one commit on main, and a Tasks board with one task in review. */
async function setup(options: { remote?: boolean; knownHead?: boolean; signIn?: GitHubSignIn; checks?: { passed: boolean; summary: string } | null; agent?: { name: string | null; reply: string | null }; task?: Partial<Task> } = {}) {
  const work = folder(); const remote = folder();
  git(remote, 'init', '--bare', '-b', 'main');
  git(work, 'init', '-b', 'main'); git(work, 'config', 'commit.gpgsign', 'false'); fs.writeFileSync(path.join(work, 'README.md'), 'hello\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'Start');
  if (options.remote !== false) { git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); if (options.knownHead !== false) git(work, 'remote', 'set-head', 'origin', 'main'); }
  const tasks = new Tasks(folder(), {} as Verification);
  const created = await tasks.execute({ action: 'task-save', title: 'Add a dark mode switch', details: 'In Settings.', directory: work, sessionId: '00000000-0000-4000-8000-000000000001', scope: ['**'], status: 'review', notes: 'Look at the colours.', verificationId: null }) as Task;
  if (options.task?.pullRequest) await tasks.execute({ action: 'task-pr', id: created.id, url: options.task.pullRequest });
  const opened: { folder: string; head: string; base: string; title: string; body: string }[] = []; let changed = 0;
  const deps: TaskPullRequestDeps = { enabled: () => true, tasks, delivery: new Delivery(async () => true, () => {}), changed: () => { changed++; },
    checks: async () => options.checks === undefined ? { passed: true, summary: 'Checks passed: npm test' } : options.checks,
    agent: () => options.agent ?? { name: 'Claude Code', reply: 'I added the switch and its test.' },
    github: async () => options.signIn ?? 'signed-in', isGitHub: () => true,
    openPullRequest: async (cwd, request) => { opened.push({ folder: cwd, ...request }); return `Creating pull request\n${PR}\n`; } };
  const service = new TaskPullRequests(deps);
  const task = () => tasks.list().find((item) => item.id === created.id)!;
  return { work, remote, tasks, service, opened, task, id: created.id, changes: () => changed };
}
const remoteBranch = (remote: string, branch: string) => { try { return git(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; } };

describe('a pull request for a task ready for review', () => {
  it('makes a branch off main, commits everything, pushes it and opens the pull request', async () => {
    const { work, remote, service, opened, task, id, changes } = await setup();
    const mainBefore = git(remote, 'rev-parse', 'refs/heads/main');
    fs.writeFileSync(path.join(work, 'README.md'), 'hello, dark mode\n'); fs.writeFileSync(path.join(work, 'switch.ts'), 'export const dark = true;\n');
    await service.ready(id);
    expect(git(work, 'branch', '--show-current')).toBe('trace/add-a-dark-mode-switch');
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(git(work, 'log', '-1', '--format=%B')).toBe('Add a dark mode switch\n\nTask: Add a dark mode switch\n\nIn Settings.');
    expect(remoteBranch(remote, 'trace/add-a-dark-mode-switch')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
    expect(opened).toHaveLength(1); expect(opened[0]).toMatchObject({ head: 'trace/add-a-dark-mode-switch', base: 'main', title: 'Add a dark mode switch' });
    expect(opened[0].body).toContain('## Task\nAdd a dark mode switch\n\nIn Settings.\n\nDone by Claude Code.');
    expect(opened[0].body).toContain('I added the switch and its test.'); expect(opened[0].body).toContain('- `README.md`\n- `switch.ts`'); expect(opened[0].body).toContain('## Checks\nChecks passed: npm test');
    expect(task().pullRequest).toBe(PR); expect(task().notes).toBe('Look at the colours.\nTrace: Opened a pull request from branch trace/add-a-dark-mode-switch.'); expect(changes()).toBe(1);
  });
  it('works for a Gemini channel: the pull request is complete without its summary, which Trace cannot read', async () => {
    const { work, service, opened, task, id } = await setup({ agent: { name: 'Gemini', reply: null }, knownHead: false });
    fs.writeFileSync(path.join(work, 'switch.ts'), 'export const dark = true;\n');
    await service.ready(id);
    // Without origin/HEAD, the main branch is asked of the remote.
    expect(opened[0]).toMatchObject({ head: 'trace/add-a-dark-mode-switch', base: 'main' });
    expect(opened[0].body).toContain('Done by Gemini.'); expect(opened[0].body).toContain("## What the agent said\nGemini's summary of its work was not available.");
    expect(opened[0].body).toContain('- `switch.ts`'); expect(opened[0].body).toContain('## Checks\nChecks passed: npm test'); expect(opened[0].body).not.toContain('Gemini CLI');
    expect(task().pullRequest).toBe(PR);
  });
  it('keeps a branch the project is already on, and picks a free name off main', async () => {
    const { work, remote, service, opened, id } = await setup();
    git(work, 'switch', '-c', 'feature/colours'); fs.writeFileSync(path.join(work, 'a.ts'), 'a\n');
    await service.ready(id);
    expect(opened[0].head).toBe('feature/colours'); expect(remoteBranch(remote, 'feature/colours')).toBe(git(work, 'rev-parse', 'HEAD'));
    const second = await setup(); git(second.work, 'branch', 'trace/add-a-dark-mode-switch'); fs.writeFileSync(path.join(second.work, 'b.ts'), 'b\n');
    await second.service.ready(second.id); expect(second.opened[0].head).toBe('trace/add-a-dark-mode-switch-2');
  });
  it('only pushes when the task already has its pull request', async () => {
    const { work, remote, service, opened, task, id } = await setup({ task: { pullRequest: 'https://github.com/owner/repo/pull/3' } });
    git(work, 'switch', '-c', 'trace/add-a-dark-mode-switch'); fs.writeFileSync(path.join(work, 'c.ts'), 'c\n');
    await service.ready(id);
    expect(opened).toEqual([]); expect(remoteBranch(remote, 'trace/add-a-dark-mode-switch')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(task().pullRequest).toBe('https://github.com/owner/repo/pull/3'); expect(task().notes).toContain('Trace: Sent the new changes to its pull request');
  });
});

describe('when something is missing, nothing changes and the task says why', () => {
  /** Nothing committed, no branch made, nothing opened. */
  const untouched = (work: string, opened: unknown[]) => { expect(git(work, 'branch', '--show-current')).toBe('main'); expect(git(work, 'rev-list', '--count', 'HEAD')).toBe('1'); expect(git(work, 'status', '--porcelain')).not.toBe(''); expect(opened).toEqual([]); };
  it('no GitHub remote', async () => {
    const { work, service, opened, task, id } = await setup({ remote: false }); fs.writeFileSync(path.join(work, 'x.ts'), 'x\n');
    await service.ready(id); untouched(work, opened);
    expect(task().notes).toMatch(/^Look at the colours\.\nTrace: No pull request: this project is not on GitHub yet\./); expect(task().pullRequest).toBeUndefined();
  });
  it('GitHub not signed in', async () => {
    const { work, service, opened, task, id } = await setup({ signIn: 'signed-out' }); fs.writeFileSync(path.join(work, 'x.ts'), 'x\n');
    await service.ready(id); untouched(work, opened);
    expect(task().notes).toContain('Trace: No pull request: sign in to GitHub in Accounts & connections to have pull requests opened for you.');
  });
  it('the checks failed', async () => {
    const { work, service, opened, task, id } = await setup({ checks: { passed: false, summary: 'npm test failed.' } }); fs.writeFileSync(path.join(work, 'x.ts'), 'x\n');
    await service.ready(id); untouched(work, opened);
    expect(task().notes).toContain("Trace: No pull request: the project's checks did not pass (npm test failed). Fix them, or ask the agent to.");
  });
  it('nothing to commit', async () => {
    const { work, service, opened, task, id } = await setup();
    await service.ready(id);
    expect(git(work, 'branch', '--show-current')).toBe('main'); expect(opened).toEqual([]);
    expect(task().notes).toContain('Trace: No pull request: there are no changes in this project to send.');
  });
  it('GitHub refused the push: never forced, and the note says the changes are committed on the branch', async () => {
    const { work, remote, service, opened, task, id } = await setup();
    // Someone else pushed the same branch first: a push of ours would not be a fast-forward.
    const other = folder(); git(other, 'clone', remote, '.'); git(other, 'switch', '-c', 'feature/x'); fs.writeFileSync(path.join(other, 'theirs.ts'), 't\n'); git(other, 'add', '.'); git(other, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Theirs'); git(other, 'push', 'origin', 'feature/x');
    const theirs = remoteBranch(remote, 'feature/x');
    git(work, 'switch', '-c', 'feature/x'); fs.writeFileSync(path.join(work, 'ours.ts'), 'o\n');
    await service.ready(id);
    expect(remoteBranch(remote, 'feature/x')).toBe(theirs); expect(opened).toEqual([]);
    expect(task().notes).toContain('Trace: No pull request: GitHub did not accept the push of branch feature/x. Your changes are committed on it here.');
  });
  it('does nothing when turned off, or for a task not in review', async () => {
    const { work, tasks, service, opened, task, id } = await setup(); fs.writeFileSync(path.join(work, 'x.ts'), 'x\n');
    const off = new TaskPullRequests({ enabled: () => false } as TaskPullRequestDeps); await off.ready(id);
    await tasks.execute({ action: 'task-status', id, status: 'active' }); await service.ready(id);
    expect(task().notes).toBe('Look at the colours.'); expect(opened).toEqual([]); expect(git(work, 'branch', '--show-current')).toBe('main');
  });
});

describe('notes and names', () => {
  it('replaces its own last note and keeps the person’s', () => {
    expect(withNote('Mine.\nTrace: old reason', 'new\nreason')).toBe('Mine.\nTrace: new reason');
    expect(withNote('', 'x')).toBe('Trace: x');
    expect(withNote('a'.repeat(1990), 'reason').length).toBe(2000);
  });
  it('names the branch after the task', () => {
    expect(branchName('Fix: the “Save” button!')).toBe('trace/fix-the-save-button');
    expect(branchName('***')).toBe('trace/task');
    expect(branchName('a'.repeat(60))).toBe(`trace/${'a'.repeat(40)}`);
  });
});
