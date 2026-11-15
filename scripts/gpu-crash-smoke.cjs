// Does Trace's window still paint after its GPU process crashes? Windows only (it reads the real screen).
// Starts the built app with hardware acceleration on, checks that it really is on, crashes the GPU process, and then
// checks that a click which changes the view changes what is on the screen. The screen is read with .NET
// (CopyFromScreen), not through Chromium, because a frame Chromium hands to a test can exist while the window shows
// black. Run after `npm run build`: node scripts/gpu-crash-smoke.cjs
const assert = require('node:assert/strict');
const { realpath, mkdtemp, mkdir, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { openView } = require('./lib/navigate.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Captures a rectangle of the real screen to a PNG. */
function screen(file, { x, y, width, height }) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap(${width}, ${height}); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`]);
}
/**
 * Two captures compared, sampling every 6th pixel: each one's mean brightness (0-255), how much of each is one flat
 * colour (0-1: the share of samples equal to its most common one, near 1 for a black or blank capture), and the share of
 * samples that differ between them (0-1).
 */
function compare(a, b) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing; $a = [System.Drawing.Bitmap]::FromFile('${a}'); $b = [System.Drawing.Bitmap]::FromFile('${b}'); $sa = 0; $sb = 0; $n = 0; $diff = 0; $ca = @{}; $cb = @{}; for ($y = 0; $y -lt $a.Height; $y += 6) { for ($x = 0; $x -lt $a.Width; $x += 6) { $p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y); $sa += ($p.R + $p.G + $p.B) / 3; $sb += ($q.R + $q.G + $q.B) / 3; $n++; $ca[$p.ToArgb()]++; $cb[$q.ToArgb()]++; if ([Math]::Abs($p.R - $q.R) + [Math]::Abs($p.G - $q.G) + [Math]::Abs($p.B - $q.B) -gt 30) { $diff++ } } }; $fa = ($ca.Values | Measure-Object -Maximum).Maximum / $n; $fb = ($cb.Values | Measure-Object -Maximum).Maximum / $n; "{0} {1} {2} {3} {4}" -f ($sa / $n), ($sb / $n), $fa, $fb, ($diff / $n)`]).toString().trim();
  const [brightnessA, brightnessB, flatA, flatB, changed] = out.split(' ').map(Number); const round = (value) => Math.round(value * 1000) / 1000;
  return { brightness: [Math.round(brightnessA), Math.round(brightnessB)], flat: [round(flatA), round(flatB)], changed: round(changed) };
}
/** A capture that shows a drawn window: not near black, and not nearly all one colour. */
const drawn = (result) => result.brightness.every((value) => value >= 10) && result.flat.every((value) => value < 0.9);
/** The click visibly changed the screen: at least 5% of the samples. */
const MIN_CHANGE = 0.05;

