import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Windows job objects, through native/trace-jobs.c (docs/background-runner.md, step 5): each program is put in a job
 * when it starts, and stopping its channel ends the job, children that left its process tree included. The runner has
 * one for its terminals, and Trace one for the channels it runs itself (PtyManager's `jobs`).
 * Without the helper (a source run without C++ build tools) every call does nothing and stopping falls back to
 * closing the terminal, after Trace's own process-tree stop.
 */
export class Jobs {
  private helper: ChildProcessWithoutNullStreams | null = null; private waiting = new Map<number, ((ok: boolean) => void)[]>();
  /** `args` only for tests, which run a stand-in helper under Node. */
  constructor(program: string | null, private log: (message: string) => void = () => {}, args: string[] = []) {
    if (!program || !fs.existsSync(program)) return;
    try {
      const helper = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); this.helper = helper;
      helper.on('error', (error) => { this.log(`job helper: ${error.message}`); this.gone(); }); helper.on('exit', () => this.gone());
      helper.stdin.on('error', () => {});
      readline.createInterface({ input: helper.stdout }).on('line', (line) => {
        const [word, key] = line.split(' '); const pid = Number(key); const queue = this.waiting.get(pid);
        queue?.shift()?.(word === 'ok'); if (queue && !queue.length) this.waiting.delete(pid);
        if (word !== 'ok') this.log(`job helper: ${line}`);
      });
    } catch (error) { this.log(`job helper: ${(error as Error).message}`); this.helper = null; }
  }
  get available() { return Boolean(this.helper); }
  /** The program `pid` and what it starts from now on join its own job. */
  add(pid: number) { return this.ask('add', pid, ` ${pid}`); }
  /** Ends every process in the program's job; false without the helper or a job. */
  kill(pid: number) { return this.ask('kill', pid); }
  drop(pid: number) { return this.ask('drop', pid); }
  close() { this.helper?.stdin.end(); }

  private ask(verb: string, pid: number, extra = ''): Promise<boolean> {
    const helper = this.helper; if (!helper || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(false);
    return new Promise((resolve) => { const queue = this.waiting.get(pid) ?? []; queue.push(resolve); this.waiting.set(pid, queue); helper.stdin.write(`${verb} ${pid}${extra}\n`); });
  }
  private gone() { this.helper = null; for (const queue of this.waiting.values()) for (const resolve of queue) resolve(false); this.waiting.clear(); }
}
