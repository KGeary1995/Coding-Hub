import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Ends a process and everything it started. Node's own execFile timeout ends only the direct child, so a Git hook,
 * the git that `gh repo clone` runs, or a checkout went on working after Trace reported the command as failed.
 */
export function stopTree(pid: number | undefined) {
  // Never PID 0 or 1, or Trace itself (a negative PID would signal a whole process group).
  if (!pid || pid <= 1 || pid === process.pid) return;
  if (process.platform === 'win32') { execFile(path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 6000 }, () => { /* Already gone. */ }); return; }
  // SIGTERM first: Git removes its *.lock files on it, and SIGKILL would leave .git/index.lock behind (as stop-process.ts).
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { try { process.kill(pid, name); } catch { /* Already gone. */ } } };
  signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), 1500).unref();
}

export interface TreeOutput { stdout: Buffer; stderr: Buffer }
/** A failure as execFile reports it: `code` (exit code, or ENOENT and the like), `killed` when the time limit ended it. */
export type TreeError = Error & { code?: string | number | null; killed: boolean; stdout: Buffer; stderr: Buffer };
export interface TreeOptions { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; timeout: number; maxBuffer?: number }

/**
 * Runs a program like execFile, with a time limit that ends the whole process tree. On a Mac or Linux the child leads
 * its own process group (`detached`; execFile does not pass that option on), so the group can be signalled; on Windows
 * taskkill /T finds the tree. No input: a prompt reads end-of-file instead of waiting.
 */
export function execFileTree(file: string, args: string[], options: TreeOptions): Promise<TreeOutput> {
  return new Promise((resolve, reject) => {
    const limit = options.maxBuffer ?? 1024 * 1024; const out: Buffer[] = []; const err: Buffer[] = []; const sizes = { out: 0, err: 0 };
    let timedOut = false; let overflow = false; let settled = false;
    /** `exited`: the program itself ended (its code, and whether before the limit), even while something it left running holds the output open. */
    let exited: { code: number | null; inTime: boolean } | null = null; let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, code?: string | number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace);
      const output = { stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
      if (!error) resolve(output); else reject(Object.assign(error, output, { killed: timedOut, ...(code !== undefined ? { code } : {}) }) as TreeError);
    };
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: options.windowsHide, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (into: Buffer[], key: 'out' | 'err') => (chunk: Buffer) => {
      sizes[key] += chunk.length; if (sizes[key] <= limit) { into.push(chunk); return; }
      if (!overflow) { overflow = true; stopTree(child.pid); wait(); }
    };
    /**
     * Settles from how the program itself ended. A process it left behind (a hook's background job, a daemon) can hold
     * the output open long after, and outlive the stop (its parent is gone, so taskkill /T cannot find it): the pipes
     * are closed instead of waiting for it, as execFile does at its limit.
     */
    const settle = () => {
      if (settled) return; child.stdout?.destroy(); child.stderr?.destroy();
      if (exited?.code === 0 && exited.inTime && !overflow) finish(null);
      else finish(new Error(overflow ? `${file} wrote more output than ${limit} bytes.` : !exited?.inTime ? `${file} timed out.` : `${file} exited with ${exited.code}.`), overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : exited?.code);
    };
    /** Output still in the pipe after the program ends arrives well within this. */
    const wait = () => { grace ??= setTimeout(settle, 2000); };
    child.stdout?.on('data', collect(out, 'out')); child.stderr?.on('data', collect(err, 'err'));
    const timer = setTimeout(() => { timedOut = true; stopTree(child.pid); wait(); }, options.timeout);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => { exited = { code, inTime: !timedOut }; wait(); });
    child.on('close', (code) => { exited ??= { code, inTime: !timedOut }; settle(); });
  });
}
