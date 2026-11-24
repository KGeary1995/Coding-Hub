import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { codexWindows, parseClaudeUsage, parseGeminiUsage, type PlanLimits } from '../../../shared/plan-limits';
import type { ClaudeAccountProfile } from '../../../shared/accounts';
import { findExecutable, GEMINI_USAGE_ARGS, GEMINI_USAGE_COMMAND, closeInput, hostEnvironment, probeCLI, type Executable } from '../cli/discovery';
import { atLeast } from '../cli/attention';

const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * `/usage` needs no tools. Without `--strict-mcp-config` every check started the person's MCP servers, plugin ones
 * included (npx, uvx), and on Windows a uvx Python server opened a visible console every few minutes (2026-11-12).
 */
export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];

/** Claude Code's own `/usage`, run without a model request, without saving a session and without MCP servers. */
export function readClaudeLimits(executable: Executable, env: Record<string, string>, account: string): Promise<PlanLimits> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = execFile(executable.file, [...executable.prefixArgs, ...CLAUDE_USAGE_ARGS], { cwd: os.tmpdir(), env: { ...env, ...executable.extraEnv }, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      let result = ''; try { result = text(JSON.parse(stdout).result); } catch { /* Below. */ }
      const windows = parseClaudeUsage(result); const billedByApi = !error && /api key|api usage|pay-as-you-go/i.test(result);
      // API billing is a fact about the account; anything else without windows is a check that failed.
      resolve({ engine: 'claude', account, windows, plan: /subscription/i.test(result) ? 'Subscription' : null, checkedAt, error: windows.length ? null : error ? 'Claude Code did not answer /usage.' : billedByApi ? 'This account is billed by API usage, which has no session or weekly limit.' : 'Claude Code did not report usage limits.', failed: !windows.length && !billedByApi });
    });
    // `claude -p` waits 3 seconds for input otherwise.
    closeInput(child);
  });
}

/**
 * Gemini CLI's `/usage`, which agy answers itself from 1.1.11 (no model turn, no conversation). An older agy would send
 * "/usage" to the model as a prompt, every five minutes, so its version is read first and an older one is left alone.
 */
export async function readGeminiLimits(executable: Executable, env: Record<string, string>, probe: typeof probeCLI = probeCLI): Promise<PlanLimits | null> {
  const checkedAt = new Date().toISOString();
  const version = await probe(executable, ['--version'], env);
  if (version.exitCode !== 0 || !atLeast(version.stdout, ...GEMINI_USAGE_COMMAND)) return null;
  const result = await probe(executable, GEMINI_USAGE_ARGS, env);
  const windows = result.exitCode === 0 ? parseGeminiUsage(result.stdout) : null;
  return { engine: 'gemini', account: 'Default', windows: windows ?? [], plan: null, checkedAt, error: windows?.length ? null : result.timedOut ? 'Gemini did not answer /usage in time.' : windows ? 'Gemini reported no usage limits.' : 'Gemini did not report usage limits. Check that it is signed in.', ...(windows?.length ? {} : { failed: true }) };
}

/** Codex's app server: `account/rateLimits/read` after the initialize handshake; no model request. */
export function readCodexLimits(executable: Executable, env: Record<string, string>): Promise<PlanLimits> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(executable.file, [...executable.prefixArgs, 'app-server'], { cwd: os.tmpdir(), env: { ...env, ...executable.extraEnv }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = ''; let settled = false;
    const finish = (limits: Omit<PlanLimits, 'engine' | 'account' | 'checkedAt'>) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve({ engine: 'codex', account: 'Default', checkedAt, ...limits }); };
    const timer = setTimeout(() => finish({ windows: [], plan: null, error: 'Codex did not report usage limits in time.', failed: true }), 30000);
    child.on('error', () => finish({ windows: [], plan: null, error: 'Codex could not be started.', failed: true }));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null }) + '\n'); continue; }
        if (message.id !== 2) continue;
        if (message.error) { finish({ windows: [], plan: null, error: text(message.error.message) || 'Codex did not report usage limits.', failed: true }); return; }
        const limits = (message.result?.rateLimits ?? {}) as { primary?: unknown; secondary?: unknown; planType?: unknown };
        const given = [limits.primary, limits.secondary].filter(Boolean); const windows = codexWindows(given);
        finish({ windows, plan: text(limits.planType) || null, error: windows.length ? null : given.length ? 'Codex reported its usage limits in a form Trace does not read. Update Trace.' : 'This Codex account has no usage limits to show.', failed: !windows.length && given.length > 0 });
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'trace', title: 'Trace', version: '1' }, capabilities: null } }) + '\n');
  });
}

