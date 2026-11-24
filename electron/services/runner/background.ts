import type { IPty, IPtyForkOptions } from 'node-pty';
import type { HeldMeta, HeldTerminals } from '../cli/pty-manager';
import { RunnerClient } from './client';
import { ensureKit, removeOldKits, runnerPlace, runnerSecret, startRunner, type Kit, type RunnerPlace } from './kit';
import type { RunnerTerminal } from './protocol';

/**
 * Trace's side of the background runner (docs/background-runner.md): PtyManager's terminal runs start in it, and the
 * terminals it kept while Trace was closed are handed back to their channels. The runner is started from its kit the
 * first time it is needed, and again if it went away.
 */
export class BackgroundRunner implements HeldTerminals {
  private place: RunnerPlace; private client: RunnerClient | null = null; private connecting: Promise<RunnerClient> | null = null;
  /** Terminals still running from before this Trace opened, by channel, until each channel takes its own. */
  private left = new Map<string, RunnerTerminal>(); private listed: Promise<void> | null = null;
  /** Extra details kept with each terminal (hook tokens), and given back when it is taken up. */
  meta?: (meta: HeldMeta) => Record<string, unknown>;
  onProblem?: (message: string) => void;

  constructor(storageRoot: string, private appPath: string, private execPath: string) { this.place = runnerPlace(storageRoot); }

  async spawn(file: string, args: string[], options: IPtyForkOptions, meta: HeldMeta): Promise<IPty> {
    const client = await this.connect();
    const pty = await client.spawn({ id: meta.session.runId, file, args, cwd: options.cwd ?? process.cwd(), env: (options.env ?? {}) as Record<string, string>, cols: options.cols ?? 80, rows: options.rows ?? 24, meta: { ...meta, ...this.meta?.(meta) } });
    return pty as unknown as IPty;
  }

  async take(sessionId: string): Promise<{ pty: IPty; meta: HeldMeta; tail: string } | null> {
    await this.leftOver();
    const terminal = this.left.get(sessionId); if (!terminal || !this.client) return null;
    this.left.delete(sessionId);
    const pty = this.client.adopt(terminal); const tail = (await this.client.tail(terminal.term)).toString('utf8');
    return { pty: pty as unknown as IPty, meta: terminal.meta as HeldMeta, tail };
  }

  /** The channels whose terminals kept running while Trace was closed. Only asks a runner that is already running. */
  async kept(): Promise<string[]> { await this.leftOver(); return [...this.left.keys()]; }

  /** Lets go of the runner, which keeps every terminal running. */
  close() { this.client?.close(); this.client = null; }

  private leftOver(): Promise<void> {
    this.listed ??= (async () => {
      let client: RunnerClient; try { client = await this.connect(false); } catch { return; }
      for (const terminal of await client.list()) {
        const sessionId = (terminal.meta as HeldMeta | undefined)?.session?.sessionId;
        // One that ended while Trace was closed is forgotten: its channel shows stopped, as after any quit.
        if (terminal.exitCode !== undefined || !sessionId) { client.forget(terminal.term); continue; }
        this.left.set(sessionId, terminal);
      }
    })();
    return this.listed;
  }

  /** Connects to the runner, starting it from its kit when none answers (unless `start` is false). */
  private connect(start = true): Promise<RunnerClient> {
    if (this.client?.connected) return Promise.resolve(this.client);
    this.connecting ??= this.open(start).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(start: boolean): Promise<RunnerClient> {
    const secret = runnerSecret(this.place);
    const attempt = async () => { const client = new RunnerClient(this.place.address, secret); const welcome = await client.connect(); return { client, welcome }; };
    let kit: Kit | null = null;
    // Each protocol has its own address (kit.ts), so what answers here speaks this one.
    let found = await attempt().catch(() => null);
    if (!found) {
      if (!start) throw new Error('No background runner is running.');
      kit = ensureKit(this.place, this.appPath, this.execPath); startRunner(kit, this.place);
      const until = Date.now() + 15000;
      while (!found) { await new Promise((resolve) => setTimeout(resolve, 200)); found = await attempt().catch(() => null); if (!found && Date.now() > until) throw new Error('The background runner did not start.'); }
    }
    const { client, welcome } = found;
    client.onLost = () => { if (this.client === client) { this.client = null; this.onProblem?.('The background runner stopped, and the channels it held ended with it.'); } };
    this.client = client;
    try { removeOldKits(this.place, [...(kit ? [kit.folder] : []), ...(welcome.home ? [welcome.home] : [])]); } catch { /* Tried again next time. */ }
    return client;
  }
}
