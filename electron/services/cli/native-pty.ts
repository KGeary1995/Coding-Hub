import fs from 'node:fs';
import path from 'node:path';

let prepared = false;

/**
 * node-pty, ready to start terminals. Outside Windows it starts each CLI through a small `spawn-helper` program, which
 * node-pty 1.1 ships without execute permission for macOS, so every terminal there failed with "posix_spawnp failed".
 * The helper is made executable the first time node-pty is used.
 */
export function nodePty(): typeof import('node-pty') {
  if (!prepared && process.platform !== 'win32') {
    prepared = true;
    try { ensureSpawnHelper(path.dirname(require.resolve('node-pty/package.json'))); } catch { /* node-pty reports its own error on spawn. */ }
  }
  return require('node-pty') as typeof import('node-pty');
}

/** node-pty's Windows agent (internal: node-pty 1.1's windowsPtyAgent.js), where present. */
type WindowsAgent = { exitCode?: number; _getConsoleProcessList?: () => Promise<number[]> };
function windowsAgent(pty: unknown): WindowsAgent | null {
  const agent = (pty as { _agent?: unknown } | null)?._agent;
  return agent && typeof agent === 'object' ? agent as WindowsAgent : null;
}

/**
 * Stops node-pty's kill() from looking up and ending the console's processes itself, for a run whose process tree Trace
 * already ended with taskkill. That lookup starts a helper process which cannot attach to a console whose process has
 * gone, never answers, and five seconds later node-pty ends the old process id, which Windows may have given to an
 * unrelated process by then. kill() still closes the pseudoconsole.
 */
export function skipConsoleProcessLookup(pty: unknown) {
  const agent = windowsAgent(pty);
  if (agent && typeof agent._getConsoleProcessList === 'function') agent._getConsoleProcessList = () => Promise.resolve([]);
}

/**
 * Whether node-pty already saw the process end. On Windows it reports the exit about a second later (after the last
 * output), and until then a resize throws.
 */
export function ptyProcessEnded(pty: unknown): boolean {
  try { const code = windowsAgent(pty)?.exitCode; return typeof code === 'number'; } catch { return false; }
}

/** Makes node-pty's spawn-helper executable for this platform's prebuilds and any local build; returns the files changed. */
export function ensureSpawnHelper(root: string, platform: string = process.platform) {
  let prebuilds: string[] = [];
  try { prebuilds = fs.readdirSync(path.join(root, 'prebuilds')).filter((name) => name.startsWith(platform + '-')).map((name) => path.join('prebuilds', name)); } catch { /* No prebuilds. */ }
  const changed: string[] = [];
  for (const folder of ['build/Release', 'build/Debug', ...prebuilds]) {
    const helper = path.join(root, folder, 'spawn-helper');
    try {
      const { mode } = fs.statSync(helper);
      if ((mode & 0o111) !== 0o111) { fs.chmodSync(helper, mode | 0o755); changed.push(helper); }
    } catch { /* Not present in this layout. */ }
  }
  return changed;
}
