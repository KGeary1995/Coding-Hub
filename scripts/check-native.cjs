// node-pty 1.1 uses stable Node-API bindings, shared by Node and Electron.
try {
  const pty = require('node-pty');
  if (typeof pty.spawn !== 'function') throw new Error('Missing PTY implementation');
  console.log('Local terminal binding loaded successfully.');
} catch {
  console.error('The native terminal binding is unavailable. Install platform build prerequisites and run npm run rebuild:native. See README.md.');
  process.exitCode = 1;
}
