import type { Task } from '../../../shared/workbench';
import { HubError } from '../cli/engine-adapter';
import { noHookGitOptions } from '../repository/git-safety';
import { createPullRequest, deliveryCommand, pullRequestUrl, type Delivery } from './delivery';
import type { Tasks } from './tasks';

/** Whether GitHub CLI is there and signed in (Accounts & connections). */
export type GitHubSignIn = 'signed-in' | 'signed-out' | 'missing' | 'unknown';
export interface TaskPullRequestDeps {
  enabled(): boolean;
  tasks: Pick<Tasks, 'list' | 'setNotes' | 'execute'>;
  delivery: Pick<Delivery, 'inspect' | 'hold'>;
  /** The project's automatic checks on its files as they are now (AutoChecks.settled); null when it has none or they are off. */
  checks(folder: string, sessionId: string): Promise<{ passed: boolean; summary: string } | null>;
  /** The task channel's agent as people call it ("Gemini") and its last reply; reply is null when Trace cannot read that agent's conversation. */
  agent(sessionId: string | null): { name: string | null; reply: string | null };
  github(): Promise<GitHubSignIn>;
  /** A task changed: the window reads the board again. */
  changed(): void;
  /** Opens the pull request and returns what gh printed (createPullRequest); tests pass a fake, as gh cannot run there. */
  openPullRequest?(folder: string, request: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<string>;
  /** Whether a remote's URL is on GitHub; tests count a local bare repository as one. */
  isGitHub?(url: string): boolean;
}

/** A note Trace adds says why there is no pull request; the reason starts every one, so move the task back to try again. */
const AGAIN = 'Then move the task to Ready for review again.';
/** Notes Trace wrote start with this; each new one replaces the last, so retries do not pile up. */
const MARK = 'Trace: ';
const onGitHub = (url: string) => /(^|[@/])github\.com[/:]/i.test(url.trim());
/** A branch name from the task's title: trace/add-dark-mode-switch. */
export const branchName = (title: string) => `trace/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task'}`;
/** The task's notes with Trace's note in place of its last one, on one line, within the 2000 characters notes hold. */
export function withNote(notes: string, note: string) {
  const kept = notes.split('\n').filter((line) => !line.startsWith(MARK)).join('\n').trim(); const line = MARK + note.replace(/\s+/g, ' ').trim().slice(0, 900);
  const value = kept ? `${kept}\n${line}` : line; return value.length > 2000 ? `…${value.slice(-1999)}` : value;
}
/** Why nothing was opened, as the task shows it: what happened and what to do. */
class Refusal extends Error {}

/**
 * Pull requests for finished tasks (1.39.0): when a task moves to Ready for review in a GitHub project, and its checks
 * pass, Trace commits the project's changes on a branch of its own, pushes it and opens a pull request with a summary,
 * then puts the link on the task. Turning this on stands in for Ship's confirmations for this flow only. Nothing is ever
 * forced or pushed to the main branch; when something is missing, nothing is changed and a note on the task says why.
 */
export class TaskPullRequests {
  private working = new Set<string>();
  constructor(private deps: TaskPullRequestDeps) {}
  get running() { return this.working.size > 0; }
  /** A task moved to Ready for review: its pull request, or a note saying why there is none. Never throws. */
  async ready(id: string): Promise<void> {
    if (!this.deps.enabled() || this.working.has(id)) return;
    const task = this.deps.tasks.list().find((item) => item.id === id); if (!task || task.status !== 'review') return;
    this.working.add(id);
    try { const done = await this.deliver(task); if (done) this.note(id, done.note, done.url); }
    catch (error) { this.note(id, error instanceof Refusal ? error.message : `No pull request was opened: ${error instanceof HubError ? error.message : 'something unexpected went wrong.'}`); }
    finally { this.working.delete(id); this.deps.changed(); }
  }
  private note(id: string, note: string, url?: string) {
    try {
      const task = this.deps.tasks.list().find((item) => item.id === id); if (!task) return;
      this.deps.tasks.setNotes(id, withNote(task.notes, note));
      if (url) void this.deps.tasks.execute({ action: 'task-pr', id, url });
    } catch { /* The task was removed meanwhile. */ }
  }
  private git(cwd: string, args: string[], timeout?: number) { return deliveryCommand(cwd, 'git', args, timeout).then((output) => output.toString().trim()); }
  private async deliver(task: Task): Promise<{ note: string; url?: string } | null> {
    const first = await this.deps.delivery.inspect(task.directory).catch((error) => { if (error instanceof HubError && error.code === 'NOT_A_REPOSITORY') throw new Refusal('No pull request: this project does not use Git, so there is nothing to send to GitHub.'); throw error; });
    const root = first.directory; const isGitHub = this.deps.isGitHub ?? onGitHub;
    // origin first, as people and GitHub name it; else the first remote on GitHub.
    const remotes = [...first.remotes].sort((a, b) => Number(b === 'origin') - Number(a === 'origin')); let remote: string | null = null;
    for (const name of remotes) if (isGitHub(await this.git(root, ['remote', 'get-url', '--push', name]).catch(() => ''))) { remote = name; break; }
    if (!remote) throw new Refusal(`No pull request: this project is not on GitHub yet. Publish it to GitHub (GitHub Desktop or "gh repo create" can do it). ${AGAIN}`);
    const signIn = await this.deps.github();
    if (signIn !== 'signed-in') throw new Refusal(signIn === 'missing' ? `No pull request: GitHub CLI is not installed. Install it and sign in to GitHub in Accounts & connections to have pull requests opened for you. ${AGAIN}` : signIn === 'signed-out' ? `No pull request: sign in to GitHub in Accounts & connections to have pull requests opened for you. ${AGAIN}` : `No pull request: Trace could not tell whether GitHub is signed in. Check Accounts & connections. ${AGAIN}`);
    const checks = task.sessionId ? await this.deps.checks(task.directory, task.sessionId) : null;
    if (checks && !checks.passed) throw new Refusal(`No pull request: the project's checks did not pass (${checks.summary.replace(/\.$/, '')}). Fix them, or ask the agent to. ${AGAIN}`);
    // The checks can take minutes: the person may have moved the task on, or the files changed, meanwhile.
    if (this.deps.tasks.list().find((item) => item.id === task.id)?.status !== 'review') return null;
    return this.deps.delivery.hold(root, async () => {
      const status = await this.deps.delivery.inspect(root); const changes = [...new Set([...status.staged, ...status.unstaged])];
      const base = await this.defaultBranch(root, remote!);
      const ahead = await this.git(root, ['rev-list', '--count', `refs/remotes/${remote}/${base}..HEAD`]).then(Number, () => status.head ? 1 : 0);
      if (!changes.length && !ahead) throw new Refusal(`No pull request: there are no changes in this project to send. ${AGAIN.replace('Then m', 'M')} once there are.`);
      let branch = status.branch;
      if (!branch || branch === base) {
        branch = branchName(task.title); for (let n = 2; await this.exists(root, remote!, branch); n++) branch = `${branchName(task.title)}-${n}`;
        // Only HEAD moves to the new branch (the same commit); the repository's checkout hooks are not run for it.
        await this.git(root, [...noHookGitOptions(), 'switch', '-c', branch]);
      }
      if (branch === base) throw new Refusal('No pull request: Trace never pushes to the main branch.');
      if (changes.length) {
        // As Ship commits: the repository's own hooks run.
        await this.git(root, ['add', '--all']);
        await this.git(root, ['commit', '-m', task.title, '-m', `Task: ${task.title}${task.details ? `\n\n${task.details}` : ''}`], 120000).catch((error) => { throw new Refusal(`No pull request: Git could not commit the changes on branch ${branch}. ${error instanceof HubError ? error.message : ''}`); });
      }
      // Never forced: a push GitHub refuses stops here, with what it said.
      await this.git(root, ['push', '--', remote!, `HEAD:refs/heads/${branch}`], 120000).catch((error) => { throw new Refusal(`No pull request: GitHub did not accept the push of branch ${branch}. Your changes are committed on it here. ${error instanceof HubError ? error.message : ''}`); });
      if (task.pullRequest) return { note: `Sent the new changes to its pull request on branch ${branch}.` };
      const files = await this.git(root, ['diff', '--name-only', `refs/remotes/${remote}/${base}...HEAD`]).then((text) => text.split(/\r?\n/).filter(Boolean), () => changes);
      const output = await (this.deps.openPullRequest ?? createPullRequest)(root, { head: branch, base, title: task.title, body: this.body(task, files, checks), draft: false });
      const url = pullRequestUrl(output);
      if (!url) throw new Refusal(`No pull request: branch ${branch} is on GitHub, but GitHub did not give back a pull request link. Open one from the branch on GitHub.`);
      return { note: `Opened a pull request from branch ${branch}.`, url };
    });
  }
  /** GitHub's main branch, as Git last heard it (origin/HEAD), else asked of the remote. */
  private async defaultBranch(root: string, remote: string) {
    const known = await this.git(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '');
    if (known.startsWith(`${remote}/`)) return known.slice(remote.length + 1);
    const asked = (await this.git(root, ['ls-remote', '--symref', '--', remote, 'HEAD'], 30000).catch(() => '')).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
    if (asked) return asked;
    throw new Refusal(`No pull request: Trace could not tell which branch is this project's main branch on GitHub. Check that GitHub can be reached. ${AGAIN}`);
  }
  private async exists(root: string, remote: string, branch: string) {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]) if (await this.git(root, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)) return true;
    return false;
  }
  /** The pull request's description, in plain words: the task, what the agent said, the files and the checks. */
  private body(task: Task, files: string[], checks: { passed: boolean; summary: string } | null) {
    const agent = this.deps.agent(task.sessionId);
    return [`## Task`, task.title, ...(task.details ? ['', task.details] : []), ...(agent.name ? ['', `Done by ${agent.name}.`] : []),
      '', `## What the agent said`, agent.reply ? agent.reply.slice(-6000) : `${agent.name ? `${agent.name}'s` : 'The agent\'s'} summary of its work was not available.`,
      '', `## Files changed`, ...(files.length ? files.slice(0, 100).map((file) => `- \`${file}\``) : ['None listed.']), ...(files.length > 100 ? [`- …and ${files.length - 100} more`] : []),
      '', `## Checks`, checks ? checks.summary : 'No automatic checks ran: the project defines none, or they are turned off in Trace\'s Settings.',
      '', '---', 'Opened by Trace when the task was marked ready for review.'].join('\n');
  }
}
