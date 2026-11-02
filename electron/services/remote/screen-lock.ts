import { execFile } from 'node:child_process';

/** How long one answer is reused: a linked computer showing the screen asks every few seconds. */
const CACHE_MS = 1500;

/**
 * Whether the console session's screen is locked, from `ioreg`'s IOConsoleUsers (the dictionary the login window keeps):
 * null when it does not say. Electron's idle state cannot be used on a Mac: it learns of locking only from the lock
 * notification, so a Trace started while the Mac was locked reports it as active, and the linked computer showed black.
 */
export function parseConsoleLock(output: string): boolean | null {
  // One {…} per signed-in user; with fast user switching only one is on the console.
  const session = output.match(/\{[^{}]*\}/g)?.find((item) => /"kCGSSessionOnConsoleKey"\s*=\s*Yes/.test(item));
  if (!session) return null;
  // A session that has never been locked has no lock key at all.
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(session);
}

/** This Mac's lock state, read from the system at most every CACHE_MS; null when it cannot be read. */
export function macScreenLock(run: (callback: (output: string | null) => void) => void = ioreg) {
  let cached: { at: number; value: Promise<boolean | null> } | null = null;
  return (): Promise<boolean | null> => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const value = new Promise<boolean | null>((resolve) => run((output) => resolve(output === null ? null : parseConsoleLock(output))));
    cached = { at: Date.now(), value }; return value;
  };
}

function ioreg(callback: (output: string | null) => void) {
  execFile('/usr/sbin/ioreg', ['-r', '-k', 'IOConsoleUsers', '-d', '1'], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => callback(error ? null : stdout));
}
