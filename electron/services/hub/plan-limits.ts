import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { codexWindow, parseClaudeUsage, type PlanLimits } from '../../../shared/plan-limits';
import type { ClaudeAccountProfile } from '../../../shared/accounts';
import { findExecutable, hostEnvironment, type Executable } from '../cli/discovery';

const text = (value: unknown) => typeof value === 'string' ? value : '';

/** Claude Code's own `/usage`, run without a model request and without saving a session. */
export function readClaudeLimits(executable: Executable, env: Record<string, string>, account: string): Promise<PlanLimits> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    execFile(executable.file, [...executable.prefixArgs, '-p', '/usage', '--output-format', 'json', '--no-session-persistence'], { cwd: os.tmpdir(), env: { ...env, ...executable.extraEnv }, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      let result = ''; try { result = text(JSON.parse(stdout).result); } catch { /* Below. */ }
      const windows = parseClaudeUsage(result);
      resolve({ engine: 'claude', account, windows, plan: /subscription/i.test(result) ? 'Subscription' : null, checkedAt, error: windows.length ? null : error ? 'Claude Code did not answer /usage.' : /api key|api usage|pay-as-you-go/i.test(result) ? 'This account is billed by API usage, which has no session or weekly limit.' : 'Claude Code did not report usage limits.' });
    });
  });
}

/** Codex's app server: `account/rateLimits/read` after the initialize handshake; no model request. */
export function readCodexLimits(executable: Executable, env: Record<string, string>): Promise<PlanLimits> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(executable.file, [...executable.prefixArgs, 'app-server'], { cwd: os.tmpdir(), env: { ...env, ...executable.extraEnv }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = ''; let settled = false;
    const finish = (limits: Omit<PlanLimits, 'engine' | 'account' | 'checkedAt'>) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve({ engine: 'codex', account: 'Default', checkedAt, ...limits }); };
    const timer = setTimeout(() => finish({ windows: [], plan: null, error: 'Codex did not report usage limits in time.' }), 30000);
    child.on('error', () => finish({ windows: [], plan: null, error: 'Codex could not be started.' }));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null }) + '\n'); continue; }
        if (message.id !== 2) continue;
        if (message.error) { finish({ windows: [], plan: null, error: text(message.error.message) || 'Codex did not report usage limits.' }); return; }
        const limits = (message.result?.rateLimits ?? {}) as { primary?: Parameters<typeof codexWindow>[0] | null; secondary?: Parameters<typeof codexWindow>[0] | null; planType?: unknown };
        const windows = [limits.primary, limits.secondary].filter((window): window is Parameters<typeof codexWindow>[0] => Boolean(window)).map(codexWindow).sort((a, b) => (a.label === 'Session' ? -1 : 0) - (b.label === 'Session' ? -1 : 0));
        finish({ windows, plan: text(limits.planType) || null, error: windows.length ? null : 'This Codex account has no usage limits to show.' });
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'trace', title: 'Trace', version: '1' }, capabilities: null } }) + '\n');
  });
}

/**
 * Keeps the usage limits of the person's Claude accounts (the CLI's own login and each connected profile) and Codex
 * fresh: at most every five minutes (Check now reads at once).
 */
export class PlanLimitsService {
  private latest: PlanLimits[] = []; private reading: Promise<PlanLimits[]> | null = null; private last = 0;
  constructor(private profiles: () => ClaudeAccountProfile[], private profileEnvironment: (base: Record<string, string>, id?: string) => Record<string, string>, private environment = hostEnvironment) {}
  current() { return this.latest; }
  refresh(force = false): Promise<PlanLimits[]> {
    if (this.reading) return this.reading;
    // Each check starts the CLIs, so only an explicit Check now reads more often than every five minutes.
    if (!force && Date.now() - this.last < 5 * 60000) return Promise.resolve(this.latest);
    this.reading = (async () => {
      const env = this.environment(); const reads: Promise<PlanLimits>[] = [];
      const claude = await findExecutable('claude', env).catch(() => null);
      if (claude) {
        reads.push(readClaudeLimits(claude, env, 'Default'));
        let profiles: ClaudeAccountProfile[] = []; try { profiles = this.profiles(); } catch { /* Unreadable registry: default account only. */ }
        for (const profile of profiles) reads.push(readClaudeLimits(claude, this.profileEnvironment(env, profile.id), profile.name));
      }
      const codex = await findExecutable('codex', env).catch(() => null);
      if (codex) reads.push(readCodexLimits(codex, env));
      this.latest = await Promise.all(reads); this.last = Date.now();
      return this.latest;
    })().finally(() => { this.reading = null; });
    return this.reading;
  }
}
