const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-account-profiles-')));
  const bin = path.join(root, 'bin'); const project = path.join(root, 'project'); const legacy = path.join(root, 'legacy-claude');
  await Promise.all([bin, project, legacy].map((folder) => fs.mkdir(folder)));
  await fs.writeFile(path.join(legacy, 'fixture-authenticated'), 'default-login-preserved');
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  if (process.platform === 'win32') {
    const packageRoot = path.join(bin, 'node_modules/@anthropic-ai/claude-code');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { claude: 'fixture.cjs' } }));
    await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  } else await fs.writeFile(path.join(bin, 'claude'), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: legacy, ANTHROPIC_API_KEY: 'fixture-inherited-key', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-inherited-token' };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  const native = async (page, method, request) => {
    const result = await page.evaluate(({ method, request }) => window.codingHub[method](request), { method, request });
    assert.equal(result.ok, true, result.error?.message); return result.value;
  };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    let page = await app.firstWindow(); await page.waitForSelector('.session-tile');
    await page.getByRole('button', { name: 'Accounts & connections', exact: true }).click();
    for (const name of ['Personal', 'Work']) {
      await page.getByLabel('New Claude profile name', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Add Claude profile', exact: true }).click();
      await page.getByRole('button', { name: 'Connect Claude profile', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.profile-connect button')?.disabled);
      assert.equal(await page.getByText('Profile sign-in needed', { exact: true }).isVisible(), true);
      await page.getByRole('button', { name: 'Connect Claude profile', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.account-terminal')?.textContent.includes('READY'));
      await page.locator('.account-terminal .xterm-helper-textarea').focus();
      await page.keyboard.type('complete-login'); await page.keyboard.press('Enter');
      await page.getByText('Profile connected through local CLI', { exact: true }).waitFor();
    }
    const profiles = await native(page, 'accounts', { action: 'profile-list' }); assert.equal(profiles.length, 2);
    assert.equal((await native(page, 'listHistory')).length, 0, 'Login output must not become coding history');
    assert.equal(await fs.readFile(path.join(legacy, 'fixture-authenticated'), 'utf8'), 'default-login-preserved');
    for (const profile of profiles) {
      const status = await native(page, 'accounts', { action: 'status', profileId: profile.id });
      assert.equal(status.find((item) => item.provider === 'claude').state, 'authenticated');
      assert.equal(await fs.readFile(path.join(root, 'storage/claude-profiles', profile.id, 'fixture-authenticated'), 'utf8'), 'fixture-only');
    }
    await page.getByRole('button', { name: 'Go to workspace', exact: true }).click();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click(); await page.locator('.dropdown button').first().click();
    for (const [tileIndex, profileIndex] of [[0, 0], [2, 1]]) {
      const tile = page.locator('.session-tile').nth(tileIndex);
      await tile.getByRole('button', { name: `Engine settings for session ${tileIndex + 1}`, exact: true }).click();
      await tile.getByLabel('Claude account profile', { exact: true }).selectOption(profiles[profileIndex].id);
      await tile.getByRole('button', { name: `Engine settings for session ${tileIndex + 1}`, exact: true }).click();
      await tile.getByRole('button', { name: 'Start session', exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelectorAll('.process-dot.running').length === 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.session-tile')].filter((tile) => tile.querySelector('.process-dot.running')).every((tile) => tile.querySelector('.xterm')?.textContent.includes('READY')));
    for (const index of [0, 2]) {
      const tile = page.locator('.session-tile').nth(index); await tile.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('profile-session-' + index); await page.keyboard.press('Enter');
    }
    await page.waitForFunction(async () => { const usage = await window.codingHub.hub({ action: 'usage' }); return usage.ok && usage.value.length === 2; });
    const history = await native(page, 'listHistory'); assert.equal(history.length, 2);
    assert.deepEqual(history.map((run) => run.config.accountProfileId).sort(), profiles.map((profile) => profile.id).sort());
    const reconnect = await page.evaluate((profileId) => window.codingHub.accounts({ action: 'login', provider: 'claude', profileId, cols: 80, rows: 24 }), profiles[0].id);
    assert.equal(reconnect.ok, false); assert.equal(reconnect.error.code, 'PROFILE_BUSY');
    for (const profile of profiles) {
      const run = history.find((item) => item.config.accountProfileId === profile.id);
      const log = await native(page, 'readRunLog', { runId: run.runId });
      assert.ok(log.text.includes('profile-session-'));
      assert.ok(!log.text.includes('fixture-inherited-key') && !log.text.includes('fixture-inherited-token'));
      const projectLogs = path.join(root, 'storage/claude-profiles', profile.id, 'projects/-fixture');
      assert.deepEqual(await fs.readdir(projectLogs), [run.runId + '.jsonl']);
    }
    for (const index of [0, 2]) await page.locator('.session-tile').nth(index).getByRole('button', { name: 'Stop', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.process-dot.running').length === 0);
    await app.close(); app = null;
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    page = await app.firstWindow(); await page.waitForSelector('.session-tile');
    const saved = await native(page, 'loadWorkspace');
    assert.deepEqual(saved.workspace.sessions.filter((item) => item.config.engine === 'claude').map((item) => item.config.accountProfileId).sort(), profiles.map((profile) => profile.id).sort());
    assert.equal(await page.locator('.account-profile-chip').count(), 2);
    assert.equal((await native(page, 'accounts', { action: 'profile-list' })).length, 2);
    if (process.env.CODING_HUB_PROFILES_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_PROFILES_SCREENSHOT });
    console.log('PASS: independent Claude logins, preserved default account, simultaneous profile sessions, per-profile usage, reconnect guard, private login output, and restored profile assignments. Fixture CLIs; real OAuth requires desktop provider login.');
  } finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