/** One account's or engine's check that could not run: shown as failed, without taking the other checks down with it. */
async function guarded(engine: PlanLimits['engine'], account: string, name: string, task: () => Promise<PlanLimits | null>): Promise<PlanLimits | null> {
  try { return await task(); } catch { return { engine, account, windows: [], plan: null, checkedAt: new Date().toISOString(), error: `Trace could not check ${name}'s usage limits.`, failed: true }; }
}

/**
 * Runs the tasks a few at a time, keeping their order. Each Claude account check starts a CLI, and up to eleven at once
 * (the default sign-in and ten profiles) slowed the computer and could make the checks time out.
 */
export async function inBatches<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length); let next = 0;
  const worker = async () => { while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return results;
}

/**
 * Keeps the usage limits of the person's Claude accounts (the CLI's own login and each connected profile) and Codex
 * fresh: at most every five minutes (Check now reads at once).
 */
export class PlanLimitsService {
  private latest: PlanLimits[] = []; private reading: Promise<PlanLimits[]> | null = null; private last = 0;
  constructor(private profiles: () => ClaudeAccountProfile[], private profileEnvironment: (base: Record<string, string>, id?: string) => Record<string, string>, private environment = hostEnvironment, private concurrency = 2, private defaultName: () => string | null = () => null) {}
  current() { return this.latest; }
  refresh(force = false): Promise<PlanLimits[]> {
    if (this.reading) return this.reading;
    // Each check starts the CLIs, so only an explicit Check now reads more often than every five minutes.
    if (!force && Date.now() - this.last < 5 * 60000) return Promise.resolve(this.latest);
    // Stamped as the read starts: the window asks every five minutes exactly, and a read that ended later would refuse every second request.
    this.last = Date.now();
    this.reading = (async () => {
      const env = this.environment(); const accounts: (() => Promise<PlanLimits>)[] = [];
      const claude = await findExecutable('claude', env).catch(() => null);
      if (claude) {
        let signedInAs: string | null = null; try { signedInAs = this.defaultName(); } catch { /* Unknown. */ }
        accounts.push(async () => (await guarded('claude', 'Default', 'Claude Code', async () => ({ ...await readClaudeLimits(claude, this.profileEnvironment(env), 'Default'), signedInAs })))!);
        let profiles: ClaudeAccountProfile[] = []; try { profiles = this.profiles(); } catch { /* Unreadable registry: default account only. */ }
        for (const profile of profiles) accounts.push(async () => (await guarded('claude', profile.name, 'Claude Code', () => readClaudeLimits(claude, this.profileEnvironment(env, profile.id), profile.name)))!);
      }
      const [codex, gemini] = await Promise.all([findExecutable('codex', env).catch(() => null), findExecutable('gemini', env).catch(() => null)]);
      const [claudeLimits, codexLimits, geminiLimits] = await Promise.all([inBatches(accounts, this.concurrency), codex ? guarded('codex', 'Default', 'Codex', () => readCodexLimits(codex, env)) : null, gemini ? guarded('gemini', 'Default', 'Gemini', () => readGeminiLimits(gemini, env)) : null]);
      this.latest = [...claudeLimits, ...(codexLimits ? [codexLimits] : []), ...(geminiLimits ? [geminiLimits] : [])];
      return this.latest;
    })().catch((error: unknown) => { this.last = 0; throw error; }).finally(() => { this.reading = null; });
    return this.reading;
  }
}
