import fs from 'node:fs';
import path from 'node:path';
import type { AutoCheckStatus } from '../../../shared/auto-checks';
import { hostEnvironment, nodeScriptCommand } from '../cli/discovery';
import { npmCLI } from '../repository/project-checks';
import { execFileTree, type TreeError } from '../repository/process-tree';
import { repositoryState } from './repository-state';
import { plainOutput } from '../../../shared/start-order';

/** One command a project's own setup names: the label shown, the program and its arguments. */
export interface AutoCheck { label: string; program: 'npm' | 'cargo' | 'go'; args: string[] }
/** npm's own placeholder test script, which only fails. */
const NO_TESTS = /no test specified/i;

/**
 * The checks a project defines for itself, in the order they run (quickest first): package.json's `typecheck` (or
 * `type-check`) and `test` scripts, else `cargo test` for a Cargo project or `go test ./...` for a Go module. None when
 * the project names none: nothing is guessed.
 */
export function detectChecks(folder: string): AutoCheck[] {
  const file = (name: string) => { try { const target = path.join(folder, name); return fs.lstatSync(target).isFile() ? target : null; } catch { return null; } };
  const pkg = file('package.json');
  if (pkg) {
    try {
      if (fs.statSync(pkg).size > 1024 * 1024) return [];
      const scripts = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const named = (name: string) => typeof scripts[name] === 'string' && !NO_TESTS.test(scripts[name] as string);
      const typecheck = ['typecheck', 'type-check'].find(named);
      return [...(typecheck ? [{ label: `npm run ${typecheck}`, program: 'npm' as const, args: ['run', typecheck] }] : []), ...(named('test') ? [{ label: 'npm test', program: 'npm' as const, args: ['test'] }] : [])];
    } catch { return []; }
  }
  if (file('Cargo.toml')) return [{ label: 'cargo test', program: 'cargo', args: ['test'] }];
  if (file('go.mod')) return [{ label: 'go test ./...', program: 'go', args: ['test', './...'] }];
  return [];
}

/** The end of a failed check's output, as the agent is shown it: without colours, the last lines that fit. */
export function failureText(output: string, limit = 3500) { const text = plainOutput(output).replace(/\n{3,}/g, '\n\n').trim(); return text.length > limit ? `…${text.slice(-limit)}` : text; }

/** A failure is sent back to the agent at most this many times in a row; then it is the person's to look at. */
export const MAX_FIXES = 3;
/** Turns that end close together (a Round Table, a quick follow-up) start one run, after this quiet time. */
const SETTLE_MS = 5000; const CHECK_TIMEOUT_MS = 10 * 60_000;

interface Deps {
  enabled(): boolean;
  /** Whether that channel is running and not waiting for the person (an approval): a failure can be sent to it. */
  canMessage(sessionId: string): boolean;
  send(sessionId: string, text: string): Promise<void>;
  publish(status: AutoCheckStatus): void;
  /** Overridable for tests. */
  run?(check: AutoCheck, folder: string): Promise<{ passed: boolean; output: string }>;
}
interface FolderState { baseline: string | null | undefined; timer: ReturnType<typeof setTimeout> | null; running: boolean; again: string | null; fixes: number }

/**
 * Automatic project checks (1.38.0): after an agent's turn ends with files changed since the last check, Trace runs the
 * checks the project defines for itself (detectChecks), shows the result on the agent's channel, and sends a failure
 * back to that agent to fix (at most MAX_FIXES times in a row). One run at a time per folder; on unless turned off.
 */
export class AutoChecks {
  private folders = new Map<string, FolderState>();
  constructor(private deps: Deps) {}
  get running() { return [...this.folders.values()].some((state) => state.running); }
  private state(folder: string) { let state = this.folders.get(folder); if (!state) { state = { baseline: undefined, timer: null, running: false, again: null, fixes: 0 }; this.folders.set(folder, state); } return state; }
  /** An agent channel started in this folder: what its files are now is what a turn's changes are measured from. */
  async started(folder: string) { const state = this.state(folder); if (state.baseline === undefined && !state.running) state.baseline = await repositoryState(folder).catch(() => null); }
  /** An agent's turn ended: checks run once turns have settled, if the files changed. */
  turnEnded(sessionId: string, folder: string) {
    if (!this.deps.enabled() || !detectChecks(folder).length) return;
    const state = this.state(folder); if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.timer = null; void this.check(sessionId, folder); }, SETTLE_MS);
  }
  private async check(sessionId: string, folder: string) {
    const state = this.state(folder);
    if (state.running) { state.again = sessionId; return; }
    const now = await repositoryState(folder).catch(() => null);
    // A Git folder whose files are as they were at the last check: nothing to check (the agent only answered).
    if (now !== null && now === state.baseline) return;
    state.running = true; const checks = detectChecks(folder);
    try {
      for (const check of checks) {
        this.deps.publish({ folder, sessionId, state: 'running', command: check.label, summary: `Checking: ${check.label}`, at: new Date().toISOString() });
        const result = await (this.deps.run ?? runCheck)(check, folder);
        if (result.passed) continue;
        state.baseline = await repositoryState(folder).catch(() => null);
        const handOver = state.fixes >= MAX_FIXES || !this.deps.canMessage(sessionId);
        this.deps.publish({ folder, sessionId, state: 'failed', command: check.label, summary: handOver ? `${check.label} failed${state.fixes >= MAX_FIXES ? ` after ${MAX_FIXES} fixes by the agent` : ''}: over to you.` : `${check.label} failed: sent to the agent to fix.`, output: failureText(result.output), at: new Date().toISOString() });
        if (!handOver) { state.fixes++; await this.deps.send(sessionId, `[Trace checks] \`${check.label}\` failed after your changes. Fix the cause, then end your turn (Trace checks again).\n\n${failureText(result.output)}`).catch(() => {}); }
        return;
      }
      state.fixes = 0; state.baseline = await repositoryState(folder).catch(() => null);
      this.deps.publish({ folder, sessionId, state: 'passed', command: null, summary: `Checks passed: ${checks.map((check) => check.label).join(', ')}`, at: new Date().toISOString() });
    } finally {
      state.running = false;
      if (state.again) { const next = state.again; state.again = null; this.turnEnded(next, folder); }
    }
  }
}

/** Runs one check in the folder, its whole process tree stopped at the time limit. CI=true keeps test runners from watching. */
async function runCheck(check: AutoCheck, folder: string): Promise<{ passed: boolean; output: string }> {
  const env = { ...hostEnvironment(), CI: 'true' };
  let file: string; let args: string[];
  try {
    if (check.program === 'npm') { const program = nodeScriptCommand(npmCLI(), env); file = program.file; args = [...program.args, ...check.args]; Object.assign(env, program.env); }
    else { file = check.program + (process.platform === 'win32' ? '.exe' : ''); args = check.args; }
  } catch (error) { return { passed: false, output: (error as Error).message }; }
  try { const output = await execFileTree(file, args, { cwd: folder, env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); return { passed: true, output: output.stdout.toString() + output.stderr.toString() }; }
  catch (error) {
    const failure = error as TreeError; const output = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`;
    return { passed: false, output: failure.code === 'ENOENT' ? `${check.program} was not found on this computer.` : failure.killed ? `${output}\n${check.label} took longer than ${CHECK_TIMEOUT_MS / 60_000} minutes and was stopped.` : output };
  }
}
