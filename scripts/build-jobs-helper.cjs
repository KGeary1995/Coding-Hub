// Builds native/trace-jobs.c (the background runner's Windows job-object helper) and native/trace-input.c (screen
// sharing's administrator side, which Settings copies into Program Files) into dist-electron/native, which the
// packaged app ships. Windows only, with Visual Studio's C++ build tools (found with vswhere). Without them a source run
// still works: the runner stops channels by process tree instead. A release build (TRACE_REQUIRE_JOBS_HELPER=1, set by
// build-windows.cjs) fails instead, so an installed Trace always has it.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(0);
const root = path.join(__dirname, '..'); const out = path.join(root, 'dist-electron', 'native');
const helpers = ['trace-jobs', 'trace-input'];
const required = process.env.TRACE_REQUIRE_JOBS_HELPER === '1';
const fail = (message) => { if (required) { console.error(message); process.exit(1); } console.warn(`${message} Channels in the background runner are stopped by process tree instead.`); process.exit(0); };
const stale = helpers.filter((name) => { try { return fs.statSync(path.join(out, name + '.exe')).mtimeMs < fs.statSync(path.join(root, 'native', name + '.c')).mtimeMs; } catch { return true; } });
if (!stale.length) process.exit(0);
const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
let install = '';
try { install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim(); } catch { /* Not installed. */ }
const vcvars = install && path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
if (!vcvars || !fs.existsSync(vcvars)) fail(`${stale.join('.exe and ')}.exe not built: Visual Studio C++ build tools were not found.`);
fs.mkdirSync(out, { recursive: true });
for (const name of stale) {
  const source = path.join(root, 'native', name + '.c'); const exe = path.join(out, name + '.exe'); const obj = path.join(out, name + '.obj');
  try {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && cl /nologo /O2 /W4 /WX "${source}" /Fe:"${exe}" /Fo:"${obj}""`], { stdio: ['ignore', 'pipe', 'inherit'], windowsVerbatimArguments: true });
  } catch (error) { fail(`${name}.exe did not build: ${String(error.stdout ?? error.message).trim()}`); }
  fs.rmSync(obj, { force: true });
  console.log(`Built ${path.relative(root, exe)}`);
}
