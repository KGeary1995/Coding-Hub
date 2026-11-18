const { spawnSync } = require('node:child_process');
const path = require('node:path');
// Run the native smoke check inside Electron's Node runtime without requiring a display.
const result = spawnSync(require('electron'), [path.join(__dirname, 'pty-smoke.cjs')], {
  // pty-smoke.cjs runs its stand-in CLI under plain Node on Windows and finds it here: set by npm, or this Node when run directly.
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_node_execpath: process.env.npm_node_execpath ?? process.execPath },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
