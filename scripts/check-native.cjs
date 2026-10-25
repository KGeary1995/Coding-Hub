// node-pty 1.1 uses stable Node-API bindings, shared by Node and Electron.
const fs = require('node:fs');
const path = require('node:path');
// Outside Windows node-pty starts CLIs through spawn-helper, which it ships without execute permission for macOS.
// The app also fixes this at runtime (electron/services/cli/native-pty.ts); doing it here keeps a fresh install ready.
if (process.platform !== 'win32') {
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    let prebuilds = [];
    try { prebuilds = fs.readdirSync(path.join(root, 'prebuilds')).filter((name) => name.startsWith(process.platform + '-')).map((name) => path.join('prebuilds', name)); } catch { /* No prebuilds. */ }
    for (const folder of ['build/Release', 'build/Debug', ...prebuilds]) {
      const helper = path.join(root, folder, 'spawn-helper');
      try { const { mode } = fs.statSync(helper); if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755); } catch { /* Not in this layout. */ }
    }
  } catch { /* Reported below. */ }
}
try {
  const pty = require('node-pty');
  if (typeof pty.spawn !== 'function') throw new Error('Missing PTY implementation');
  console.log('Local terminal binding loaded successfully.');
} catch {
  console.error('The native terminal binding is unavailable. Install platform build prerequisites and run npm run rebuild:native. See README.md.');
  process.exitCode = 1;
}
