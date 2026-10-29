const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
// The Windows screen service end to end: Trace started with --screen-service captures this computer's real screen,
// and a second Trace, linked to it, shows it with Screen. Input goes to a log file instead of being pressed
// (CODING_HUB_TEST_SCREEN_INPUT_LOG), so the test does not take over the mouse. Windows only, like the service.
if (process.platform !== 'win32') { console.log('screen service smoke skipped: the screen service runs on Windows'); process.exit(0); }
const PC = '80549399-8fe7-47df-bdba-e635aa37e60d'; const TOKEN = 't'.repeat(43); const PORT = 47832;
const until = async (check, what, tries = 200) => { for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for ' + what); };
const healthy = () => fetch(`http://127.0.0.1:${PORT}/health`).then((response) => response.ok, () => false);

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-screen-service-'))); const serviceRoot = path.join(root, 'pc'); const viewerRoot = path.join(root, 'viewer');
  await Promise.all([fs.mkdir(serviceRoot, { recursive: true }), fs.mkdir(viewerRoot, { recursive: true })]);
  // The PC: sharing on, and the viewer's key among its linked computers (only the hash is stored, as the remote does).
  await fs.writeFile(path.join(serviceRoot, 'screen-share.json'), JSON.stringify({ enabled: true }));
  await fs.writeFile(path.join(serviceRoot, 'remote-devices.json'), JSON.stringify([{ id: '5a9e3c3e-2f7e-4c1b-9d55-0c2f8e9b1a01', name: 'Test-Mac', tokenHash: createHash('sha256').update(TOKEN).digest('hex'), createdAt: new Date().toISOString(), lastSeen: null, kind: 'computer' }]));
  // The viewer: linked to the PC, whose address is the service itself here (Tailscale would pass /api/screen to it).
  await fs.writeFile(path.join(viewerRoot, 'linked-computers.json'), JSON.stringify([{ id: PC, name: 'Test-PC', url: `http://127.0.0.1:${PORT}/`, token: TOKEN, linkedAt: new Date().toISOString() }]));
  const log = path.join(root, 'input.log');
  const base = { ...process.env }; delete base.ELECTRON_RUN_AS_NODE;
  const service = spawn(require('electron'), ['--user-data-dir=' + path.join(root, 'service-profile'), path.resolve(__dirname, '..'), '--screen-service', `--storage=${serviceRoot}`, '--name=Test-PC'], { env: { ...base, CODING_HUB_TEST_SCREEN_SERVICE_PORT: String(PORT), CODING_HUB_TEST_SCREEN_INPUT_LOG: log }, stdio: 'ignore' });
  let app;
  try {
    await until(healthy, 'the screen service to listen');
    const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
    app = await _electron.launch({ executablePath: require('electron'), args, env: { ...base, CODING_HUB_STORAGE_DIR: viewerRoot, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForSelector('.tr-empty, .session-tile');
    await page.locator('.tr-computer-tab', { hasText: 'Test-PC' }).click();
    await page.getByRole('button', { name: 'Screen', exact: true }).click();
    const panel = page.locator('.linked-screen');
    // No password: the link key signed it in.
    await panel.getByRole('status').filter({ hasText: 'Controlling' }).waitFor();
    assert.equal(await panel.locator('.linked-screen-signin').count(), 0);
    const canvas = panel.locator('.linked-screen-view canvas');
    // The real screen arrives: the picture is not one flat colour.
    await until(() => canvas.evaluate((element) => { const context = element.getContext('2d'); const { width, height } = element; if (width < 100) return false; const data = context.getImageData(0, 0, width, height).data; const colours = new Set(); for (let i = 0; i < data.length; i += 4 * 997) colours.add(data[i] << 16 | data[i + 1] << 8 | data[i + 2]); return colours.size > 20; }), 'the captured screen');
    const size = await canvas.evaluate((element) => [element.width, element.height]); console.log('captured at', size.join('×'));
    // A Windows viewer of Windows needs no key swap.
    assert.equal(await panel.locator('.linked-screen-toggle').count(), 0);
    await canvas.click({ position: { x: 40, y: 30 } }); await page.keyboard.press('a');
    await until(async () => /key 97 0/.test(await fs.readFile(log, 'utf8').catch(() => '')), 'the key press in the log');
    const lines = (await fs.readFile(log, 'utf8')).split('\n');
    assert.ok(lines.some((line) => /^pointer \d+ \d+ 1$/.test(line)), 'The click reached the service');
    // Back to the channels: the service lets go of the viewer.
    await page.getByRole('button', { name: 'Channels', exact: true }).click();
    await until(async () => (await fs.readFile(log, 'utf8')).includes('close'), 'the viewer to leave');
    // Turning sharing off stops the service.
    await fs.writeFile(path.join(serviceRoot, 'screen-share.json'), JSON.stringify({ enabled: false }));
    await until(async () => !(await healthy()), 'the service to quit', 100);
    console.log('screen service smoke passed');
  } finally {
    await app?.close().catch(() => {}); service.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exit(1); });