module.exports = { compare, drawn, MIN_CHANGE };
if (require.main === module) (async () => {
  if (process.platform !== 'win32') { console.log('SKIP: reads the real screen with .NET; Windows only.'); return; }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coding-hub-gpu-')));
  const storage = path.join(root, 'storage'); const shots = path.join(root, 'shots');
  await Promise.all([storage, shots, path.join(root, 'home')].map((directory) => mkdir(directory)));
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: storage, CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), CODEX_HOME: path.join(root, 'codex-config'), USERPROFILE: path.join(root, 'home') };
  delete env.ELECTRON_RUN_AS_NODE;
  // No --disable-gpu or any other switch that turns hardware acceleration off.
  const args = ['--user-data-dir=' + path.join(root, 'electron-profile'), path.resolve(__dirname, '..'), '--production'];
  let app; const report = {};
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.codingHub && document.querySelector('.tr-empty'));
    await page.getByRole('heading', { name: 'Open a project', exact: true }).waitFor();
    const before = await app.evaluate(({ app: electronApp }) => ({ gpu: electronApp.getAppMetrics().filter((metric) => metric.type === 'GPU').map((metric) => metric.pid), status: electronApp.getGPUFeatureStatus() }));
    report.acceleration = { gpuProcess: before.gpu, gpuCompositing: before.status.gpu_compositing };
    if (!before.gpu.length || !String(before.status.gpu_compositing).startsWith('enabled')) { console.log('COULD NOT TEST with hardware acceleration:', JSON.stringify(report)); process.exitCode = 2; return; }
    const bounds = await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 40, y: 40, width: 1100, height: 760 }); window.show(); window.moveTop(); window.focus(); return window.getContentBounds(); });
    await wait(1500);
    // How a click shows on the real screen while all is well: Workspace, then Settings.
    // Each capture also notes which program's window owns the middle of the capture area at that moment (the real screen
    // shows that one), and saves Chromium's own frame of the page beside it.
    const ownPid = await app.evaluate(() => process.pid); const owners = {};
    const shot = (name) => {
      const file = path.join(shots, name + '.png'); screen(file, bounds);
      const [pid, ...program] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'lib', 'window-at.ps1'), '-X', String(Math.round(bounds.x + bounds.width / 2)), '-Y', String(Math.round(bounds.y + bounds.height / 2))]).toString().trim().split(' ');
      owners[name] = { trace: Number(pid) === ownPid, program: program.join(' ') }; return file;
    };
    const frame = (name) => page.screenshot({ path: path.join(shots, name + '-chromium.png') }).catch((error) => { owners[name + '-chromium'] = String(error.message); });
    const workspace0 = shot('0-workspace'); await openView(page, 'Settings'); await wait(1500); const settings0 = shot('1-settings');
    report.beforeCrash = compare(workspace0, settings0);
    // The baseline must show two drawn views that differ; otherwise the captures cannot tell painting from not.
    if (!drawn(report.beforeCrash) || report.beforeCrash.changed < MIN_CHANGE) { console.log('COULD NOT TEST: before the crash, the captures did not show two different drawn views:', JSON.stringify(report)); process.exitCode = 2; return; }
    await openView(page, 'Workspace'); await wait(1500);

    // The crash: chrome://gpucrash in a hidden window crashes the GPU process (Electron 44: an access violation, exit
    // code -1073741819). The load itself never finishes, so it is not waited for.
    const crash = await app.evaluate(({ BrowserWindow }) => {
      const window = new BrowserWindow({ show: false }); let error = null;
      window.loadURL('chrome://gpucrash').catch((caught) => { error = String(caught && caught.message || caught); });
      setTimeout(() => window.destroy(), 3000); return error;
    });
    await wait(4000);
    const after = await app.evaluate(({ app: electronApp }) => ({ gpu: electronApp.getAppMetrics().filter((metric) => metric.type === 'GPU').map((metric) => metric.pid), status: electronApp.getGPUFeatureStatus() }));
    const health = JSON.parse(await readFile(path.join(storage, 'host-health.json'), 'utf8'));
    report.crash = { loadError: crash, gpuBefore: before.gpu, gpuAfter: after.gpu, gpuCompositingAfter: after.status.gpu_compositing, recorded: health.events.filter((item) => item.event === 'child-process-gone').map((item) => item.reason), windows: health.events.filter((item) => item.event === 'gpu-crash-windows').map((item) => item.reason) };
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((item) => item.isVisible()); window?.moveTop(); window?.focus(); });
    await wait(1000);
    const workspace1 = shot('2-workspace-after-crash'); await frame('2-workspace-after-crash'); await openView(page, 'Settings'); await wait(1500); const settings1 = shot('3-settings-after-crash'); await frame('3-settings-after-crash');
    report.afterCrash = compare(workspace1, settings1);
    report.afterCrashVsBefore = compare(settings0, settings1); report.workspaceVsBefore = compare(workspace0, workspace1);
    report.shots = shots; report.owners = owners;
    console.log(JSON.stringify(report, null, 2));
    assert.ok(report.crash.recorded.some((detail) => /^GPU: /.test(detail)), 'host health recorded no GPU process gone'); assert.ok(report.crash.windows.length, 'host health recorded no window states with the GPU crash');
    // Another program's window over the capture area: the real screen shows that window, so nothing can be said of Trace's.
    const covered = Object.entries(owners).filter(([, owner]) => owner && owner.trace === false).map(([name, owner]) => `${name}: ${owner.program}`);
    if (covered.length) { console.log('COULD NOT TEST: another window was over Trace when the screen was read (' + covered.join(', ') + ').'); process.exitCode = 2; return; }
    // Painting after the crash: both captures drawn, the click visibly changed the screen (at least half as much as before
    // the crash), and each view looks as it did before the crash.
    const paints = drawn(report.afterCrash) && report.afterCrash.changed >= Math.max(MIN_CHANGE, report.beforeCrash.changed / 2) && report.afterCrashVsBefore.changed < 0.1 && report.workspaceVsBefore.changed < 0.1;
    console.log(paints ? 'PASS: the window paints after a GPU process crash (not reproduced).' : 'BLACK OR FROZEN: the window did not show the new view after the GPU process crash.');
    if (!paints) process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    // A run that did not pass keeps its captures (and Chromium's frames) for a look.
    if (process.exitCode) console.log('Captures kept in ' + shots);
    else if (!process.env.CODING_HUB_KEEP_SHOTS) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
