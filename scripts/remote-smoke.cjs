const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, startTable, tileControl } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
/** Not Trace's own port (47821), so the test also runs while an installed Trace is open. */
const PORT = 47831;
// Phone remote end to end: turn it on, pair a "phone" (a second window on the remote's page), watch a channel, answer
// its approval prompt from the phone, and remove the phone. Tailscale is not installed here; the page is reached on
// loopback, which the remote also accepts.
/** The longest the whole run may take before it fails on its own. */
const WATCHDOG_MS = 8 * 60000;
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-remote-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const terminalFixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  // Claude's stand-in is the structured (chat) fixture when started as a chat channel, else the terminal one.
  const chatFixture = await fs.readFile(path.join(__dirname, 'fixtures/claude-stream-fixture.cjs'), 'utf8');
  const claudeFixture = `if (process.argv.includes('--input-format')) {
${chatFixture}
} else {
${terminalFixture}
}`;
  for (const engine of ['claude', 'codex']) {
    const fixture = engine === 'claude' ? claudeFixture : terminalFixture;
    if (process.platform === 'win32') {
      const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  // The computer counts as in use (no idle time): opening a channel on the phone still draws it at the phone's size at
  // once. A phone's automatic request, which the desktop wins, is covered by linked-computers.test.ts.
  const env = { ...process.env, ...NO_DRIVE, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), CODING_HUB_TEST_DESKTOP_IDLE: '0', CODING_HUB_TEST_REMOTE_PORT: String(PORT) }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  // It takes under a minute on the Windows runner. An Electron error box once held it for the job's whole 60 minutes, so
  // past this it closes the app and fails, saying so (the workflow step has its own limit too).
  const watchdog = setTimeout(() => { console.error(`remote-smoke: no result after ${WATCHDOG_MS / 60000} minutes; stopping.`); process.exitCode = 1; void Promise.resolve(app?.close()).catch(() => {}).finally(() => process.exit(1)); }, WATCHDOG_MS);
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');

    // Off by default: nothing listens until it is turned on.
    assert.equal(await fetch(`http://127.0.0.1:${PORT}/`).then(() => 'open', () => 'closed'), 'closed');
    await openView(page, 'Settings');
    const card = page.locator('.phone-access'); await card.scrollIntoViewIfNeeded();
    await card.getByRole('checkbox', { name: 'Allow paired phones to read and type into channels', exact: true }).check();
    await card.locator('.storage-status').filter({ hasText: /Needs Tailscale|Ready/ }).waitFor();
    assert.match(await card.textContent(), /tailscale\.com\/download|Connected as/);
    await card.getByRole('button', { name: 'Pair a phone', exact: true }).click();
    const code = (await card.locator('p.phone-code').textContent()).replace(/\s/g, '');
    assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/); assert.equal(await card.getByRole('img', { name: /QR code/ }).count(), 1);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/channels`)).status, 401, 'The API needs a paired device key');

    // The "phone": a separate window on the remote page, opened by the pairing link.
    await app.evaluate(({ BrowserWindow }, url) => { const phone = new BrowserWindow({ width: 390, height: 844, show: true }); void phone.loadURL(url); }, `http://127.0.0.1:${PORT}/#pair=${code}`);
    let phone; for (let i = 0; i < 50 && !phone; i++) { phone = app.windows().find((item) => item.url().startsWith(`http://127.0.0.1:${PORT}`)); if (!phone) await new Promise((resolve) => setTimeout(resolve, 100)); }
    phone.setDefaultTimeout(20000); await phone.waitForLoadState();
    assert.equal(await phone.locator('#code').inputValue(), code);
    await phone.getByRole('button', { name: 'Pair', exact: true }).click();
    await phone.locator('#channel-list button').first().waitFor();
    assert.match(await phone.locator('#channel-list').textContent(), /CH1.*Claude Code.*CH2.*Codex/);
    await card.getByRole('list', { name: 'Paired phones' }).getByText('Phone', { exact: true }).waitFor();
    // Alerts: the phone app installs its service worker and offers the switch (push services are not reachable here).
    await phone.locator('#alerts-switch').waitFor();
    assert.match(await phone.evaluate(async () => (await navigator.serviceWorker.ready).active.scriptURL), /\/sw\.js$/);
    // Tapping an alert opens the app at its channel (the service worker's /#channel= link) once the channel list arrives.
    const codexId = await page.evaluate(async () => (await window.codingHub.loadWorkspace()).value.workspace.sessions[1].id);
    const claudeId = await page.evaluate(async () => (await window.codingHub.loadWorkspace()).value.workspace.sessions[0].id);
    await phone.evaluate((id) => { location.hash = 'channel=' + encodeURIComponent(id); location.reload(); }, codexId);
    await phone.locator('#channel-title').filter({ hasText: 'CH2' }).waitFor();
    assert.equal(new URL(phone.url()).hash, '', 'the alert link is cleared once used');
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('#channel-list button').first().waitFor();

    // Start the Codex channel on the computer, follow it on the phone, and answer its approval prompt from the phone.
    const tile = page.locator('.session-tile').filter({ has: page.getByRole('status', { name: /^Channel 2 / }) }); // CH2, wherever it is drawn (alone while isolated below)
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await tile.getByRole('button', { name: 'Start channel', exact: true }).click();
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).filter({ hasText: 'Working' }).waitFor();
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-list.png') });
    // CH2 maximised on the computer for the size checks below, so the desktop's size is wider than the phone's (60 columns)
    // on any screen: in the grid on a smaller one (the Windows release candidate's) the tile was no wider than the phone.
    await (await tileControl(page, 'Isolate channel 2')).click();
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).click();
    await phone.locator('#output').filter({ hasText: 'READY' }).waitFor();
    // Opening a terminal channel takes it at the phone's size: the text is at the chosen size (13 px) from the start,
    // never shrunk to the desktop's width, and the CLI is redrawn at the phone's columns.
    const textSize = () => phone.locator('#output .xterm-rows').evaluate((element) => getComputedStyle(element).fontSize);
    const computerLine = () => phone.locator('#computer-size').isVisible();
    assert.equal(await textSize(), '13px', 'a channel opens with its text at the chosen size');
    assert.equal(await computerLine(), false, 'a channel opens at the phone\'s size');
    // One row of keys (1.36.0, after herdr): the rest and the channel's tools wait under More, so the terminal keeps the screen.
    assert.equal(await phone.getByRole('button', { name: 'y', exact: true }).isVisible(), false, 'the extra keys start under More');
    await phone.getByRole('button', { name: 'More keys and tools', exact: true }).click(); await phone.getByRole('button', { name: 'y', exact: true }).waitFor();
    assert.equal(await phone.evaluate(() => localStorage.getItem('trace-remote-more')), 'open', 'More stays as left on this phone');
    const width = () => phone.evaluate(async (id) => (await (await fetch('/api/channels', { headers: { Authorization: 'Bearer ' + localStorage.getItem('trace-remote-token') } })).json()).find((channel) => channel.sessionId === id).cols, codexId);
    const reported = () => phone.evaluate(() => Number([...document.getElementById('output').textContent.matchAll(/SIZE:(\d+)x/g)].at(-1)?.[1]));
    for (let i = 0; i < 50 && (await reported()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = await reported(); assert.ok(opened >= 20 && opened <= 60, `the CLI reports the phone's columns on opening (${opened})`);
    assert.equal(await width(), opened, 'the computer draws the channel at the columns the CLI reports');
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-open.png') });
    // Tapping the terminal opens the message box; the terminal itself takes no typing (a phone keyboard garbles it).
    await phone.locator('#output').click(); await phone.waitForFunction(() => document.activeElement?.id === 'text');
    await phone.locator('#output .xterm-helper-textarea').evaluate((element) => element.focus()); await phone.keyboard.type('stray'); await phone.waitForTimeout(300);
    await phone.locator('#text').fill('need-approval'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('#waiting').filter({ hasText: 'Approval requested: npm test' }).waitFor();
    await tile.locator('.session-attention').getByText('Approval requested: npm test', { exact: true }).waitFor();
    assert.equal(await page.locator('.tr-toast.waiting').count(), 0, 'A channel whose tile is on screen raises no desktop notice');
    // Needs you lists the approval with its exact request, on the computer and on the phone's channel list.
    await page.getByRole('button', { name: 'Needs you · 1', exact: true }).click();
    await page.getByRole('dialog', { name: 'Needs you' }).getByText('Approval requested: npm test').waitFor(); await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }, url) => { const list = new BrowserWindow({ width: 390, height: 844, show: true, title: 'phone-list' }); void list.loadURL(url); }, `http://127.0.0.1:${PORT}/#needs-you-check`);
    let listPage; for (let i = 0; i < 50 && !listPage; i++) { listPage = app.windows().find((item) => item.url().endsWith('#needs-you-check')); if (!listPage) await new Promise((resolve) => setTimeout(resolve, 100)); }
    listPage.setDefaultTimeout(20000); await listPage.locator('#needs-you').filter({ hasText: 'CH2 needs approval' }).filter({ hasText: 'Approval requested: npm test' }).waitFor(); await listPage.close();
    // On another page of the computer the channel's tile is not on screen, so its notice is drawn there.
    await page.locator('.tr-tabs').getByRole('button', { name: 'Tasks', exact: true }).click(); await page.locator('.tr-toast.waiting').filter({ hasText: 'CH2 needs approval' }).waitFor();
    await phone.getByRole('button', { name: 'y', exact: true }).click(); await phone.getByRole('button', { name: 'Enter', exact: true }).click();
    await phone.locator('#output').filter({ hasText: 'ECHO:y' }).waitFor();
    await phone.locator('#waiting').waitFor({ state: 'hidden' });
    // Answering on the phone clears the desktop notice, and the request on the tile.
    await page.locator('.tr-toast.waiting').waitFor({ state: 'detached' }); await page.locator('.tr-tabs').getByRole('button', { name: 'Workspace', exact: true }).click();
    await tile.waitFor(); assert.equal(await tile.locator('.session-attention').count(), 0, 'Answering on the phone clears the request on the tile');
    // Restarting the channel on the computer starts the phone's view afresh, and typing reaches the new run.
    await (await tileControl(tile, 'Stop')).click();
    await (await tileControl(tile, 'Restart')).click();
    await phone.waitForFunction(() => { const text = document.getElementById('output').textContent; return text.includes('READY') && !text.includes('ECHO:y'); });
    // Restarted from the desktop tile, the channel is the desktop's (1.35.2: whoever last used a channel leads), until the
    // phone uses it: sending a message below takes it again.
    for (let i = 0; i < 50 && (await width()) <= 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) > 60, 'a channel restarted from the desktop tile is drawn at the desktop\'s size');
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-channel.png') });
    await phone.locator('#text').fill('after-restart'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('#output').filter({ hasText: 'ECHO:after-restart' }).waitFor();
    assert.equal(await phone.locator('#text').inputValue(), '', 'a delivered message leaves the field');
    // The phone shows the channel at its own size (the CLI redraws for it), so the text fills the phone.
    for (let i = 0; i < 50 && (await width()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const phoneCols = await width(); assert.ok(phoneCols >= 20 && phoneCols <= 60, `the channel is drawn at the phone's width (${phoneCols} columns)`);
    // Typing at the desktop takes the channel back, and the phone does not take it again by itself (its screen changing
    // size, as when the address bar hides), only when it is used.
    await tile.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('z'); await page.keyboard.press('Backspace');
    for (let i = 0; i < 50 && (await width()) <= 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) > 60, `typing at the desktop gives the desktop its size back (${await width()} columns)`);
    // The phone then shows the computer's screen at its own text size, panned, never shrunk, and says how to take it back.
    await phone.locator('#computer-size').waitFor(); assert.equal(await textSize(), '13px', 'the computer\'s screen is shown at the chosen text size');
    await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith(`http://127.0.0.1:${port}`))?.setSize(390, 700), PORT); await phone.waitForTimeout(600);
    assert.ok((await width()) > 60, 'a phone screen change does not take the channel back');
    await phone.locator('#output').click();
    for (let i = 0; i < 50 && (await width()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) <= 60, 'touching the channel on the phone draws it at the phone\'s size again');
    // Focusing that channel's tile on the desktop (without typing) gives it back, and touching it on the phone takes it
    // again (1.35.2). Before, the computer merely being used for ten seconds gave it back, whatever channel it was used on.
    await page.evaluate(() => document.activeElement?.blur()); await tile.locator('.xterm-helper-textarea').focus();
    for (let i = 0; i < 50 && (await width()) <= 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) > 60, 'focusing the channel\'s tile on the desktop gives it the size back');
    await phone.locator('#output').click();
    for (let i = 0; i < 50 && (await width()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) <= 60, 'touching the channel again draws it at the phone\'s size');
    // A locked phone (or one showing another app) gives it back; coming back takes nothing until the phone is touched
    // (herdr: only use moves the size).
    const visibility = (state) => phone.evaluate((value) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value }); document.dispatchEvent(new Event('visibilitychange')); }, state);
    await visibility('hidden');
    for (let i = 0; i < 50 && (await width()) <= 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) > 60, 'a locked phone gives the desktop its size back');
    await visibility('visible'); await phone.waitForTimeout(800);
    assert.ok((await width()) > 60, 'unlocking the phone takes nothing by itself');
    await phone.locator('#output').click();
    for (let i = 0; i < 50 && (await width()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) <= 60, 'touching it after unlocking draws the channel at its size again');
    // The switcher (herdr's agents-first switch) lists every channel, one tap away, from inside a channel.
    await phone.getByRole('button', { name: /^Switch channel/ }).click();
    const switcher = phone.getByRole('dialog', { name: 'Switch channel' }); await switcher.waitFor();
    assert.match(await switcher.textContent(), /CH1.*CH2|CH2.*CH1/s, 'the switcher lists the channels');
    await switcher.getByRole('button', { name: 'Close', exact: true }).click(); await switcher.waitFor({ state: 'detached' });
    // With no computer answering, the last screen stays, dimmed, and typing waits.
    await phone.evaluate(() => document.body.classList.add('offline'));
    assert.ok(Number(await phone.locator('#output').evaluate((element) => getComputedStyle(element).opacity)) < 1, 'an offline phone dims the screen');
    await phone.evaluate(() => document.body.classList.remove('offline'));
    // A message that cannot be delivered stays in the field instead of being lost.
    const long = 'x'.repeat(5000); await phone.locator('#text').fill(long); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('#send-error').filter({ hasText: 'at most 4,095 characters' }).waitFor();
    assert.equal(await phone.locator('#text').inputValue(), long, 'an undelivered message stays in the field');
    // So does a draft left while looking at another screen. Leaving the channel gives the desktop its size back.
    await phone.getByRole('button', { name: 'Back to channels' }).click();
    for (let i = 0; i < 50 && (await width()) <= 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await width()) > 60, 'leaving the channel on the phone gives the desktop its size back');
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).click();
    assert.equal(await phone.locator('#text').inputValue(), long, 'a draft survives going back to the channel list');
    await phone.locator('#text').fill('');
    await (await tileControl(page, 'Restore grid')).click();

    // Tailscale HTTPS with certificates off for the tailnet: Trace shows the steps, opens the admin console's DNS page,
    // and tries again by itself once the person comes back. A fake tailscale stands in; it appears on PATH only now.
    if (process.platform !== 'win32') {
      const state = path.join(root, 'tailscale-state');
      await fs.writeFile(path.join(bin, 'tailscale'), `#!/usr/bin/env node
const fs = require('node:fs'); const state = ${JSON.stringify(state)}; const args = process.argv.slice(2).join(' ');
const serving = fs.existsSync(state + '.serving');
if (args === 'status --json') console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }));
else if (args === 'serve status --json') console.log(serving ? JSON.stringify({ Web: { 'desk.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:${PORT}' } } } } }) : '');
else if (args.startsWith('serve --bg --https=443')) {
  fs.appendFileSync(state + '.calls', 'serve\\n');
  if (!fs.existsSync(state + '.certificates')) { console.error('HTTPS certificates must be enabled for your tailnet in the Tailscale admin console.'); process.exit(1); }
  fs.writeFileSync(state + '.serving', '');
} else process.exit(2);
`, { mode: 0o755 });
      await app.evaluate(({ dialog, shell }) => {
        globalThis.smokeDialogs = 0; globalThis.smokeOpened = [];
        dialog.showMessageBox = async () => { globalThis.smokeDialogs++; return { response: 0, checkboxChecked: false }; };
        shell.openExternal = async (url) => { globalThis.smokeOpened.push(url); };
      });
      await openView(page, 'Settings');
      await card.getByText('Connected as', { exact: false }).waitFor();
      await card.getByRole('button', { name: 'Set up Tailscale HTTPS', exact: true }).click();
      const guide = card.getByRole('group', { name: 'Finish Tailscale HTTPS' });
      await guide.getByText('Enable HTTPS', { exact: true }).waitFor();
      assert.deepEqual(await app.evaluate(() => [globalThis.smokeDialogs, globalThis.smokeOpened]), [1, ['https://login.tailscale.com/admin/dns']]);
      // Coming back without changing anything retries quietly: no second question, no page bounced open again.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      for (let i = 0; i < 100 && (await fs.readFile(state + '.calls', 'utf8')).split('\n').filter(Boolean).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      await guide.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assert.deepEqual(await app.evaluate(() => [globalThis.smokeDialogs, globalThis.smokeOpened.length]), [1, 1]);
      await guide.getByRole('button', { name: 'Open Tailscale DNS settings', exact: true }).click();
      for (let i = 0; i < 50 && await app.evaluate(() => globalThis.smokeOpened.length) < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await app.evaluate(() => globalThis.smokeOpened), ['https://login.tailscale.com/admin/dns', 'https://login.tailscale.com/admin/dns']);
      // The person turns certificates on and returns: HTTPS is set up without another click.
      await fs.writeFile(state + '.certificates', '');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await card.getByText('https://desk.example.ts.net/', { exact: true }).waitFor();
      assert.equal(await guide.count(), 0); assert.equal(await app.evaluate(() => globalThis.smokeDialogs), 1);
      await fs.rm(path.join(bin, 'tailscale'));
    }

    // A phone may not start agents until the computer allows it (Settings → Phone access); then it can add and start a
    // channel. A Claude chat's conversation, its approval and the reply work from the phone, and show on the desktop.
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('#channel-list button').first().waitFor();
    assert.equal(await phone.locator('#add-channel').isVisible(), false, 'no + Channel on a phone that may not start agents');
    await openView(page, 'Settings'); await card.scrollIntoViewIfNeeded();
    // The box follows the computer's answer (it is checked once the permission is saved), so wait for it rather than check().
    const allow = card.getByRole('checkbox', { name: 'Can start and stop agents' }); await allow.click();
    for (let i = 0; i < 100 && !(await allow.isChecked()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(await allow.isChecked(), 'the phone is allowed to start agents');
    await phone.locator('#add-channel').waitFor({ state: 'visible' });
    // Channel settings on the phone: the name, permissions and model of a stopped Claude Code channel, chosen by name.
    await phone.locator('#channel-list button').filter({ hasText: 'CH1' }).click();
    await phone.getByRole('button', { name: 'Settings for CH1' }).click();
    const sheet = phone.getByRole('dialog', { name: 'Channel settings' }); await sheet.getByLabel('Channel name').waitFor();
    assert.deepEqual(await sheet.getByLabel('Model').locator('option').allTextContents(), ['Claude Code’s default', 'Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'], 'Claude Code\'s models by name');
    await sheet.getByLabel('Channel name').fill('From the phone'); await sheet.getByLabel('Permissions').selectOption('ask'); await sheet.getByLabel('Model').selectOption('claude-haiku-5-5');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click(); await sheet.waitFor({ state: 'detached' });
    await phone.locator('#channel-title').filter({ hasText: 'From the phone' }).waitFor();
    // The computer has them, as its own settings now hold them (its window shows Settings here, not the tiles).
    const saved = await phone.evaluate(async (id) => (await fetch('/api/channel-settings?sessionId=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + localStorage.getItem('trace-remote-token') } })).json(), claudeId);
    assert.deepEqual([saved.title, saved.permissions, saved.model], ['From the phone', 'ask', 'claude-haiku-5-5'], 'the settings changed on the phone are saved on the computer');
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('#channel-list button').first().waitFor();
    // A terminal channel's buttons follow it (1.31.4; they stayed as first drawn): stopped, Start; started, Stop.
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).click(); await phone.getByRole('button', { name: 'Stop CH2', exact: true }).click();
    await phone.getByRole('button', { name: 'Start CH2', exact: true }).click(); await phone.getByRole('button', { name: 'Stop CH2', exact: true }).waitFor();
    // At 320 px wide (the narrowest phones) nothing on the channel screen runs past its edge, and the name keeps room
    // (checked in 1.31.6, after a review said its header and tool bar ran over at 360).
    const phoneSize = async (width) => { await app.evaluate(({ BrowserWindow }, [port, w]) => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith(`http://127.0.0.1:${port}`) && !item.webContents.getURL().includes('#needs-you'))?.setContentSize(w, 780), [PORT, width]); await phone.waitForTimeout(400); };
    await phoneSize(320); const narrow = await phone.evaluate(() => ({ page: document.documentElement.scrollWidth, width: innerWidth, title: Math.round(document.getElementById('channel-title')?.getBoundingClientRect().width ?? 0), past: [...document.querySelectorAll('.bar *, .tools *, main *')].filter((item) => { const box = item.getBoundingClientRect(); return box.width > 0 && box.right > innerWidth + 1; }).map((item) => item.className || item.tagName).slice(0, 6) }));
    assert.ok(narrow.page <= narrow.width && !narrow.past.length && narrow.title >= 72, `the channel screen at 320 px: ${JSON.stringify(narrow)}`); await phoneSize(390);
    // The phone's own Back (Android's Back button, the iPhone's swipe) leaves the channel for the list, not the app (1.31.6).
    await phone.goBack(); await phone.locator('#channel-list button').first().waitFor(); assert.ok(phone.url().startsWith(`http://127.0.0.1:${PORT}`), 'still in the app');
    // The app preview's picture for a phone (1.39.0; untested end to end before 1.44.0): an app address a channel prints is
    // pictured off screen and sent to the phone as a JPEG data URL, with the address; a channel that printed none says so.
    { const appServer = require('node:http').createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Phone app</title><h1 style="font:64px sans-serif">Phone app</h1>'); });
      await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve)); const appPort = appServer.address().port;
      try {
        await page.locator(`.session-tile[data-session="${codexId}"] .xterm-helper-textarea`).focus(); await page.keyboard.type(`http://127.0.0.1:${appPort}/`); await page.keyboard.press('Enter');
        const picture = (id) => phone.evaluate(async (sessionId) => { const response = await fetch('/api/preview?sessionId=' + encodeURIComponent(sessionId), { headers: { Authorization: 'Bearer ' + localStorage.getItem('trace-remote-token') } }); return { status: response.status, body: await response.json() }; }, id);
        let shown = null; for (let i = 0; i < 60 && !(shown && shown.status === 200); i++) { shown = await picture(codexId); if (shown.status !== 200) await new Promise((resolve) => setTimeout(resolve, 250)); }
        assert.equal(shown.status, 200, `the phone's app picture: ${JSON.stringify(shown.body).slice(0, 200)}`);
        assert.ok(shown.body.image.startsWith('data:image/jpeg;base64,') && shown.body.image.length > 1000, 'a JPEG picture of the app'); assert.equal(shown.body.url, `http://127.0.0.1:${appPort}/`);
        const none = await picture(claudeId); assert.equal(none.status, 409, 'a channel that printed no address has no picture');
      } finally { appServer.close(); } }
    // The phone's + Channel offers each agent as a terminal and, from 1.39.1, as a chat, as the computer's does: from 1.43.0
    // one row each with CLI and Chat, each keeping its full name. The chat checks below add theirs through the same request
    // the menu sends.
    await phone.locator('#add-channel').click(); await phone.getByRole('menuitem', { name: 'Claude Code', exact: true }).waitFor();
    assert.deepEqual(await phone.getByRole('menuitem').allTextContents(), ['Terminal', 'CLI', 'Chat', 'CLI', 'Chat', 'CLI', 'Chat'], 'the phone\'s + Channel rows');
    assert.deepEqual(await phone.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent)), ['Terminal', 'Claude Code', 'Claude Code chat', 'Codex', 'Codex chat', 'Gemini', 'Gemini chat'], 'the phone\'s + Channel names');
    await phone.locator('#add-channel').click();
    assert.equal(await phone.evaluate(async () => (await fetch('/api/channel-add', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('trace-remote-token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'claude', chat: true }) })).status), 200);
    await phone.locator('#channel-list button').filter({ hasText: 'CH3' }).waitFor();
    await phone.locator('#channel-list button').filter({ hasText: 'CH3' }).click();
    await phone.getByRole('button', { name: 'Start CH3', exact: true }).click();
    const box = phone.getByRole('textbox', { name: 'Message to Claude', exact: true });
    await phone.waitForFunction(() => { const area = document.querySelector('.phone-chat textarea'); return area && !area.disabled; });
    await box.fill('hello from the phone'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('.phone-chat').filter({ hasText: 'You said: hello from the phone' }).waitFor();
    await phone.locator('.phone-chat .chat-user-text').filter({ hasText: 'hello from the phone' }).waitFor();
    await openView(page, 'Workspace');
    await page.locator('[data-chat-session]').filter({ hasText: 'hello from the phone' }).filter({ hasText: 'You said: hello from the phone' }).waitFor();
    // A message being written on the computer outlives its view: maximising the tile, restoring it, another page.
    const draft = page.getByRole('textbox', { name: 'Message to Claude', exact: true }); await draft.fill('kept while I look elsewhere');
    await (await tileControl(page, 'Isolate channel 3')).click(); assert.equal(await draft.inputValue(), 'kept while I look elsewhere', 'the draft is kept when the tile is maximised');
    await (await tileControl(page, 'Restore grid')).click(); await openView(page, 'Changes'); await openView(page, 'Workspace');
    assert.equal(await draft.inputValue(), 'kept while I look elsewhere', 'the draft is kept when the tile is restored and another page is opened'); await draft.fill('');
    // Full access asks once more; cancelled, the level in effect stays.
    const level = page.locator('[data-chat-session] select.chat-permissions').first(); const before = await level.inputValue();
    await level.selectOption('full'); const confirm = page.getByRole('alertdialog', { name: 'Turn on Full access?' });
    await confirm.getByRole('button', { name: 'Turn on Full access', exact: true }).waitFor(); assert.equal(await level.inputValue(), before, 'Full access waits to be confirmed'); if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-full-access.png') });
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click(); await confirm.waitFor({ state: 'detached' }); assert.equal(await level.inputValue(), before);
    // While a reply runs, Stop stays beside the box once the next message is being written, and Send joins it (1.31.2).
    const chatView = page.locator('[data-chat-session]').filter({ hasText: 'hello from the phone' });
    await draft.fill('slow-fixture-reply'); await draft.press('Enter'); const stopReply = chatView.getByRole('button', { name: "Stop Claude's reply", exact: true }); await stopReply.waitFor();
    await draft.fill('the next one'); assert.ok(await stopReply.isVisible(), 'Stop stays while writing'); assert.ok(await chatView.getByRole('button', { name: 'Send', exact: true }).isVisible(), 'Send is beside it');
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-stop-send.png') });
    await stopReply.click(); await chatView.locator('.chat-working').waitFor({ state: 'detached' }); await draft.fill('');
    // A fenced block in a reply has its language and Copy above it.
    await draft.fill('a block\n```sh\nnpm test\n```'); await draft.press('Enter');
    const block = chatView.locator('.chat-code-block').filter({ hasText: 'npm test' }).last(); await block.locator('.chat-code-head').filter({ hasText: 'sh' }).waitFor();
    await block.getByRole('button', { name: 'Copy this sh', exact: true }).click(); await block.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'npm test', 'Copy takes the code');
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-code.png') });
    await box.fill('please write a note'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    // The approval shows what the new file holds, not only its name.
    await phone.locator('.phone-chat .chat-permission .chat-permission-changes pre.added').filter({ hasText: 'hi' }).waitFor();
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-approval.png') });
    await phone.locator('.phone-chat .chat-permission').getByRole('button', { name: 'Allow', exact: true }).click();
    await phone.locator('.phone-chat').filter({ hasText: 'Wrote notes.txt.' }).waitFor();
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-chat.png') });
    // A Round Table from the phone: Codex joins this chat as a chat channel in the same folder, started, and seated.
    await phone.getByRole('button', { name: 'Round Table: add Codex', exact: true }).click();
    await phone.locator('.phone-chat .table-bar').filter({ hasText: 'Claude Code drives' }).waitFor({ timeout: 90000 });
    await phone.locator('#channel-list, .phone-chat').first().waitFor();
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-table.png') });
    await phone.getByRole('button', { name: 'Stop CH3', exact: true }).click();
    await phone.getByRole('button', { name: 'Start CH3', exact: true }).waitFor();
    await openView(page, 'Settings'); await card.scrollIntoViewIfNeeded();

    // The phone's other tabs: today's usage, the task board, conversation history and memory, from this computer.
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('.tabbar').waitFor();
    await phone.locator('.tabbar').getByRole('button', { name: 'Usage' }).click();
    await phone.locator('.phone-card').filter({ hasText: 'Σ Today' }).filter({ hasText: 'tok' }).waitFor();
    await phone.locator('.phone-card').filter({ hasText: 'Plan limits' }).waitFor();
    if (process.env.CODING_HUB_REMOTE_SCREENSHOT) await phone.screenshot({ path: process.env.CODING_HUB_REMOTE_SCREENSHOT.replace(/\.png$/, '-usage.png') });
    await phone.locator('.tabbar').getByRole('button', { name: 'Tasks' }).click();
    await phone.locator('.empty').filter({ has: phone.getByText('No tasks', { exact: true }) }).getByText('Give a channel a task on the computer', { exact: false }).waitFor();
    await phone.locator('.tabbar').getByRole('button', { name: 'History' }).click();
    await phone.locator('.screen-host').filter({ hasNotText: 'Loading' }).waitFor();
    assert.equal(await phone.locator('.screen-host .error').count(), 0, 'history loads without an error');
    await phone.locator('.tabbar').getByRole('button', { name: 'More' }).click();
    await phone.getByRole('textbox', { name: 'Title' }).fill('From the phone'); await phone.getByRole('textbox', { name: 'Note' }).fill('Checked the build.');
    await phone.getByRole('button', { name: 'Save handoff', exact: true }).click();
    await phone.locator('.note').filter({ hasText: 'From the phone' }).waitFor();
    await phone.locator('.tabbar').getByRole('button', { name: 'Channels' }).click(); await phone.locator('#channel-list button').first().waitFor();
    // A hierarchy Round Table started on the computer: the planner's reply reaches the phone, labelled, under the steps bar.
    await openView(page, 'Workspace'); await startTable(page, 'Round Table (hierarchy)');
    await page.locator('.chain-bar').waitFor({ timeout: 90000 });
    const tableBox = page.getByRole('textbox', { name: 'Message to the Round Table' }); await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((area) => area.getAttribute('aria-label') === 'Message to the Round Table' && !area.disabled));
    await tableBox.fill('Plan a footer'); await tableBox.press('Enter');
    // Codex challenges the plan next; the stand-in Codex cannot answer, so the challenge stops and is left out.
    const leaveOut = page.locator('.chain-bar').getByRole('button', { name: 'Continue without the challenge', exact: true });
    await leaveOut.waitFor({ timeout: 60000 }); await leaveOut.click();
    await page.locator('.chain-bar').filter({ hasText: 'plan is ready' }).filter({ hasText: 'The challenge was left out at your request.' }).waitFor({ timeout: 60000 });
    // A revision the person asks for survives Stop: Continue asks the planner for it again (the stand-in planner answers
    // with the prompt it was given, after 4 s for this note, and an interrupt cancels that answer).
    await tableBox.fill('Make the footer smaller, slow-fixture-reply'); await tableBox.press('Enter');
    const chainBar = page.locator('.chain-bar');
    await chainBar.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 30000 });
    await chainBar.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30000 });
    await chainBar.getByRole('button', { name: 'Approve plan', exact: true }).waitFor({ timeout: 60000 });
    const revised = page.locator('.table-planner').filter({ hasText: 'The person asks you to revise the plan' });
    assert.equal(await revised.count(), 1, 'one planner answer to the revision: the stopped turn left none');
    assert.match(await revised.innerText(), /Make the footer smaller, slow-fixture-reply/);
    await phone.locator('#channel-list button').filter({ hasText: 'Round Table' }).filter({ hasNotText: 'CH3' }).first().click();
    await phone.locator('.phone-chat .chain-bar').filter({ hasText: 'Round Table · hierarchy' }).filter({ hasText: 'Approve plan' }).waitFor({ timeout: 30000 });
    await phone.locator('.phone-chat .chat-author').filter({ hasText: 'Planner' }).first().waitFor({ timeout: 30000 });
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('#channel-list button').first().waitFor();
    // The removal below is found from inside a channel, as before.
    await phone.locator('#channel-list button').filter({ hasText: 'CH1' }).first().click(); await phone.getByRole('button', { name: 'Back to channels' }).waitFor();

    // Removing the phone on the computer locks it out at once.
    await openView(page, 'Settings');
    await card.getByRole('button', { name: 'Remove Phone', exact: true }).click();
    // The removal ends the phone's open stream, so the app may show the pairing page by itself while Back is being
    // clicked: the button is then gone, and the click must not wait 20 s for it (about one run in ten failed that way).
    await phone.getByRole('button', { name: 'Back to channels' }).click({ timeout: 3000 }).catch(() => {});
    await phone.getByRole('heading', { name: 'Pair this phone', exact: true }).waitFor();
    await card.getByRole('checkbox', { name: 'Allow paired phones to read and type into channels', exact: true }).uncheck();
    await card.locator('.storage-status').filter({ hasText: 'Off' }).waitFor();
    assert.equal(await fetch(`http://127.0.0.1:${PORT}/`).then(() => 'open', () => 'closed'), 'closed');
    console.log('PASS: phone remote off by default, per-phone permission to start agents, a chat channel used from the phone (message, approval, reply, shown on the desktop), the phone’s Usage, Tasks, History and Memory tabs, Needs you on the computer and the phone, a hierarchy table’s planner on the phone, a plan revision kept through Stop and Continue, pairing by one-time code, device-key API, live channel output on the phone, an approval answered from the phone clearing the desktop prompt, terminal channels opened at the phone’s size even while the computer is in use, Desktop size remembered on the phone, channels given back, guided Tailscale HTTPS setup, and revocation.');
  } finally {
    clearTimeout(watchdog);
    await app?.close().catch(() => {});
    await removeFolder(root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
