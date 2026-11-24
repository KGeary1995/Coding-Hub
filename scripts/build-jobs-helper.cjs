// Builds native/trace-jobs.c (the background runner's Windows job-object helper) into dist-electron/native, which the
// packaged app ships. Windows only, with Visual Studio's C++ build tools (found with vswhere). Without them a source run
// still works: the runner stops channels by process tree instead. A release build (TRACE_REQUIRE_JOBS_HELPER=1, set by
// build-windows.cjs) fails instead, so an installed Trace always has it.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(0);
const root = path.join(__dirname, '..'); const source = path.join(root, 'native', 'trace-jobs.c');
const out = path.join(root, 'dist-electron', 'native'); const exe = path.join(out, 'trace-jobs.exe');
const required = process.env.TRACE_REQUIRE_JOBS_HELPER === '1';
const fail = (message) => { if (required) { console.error(message); process.exit(1); } console.warn(`${message} Channels in the background runner are stopped by process tree instead.`); process.exit(0); };
try { if (fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) process.exit(0); } catch { /* Built below. */ }
const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
let install = '';
try { install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim(); } catch { /* Not installed. */ }
const vcvars = install && path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
if (!vcvars || !fs.existsSync(vcvars)) fail('trace-jobs.exe was not built: Visual Studio C++ build tools were not found.');
fs.mkdirSync(out, { recursive: true });
try {
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && cl /nologo /O2 /W4 /WX "${source}" /Fe:"${exe}" /Fo:"${path.join(out, 'trace-jobs.obj')}""`], { stdio: ['ignore', 'pipe', 'inherit'], windowsVerbatimArguments: true });
} catch (error) { fail(`trace-jobs.exe did not build: ${String(error.stdout ?? error.message).trim()}`); }
fs.rmSync(path.join(out, 'trace-jobs.obj'), { force: true });
console.log(`Built ${path.relative(root, exe)}`);
