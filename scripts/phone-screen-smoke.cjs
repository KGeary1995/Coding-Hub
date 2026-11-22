const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
// A phone's Screen on a Windows computer, end to end: the phone app (a second window on the remote's page) opens Screen,
// and Trace's screen service (started here on its own port, with this test's storage) shows this computer's real screen
// in it; keys typed on the phone reach the service. Input goes to a log file instead of being pressed
// (CODING_HUB_TEST_SCREEN_INPUT_LOG). Windows only, like the service. Neither port is Trace's own, so it runs beside an installed Trace.
if (process.platform !== 'win32') { console.log('phone screen smoke skipped: the screen service runs on Windows'); process.exit(0); }
const PORT = 47835; const SERVICE_PORT = 47836;
const until = async (check, what, tries = 200) => { for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for ' + what); };
const healthy = () => fetch(`http://127.0.0.1:${SERVICE_PORT}/health`).then((response) => response.ok, () => false);

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-phone-screen-'))); const storage = path.join(root, 'storage'); const log = path.join(root, 'input.log');
  await fs.mkdir(storage, { recursive: true });
  // Share this screen is on: the app and the service read the same setting and the same key (screen-service-local.json).
  await fs.writeFile(path.join(storage, 'screen-share.json'), JSON.stringify({ enabled: true }));
  const base = { ...process.env, ...NO_DRIVE, CODING_HUB_TEST_SCREEN_SERVICE_PORT: String(SERVICE_PORT) }; delete base.ELECTRON_RUN_AS_NODE;
  const service = spawn(require('electron'), ['--user-data-dir=' + path.join(root, 'service-profile'), path.resolve(__dirname, '..'), '--screen-service', `--storage=${storage}`, '--name=Test-PC'], { env: { ...base, CODING_HUB_TEST_SCREEN_INPUT_LOG: log }, stdio: 'ignore' });
  let app;
  try {
    await until(healthy, 'the screen service to listen');
    const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
    app = await _electron.launch({ executablePath: require('electron'), args, env: { ...base, CODING_HUB_STORAGE_DIR: storage, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), CODING_HUB_TEST_REMOTE_PORT: String(PORT) } });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForSelector('.tr-empty, .session-tile');
    await openView(page, 'Settings');
    const card = page.locator('.phone-access'); await card.scrollIntoViewIfNeeded();
    await card.getByRole('checkbox', { name: 'Allow paired phones to read and type into channels', exact: true }).check();
    await card.getByRole('button', { name: 'Pair a phone', exact: true }).click();
    const code = (await card.locator('p.phone-code').textContent()).replace(/\s/g, '');
    await app.evaluate(({ BrowserWindow }, url) => { const phone = new BrowserWindow({ width: 390, height: 844, show: true }); void phone.loadURL(url); }, `http://127.0.0.1:${PORT}/#pair=${code}`);
    let phone; for (let i = 0; i < 50 && !phone; i++) { phone = app.windows().find((item) => item.url().startsWith(`http://127.0.0.1:${PORT}`)); if (!phone) await new Promise((resolve) => setTimeout(resolve, 100)); }
    phone.setDefaultTimeout(30000); await phone.waitForLoadState();
    const problems = []; phone.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); }); phone.on('pageerror', (error) => problems.push(String(error)));
    await phone.getByRole('button', { name: 'Pair', exact: true }).click();
    await phone.getByRole('heading', { name: 'Channels', exact: true }).waitFor();

    // Without Can start and stop agents the phone is told why it cannot see the screen.
    await phone.getByRole('button', { name: 'Screen', exact: true }).click();
    await phone.locator('main.screen').getByText('Can start and stop agents').waitFor();
    await phone.getByRole('button', { name: 'Back to channels' }).click();
    const allow = card.getByRole('checkbox', { name: 'Can start and stop agents' }); await allow.click();
    await until(() => allow.isChecked(), 'the phone to be allowed');

    // With it, the real screen arrives: the picture is not one flat colour.
    await phone.getByRole('button', { name: 'Screen', exact: true }).click();
    const canvas = phone.locator('.screen-view canvas');
    try {
      await until(() => canvas.evaluate((element) => { const context = element.getContext('2d'); const { width, height } = element; if (width < 100) return false; const data = context.getImageData(0, 0, width, height).data; const colours = new Set(); for (let i = 0; i < data.length; i += 4 * 997) colours.add(data[i] << 16 | data[i + 1] << 8 | data[i + 2]); return colours.size > 20; }).catch(() => false), 'the captured screen on the phone');
    } catch (error) { console.log('phone says:', await phone.locator('main.screen').innerText().catch(() => '(nothing)')); console.log('page errors:', problems.join(' | ') || '(none)'); throw error; }
    // The picture fits the phone's width.
    const box = await canvas.boundingBox(); assert.ok(box && box.width > 100 && box.width <= 390, `the picture fits the phone (${box?.width})`);
    // Typing on the phone's keyboard, and its extra keys, reach the service.
    await phone.locator('.screen-typing').pressSequentially('a');
    await until(async () => /key 97 0/.test(await fs.readFile(log, 'utf8').catch(() => '')), 'the typed key in the log');
    await phone.locator('.screen-keys').getByRole('button', { name: 'Escape' }).click();
    await until(async () => /key 65307 0/.test(await fs.readFile(log, 'utf8').catch(() => '')), 'Esc in the log');
    // A tap is a click there.
    await canvas.click({ position: { x: 40, y: 30 } });
    await until(async () => (await fs.readFile(log, 'utf8')).split('\n').some((line) => /^pointer \d+ \d+ 1$/.test(line)), 'the tap in the log');
    // Leaving the screen lets go of it.
    await phone.getByRole('button', { name: 'Back to channels' }).click();
    await until(async () => (await fs.readFile(log, 'utf8')).includes('close'), 'the phone to leave the screen');
    console.log('PASS: a phone’s Screen on Windows is refused without the permission, then shows this computer’s screen through Trace’s screen service, sends typed keys, extra keys and taps, and lets go on Back');
  } finally {
    await app?.close().catch(() => {});
    service.kill();
    await removeFolder(root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
