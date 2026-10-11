import { stopProcess, type StopDependencies } from './stop-process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { AccountEvent, AccountLogin, AccountResponse } from '../../../shared/accounts';
import { LOGIN_ARGUMENTS, INSTALL_GUIDES, inspectAccount } from './account-connections';
import { hostEnvironment } from './discovery';
import { HubError } from './engine-adapter';
const provider = z.enum(['claude', 'codex', 'github']); const cols = z.number().int().min(2).max(500); const rows = z.number().int().min(1).max(300);
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('status') }).strict(), z.object({ action: z.literal('login'), provider, cols, rows }).strict(), z.object({ action: z.literal('stop'), runId: z.uuid().optional() }).strict(), z.object({ action: z.literal('write'), runId: z.uuid(), data: z.string().max(16384) }).strict(), z.object({ action: z.literal('resize'), runId: z.uuid(), cols, rows }).strict(), z.object({ action: z.literal('install-guide'), provider }).strict()]);
interface Run { owner: number; login: AccountLogin; pty: IPty; exited: Promise<void>; resolve: () => void; finished: boolean }
export class AccountLoginManager {
  private run: Run | null = null;
  private pending: { owner: number; cancelled: boolean } | null = null;
  private closing = false;
  get active() { return Boolean(this.run || this.pending); }
  constructor(private emit: (owner: number, event: AccountEvent) => void, private dependencies: { stopDependencies?: StopDependencies; inspect?: typeof inspectAccount; spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty; openGuide: (url: string) => Promise<void> }) {}
  async execute(owner: number, input: unknown): Promise<AccountResponse> {
    const parsed = schema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_ACCOUNT_REQUEST', 'Invalid account request.'); const request = parsed.data;
    const inspect = this.dependencies.inspect ?? inspectAccount;
    if (request.action === 'status') return (await Promise.all((['claude', 'codex', 'github'] as const).map(inspect))).map((result) => result.connection);
    if (request.action === 'install-guide') { await this.dependencies.openGuide(INSTALL_GUIDES[request.provider]); return null; }
    if (request.action === 'stop') { await this.stopOwner(owner, request.runId); return null; }
    if (request.action === 'write' || request.action === 'resize') {
      const run = this.run;
      if (!run || run.owner !== owner || run.login.runId !== request.runId) throw new HubError('STALE_LOGIN', 'The login terminal has ended or belongs to another window.');
      if (request.action === 'write') run.pty.write(request.data); else run.pty.resize(request.cols, request.rows);
      return null;
    }
    if (this.closing) throw new HubError('HOST_CLOSING', 'The application is shutting down.');
    if (this.active) throw new HubError('LOGIN_BUSY', 'Finish or cancel the current login before connecting another account.');
    const reservation = { owner, cancelled: false }; this.pending = reservation;
    try {
      const discovered = await inspect(request.provider);
      if (!discovered.executable || !discovered.connection.canLogin) throw new HubError('LOGIN_UNAVAILABLE', discovered.connection.message);
      if (reservation.cancelled || this.closing) throw new HubError('LOGIN_CANCELLED', 'Login was cancelled.');
      const login: AccountLogin = { runId: randomUUID(), provider: request.provider };
      const spawn = this.dependencies.spawn ?? ((file, args, options) => (require('node-pty') as typeof import('node-pty')).spawn(file, args, options));
      const pty = spawn(discovered.executable.file, [...discovered.executable.prefixArgs, ...LOGIN_ARGUMENTS[request.provider]], { cwd: homedir(), cols: request.cols, rows: request.rows, env: { ...hostEnvironment(), ...discovered.executable.extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
      let resolve!: () => void; const exited = new Promise<void>((done) => { resolve = done; }); const run: Run = { owner, login, pty, exited, resolve, finished: false }; this.run = run;
      pty.onData((data) => { if (run.finished) return; for (let offset = 0; offset < data.length; offset += 16384) this.emit(owner, { type: 'data', ...login, data: data.slice(offset, offset + 16384) }); });
      pty.onExit(({ exitCode }) => this.finish(run, exitCode));
      this.emit(owner, { type: 'started', ...login }); return login;
    } finally { if (this.pending === reservation) this.pending = null; }
  }
  async stopOwner(owner: number, id?: string) {
    if (this.pending?.owner === owner && !id) this.pending.cancelled = true;
    const run = this.run; if (!run) return;
    if (run.owner !== owner || (id && run.login.runId !== id)) throw new HubError('STALE_LOGIN', 'This login terminal belongs to another window or has ended.');
    if (await stopProcess(run.pty, run.exited, this.dependencies.stopDependencies)) this.finish(run, 130);
  }
  private finish(run: Run, exitCode: number) { if (run.finished) return; run.finished = true; if (this.run === run) this.run = null; this.emit(run.owner, { type: 'exit', ...run.login, exitCode }); run.resolve(); }

  async close() { this.closing = true; if (this.pending) this.pending.cancelled = true; if (this.run) await this.stopOwner(this.run.owner); }
}
