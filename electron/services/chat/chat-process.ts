import { spawn } from 'node:child_process';
import os from 'node:os';
import type { IPty, IPtyForkOptions } from 'node-pty';

/** A chat run's process: a plain child process shaped like the pseudo-terminal the run manager expects. */
export interface ChatProcess extends IPty { onStderr(listener: (data: string) => void): void }

/**
 * Starts Claude Code in structured mode with plain pipes (no terminal): stdout carries one JSON message per line, stdin
 * takes the window's messages and approvals. On Unix it leads its own process group, so stopping it also stops the
 * commands it runs, as with a terminal channel. Resizing means nothing here and is ignored.
 */
export function spawnChatProcess(file: string, args: string[], options: IPtyForkOptions): ChatProcess {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  // A process that cannot be started (its program or folder gone since it was found) also reports that as an `error`
  // event after this returns; unhandled, that event would bring down the whole app. The failure is reported below.
  child.on('error', () => {});
  if (!child.pid) { child.kill(); throw new Error('The CLI could not be started.'); }
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  // A closed stdin (the CLI exiting) must not crash the host.
  child.stdin.on('error', () => {});
  let exited = false; child.on('exit', () => { exited = true; });
  const shaped = {
    pid: child.pid, cols: options.cols ?? 80, rows: options.rows ?? 24, process: file, handleFlowControl: false,
    onData: (listener: (data: string) => void) => { child.stdout.on('data', listener); return { dispose: () => child.stdout.off('data', listener) }; },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      const handler = (code: number | null, signal: NodeJS.Signals | null) => listener({ exitCode: code ?? (signal ? 0 : 1), signal: signal ? os.constants.signals[signal] : undefined });
      child.on('exit', handler); return { dispose: () => child.off('exit', handler) };
    },
    onStderr: (listener: (data: string) => void) => { child.stderr.on('data', listener); },
    write: (data: string) => { if (!exited && child.stdin.writable) child.stdin.write(data); },
    resize: () => {}, clear: () => {},
    kill: (signal?: string) => { if (!exited) child.kill((signal as NodeJS.Signals) ?? 'SIGTERM'); },
    pause: () => child.stdout.pause(), resume: () => child.stdout.resume(),
  };
  return shaped as unknown as ChatProcess;
}
