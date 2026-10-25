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
