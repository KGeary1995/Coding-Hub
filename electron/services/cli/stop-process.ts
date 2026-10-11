import { execFile } from 'node:child_process';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { HubError } from './engine-adapter';
export interface StopDependencies { platform?: NodeJS.Platform; killTree?: (pid: number) => Promise<void>; isAlive?: (pid: number) => boolean; signalGroup?: (pid: number, signal: NodeJS.Signals) => void; waitMilliseconds?: number }
export function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function windowsTree(pid: number): Promise<void> {
  const executable = path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => execFile(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 6000, maxBuffer: 65536 }, (error) => error ? reject(new Error('Windows process-tree termination failed.')) : resolve()));
}
/** Returns true only when the root was verified gone but the PTY failed to report its exit. */
export async function stopProcess(pty: IPty, exit: Promise<void>, dependencies: StopDependencies = {}): Promise<boolean> {
  if (!Number.isSafeInteger(pty.pid) || pty.pid <= 1 || pty.pid === process.pid) throw new HubError('STOP_FAILED', 'The session PID is invalid. No process was terminated.');
  const platform = dependencies.platform ?? process.platform; const alive = dependencies.isAlive ?? processAlive;
  let exited = false; void exit.then(() => { exited = true; });
  const wait = (milliseconds: number) => new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), milliseconds); void exit.then(() => { clearTimeout(timer); resolve(true); }); });
  const killPty = (signal: NodeJS.Signals) => { try { pty.kill(signal); } catch { /* Process already exited. */ } };
  if (platform === 'win32') {
    // Kill the child tree before closing ConPTY; killing its launcher first can orphan descendants.
    try { await (dependencies.killTree ?? windowsTree)(pty.pid); }
    catch { if (!exited && alive(pty.pid)) throw new HubError('STOP_FAILED', 'Windows could not stop the CLI process tree. Retry Stop or check the session PID in Task Manager.'); }
    if (!exited) killPty('SIGKILL');
    const reported = await wait(dependencies.waitMilliseconds ?? 5000);
    if (alive(pty.pid)) throw new HubError('STOP_FAILED', 'The CLI process is still running after Stop. Check its displayed PID in Task Manager before restarting.');
    return !reported;
  }
  const group = dependencies.signalGroup ?? ((pid, signal) => { try { process.kill(-pid, signal); } catch { /* Group already exited. */ } });
  group(pty.pid, 'SIGTERM'); killPty('SIGTERM');
  if (await wait(dependencies.waitMilliseconds ?? 1500)) return false;
  group(pty.pid, 'SIGKILL'); killPty('SIGKILL');
  if (await wait(dependencies.waitMilliseconds ?? 2500)) return false;
  if (!alive(pty.pid)) return true;
  throw new HubError('STOP_FAILED', 'The CLI process is still running. Retry Stop or terminate its displayed PID in your system process manager.');
}
