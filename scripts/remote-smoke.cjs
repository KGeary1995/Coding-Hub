const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, tileControl } = require('./lib/navigate.cjs');
// Phone remote end to end: turn it on, pair a "phone" (a second window on the remote's page), watch a channel, answer
// its approval prompt from the phone, and remove the phone. Tailscale is not installed here; the page is reached on
// loopback, which the remote also accepts.
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-remote-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');

    // Off by default: nothing listens until it is turned on.
    assert.equal(await fetch('http://127.0.0.1:47821/').then(() => 'open', () => 'closed'), 'closed');
    await openView(page, 'Settings');
    const card = page.locator('.phone-access'); await card.scrollIntoViewIfNeeded();
    await card.getByRole('checkbox', { name: 'Allow paired phones to read and type into channels', exact: true }).check();
    await card.locator('.storage-status').filter({ hasText: /Needs Tailscale|Ready/ }).waitFor();
    assert.match(await card.textContent(), /tailscale\.com\/download|Connected as/);
    await card.getByRole('button', { name: 'Pair a phone', exact: true }).click();
    const code = (await card.locator('p.phone-code').textContent()).replace(/\s/g, '');
    assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/); assert.equal(await card.getByRole('img', { name: /QR code/ }).count(), 1);
    assert.equal((await fetch('http://127.0.0.1:47821/api/channels')).status, 401, 'The API needs a paired device key');

    // The "phone": a separate window on the remote page, opened by the pairing link.
    await app.evaluate(({ BrowserWindow }, url) => { const phone = new BrowserWindow({ width: 390, height: 844, show: true }); void phone.loadURL(url); }, `http://127.0.0.1:47821/#pair=${code}`);
    let phone; for (let i = 0; i < 50 && !phone; i++) { phone = app.windows().find((item) => item.url().startsWith('http://127.0.0.1:47821')); if (!phone) await new Promise((resolve) => setTimeout(resolve, 100)); }
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
    await phone.evaluate((id) => { location.hash = 'channel=' + encodeURIComponent(id); location.reload(); }, codexId);
    await phone.locator('#channel-title').filter({ hasText: 'CH2' }).waitFor();
    assert.equal(new URL(phone.url()).hash, '', 'the alert link is cleared once used');
    await phone.getByRole('button', { name: 'Back to channels' }).click(); await phone.locator('#channel-list button').first().waitFor();

    // Start the Codex channel on the computer, follow it on the phone, and answer its approval prompt from the phone.
    const tile = page.locator('.session-tile').nth(1);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await tile.getByRole('button', { name: 'Start session', exact: true }).click();
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).filter({ hasText: 'running' }).waitFor();
    await phone.locator('#channel-list button').filter({ hasText: 'CH2' }).click();
    await phone.locator('#output').filter({ hasText: 'READY' }).waitFor();
    await phone.locator('#text').fill('need-approval'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('#waiting').filter({ hasText: 'Approval requested: npm test' }).waitFor();
    await tile.locator('.session-attention').getByText('Approval requested: npm test', { exact: true }).waitFor();
    await phone.getByRole('button', { name: 'y', exact: true }).click(); await phone.getByRole('button', { name: 'Enter', exact: true }).click();
    await phone.locator('#output').filter({ hasText: 'ECHO:y' }).waitFor();
    await tile.locator('.session-attention').waitFor({ state: 'detached' });
    await phone.locator('#waiting').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.tr-toast.waiting').count(), 0, 'Answering on the phone clears the desktop notice');
    // Restarting the channel on the computer starts the phone's view afresh, and typing reaches the new run.
    await (await tileControl(tile, 'Stop')).click();
    await (await tileControl(tile, 'Restart')).click();
    await phone.waitForFunction(() => { const text = document.getElementById('output').textContent; return text.includes('READY') && !text.includes('ECHO:y'); });
    await phone.locator('#text').fill('after-restart'); await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await phone.locator('#output').filter({ hasText: 'ECHO:after-restart' }).waitFor();
    assert.equal(await phone.locator('#text').inputValue(), '', 'a delivered message leaves the field');
    // The phone shows the channel at its own size (the CLI redraws for it), so the text fills the phone.
    const width = () => phone.evaluate(async (id) => (await (await fetch('/api/channels', { headers: { Authorization: 'Bearer ' + localStorage.getItem('trace-remote-token') } })).json()).find((channel) => channel.sessionId === id).cols, codexId);
    for (let i = 0; i < 50 && (await width()) > 60; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const phoneCols = await width(); assert.ok(phoneCols >= 20 && phoneCols <= 60, `the channel is drawn at the phone's width (${phoneCols} columns)`);
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

    // Tailscale HTTPS with certificates off for the tailnet: Trace shows the steps, opens the admin console's DNS page,
    // and tries again by itself once the person comes back. A fake tailscale stands in; it appears on PATH only now.
    if (process.platform !== 'win32') {
      const state = path.join(root, 'tailscale-state');
      await fs.writeFile(path.join(bin, 'tailscale'), `#!/usr/bin/env node
const fs = require('node:fs'); const state = ${JSON.stringify(state)}; const args = process.argv.slice(2).join(' ');
const serving = fs.existsSync(state + '.serving');
if (args === 'status --json') console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }));
else if (args === 'serve status --json') console.log(serving ? JSON.stringify({ Web: { 'desk.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47821' } } } } }) : '');
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

    // Removing the phone on the computer locks it out at once.
    await openView(page, 'Settings');
    await card.getByRole('button', { name: 'Remove Phone', exact: true }).click();
    await phone.getByRole('button', { name: 'Back to channels' }).click();
    await phone.getByRole('heading', { name: 'Pair this phone', exact: true }).waitFor();
    await card.getByRole('checkbox', { name: 'Allow paired phones to read and type into channels', exact: true }).uncheck();
    await card.locator('.storage-status').filter({ hasText: 'Off' }).waitFor();
    assert.equal(await fetch('http://127.0.0.1:47821/').then(() => 'open', () => 'closed'), 'closed');
    console.log('PASS: phone remote off by default, pairing by one-time code, device-key API, live channel output on the phone, an approval answered from the phone clearing the desktop prompt, channels drawn at the phone's size and given back, guided Tailscale HTTPS setup, and revocation.');
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
