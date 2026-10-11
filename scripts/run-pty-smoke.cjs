const { spawnSync } = require('node:child_process');
const path = require('node:path');
// Run the native smoke check inside Electron's Node runtime without requiring a display.
const result = spawnSync(require('electron'), [path.join(__dirname, 'pty-smoke.cjs')], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
