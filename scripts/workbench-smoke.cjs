const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel, tileControl } = require('./lib/navigate.cjs');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-workbench-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project');
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
  const native = async (page, method, request) => { const result = await page.evaluate(({ method, request }) => window.codingHub[method](request), { method, request }); assert.equal(result.ok, true, result.error?.message); return result.value; };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); let page = await app.firstWindow(); await page.waitForSelector('.session-tile');
    await page.getByRole('button', { name: 'Dismiss workspace setup', exact: true }).click(); assert.equal(await page.locator('.workspace-setup').count(), 0);
    await (await tileControl(page, 'Engine settings for session 1')).click();
    await page.locator('.session-tile').first().getByLabel('Working directory', { exact: true }).selectOption('independent');
    await page.locator('.session-tile').first().getByLabel('Repository path', { exact: true }).fill(project);
    await (await tileControl(page, 'Engine settings for session 1')).click();
    assert.equal(await page.locator('.workspace-setup').count(), 0);
    await page.evaluate(() => localStorage.removeItem('coding-hub-setup-complete'));
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('coding-hub-setup-complete') === 'true');
    assert.equal(await page.locator('.workspace-setup').count(), 0, 'An independent repository also completes project setup');
    await openView(page, 'Design workspace');
    const file = path.join(root, 'preview.html');
    await fs.writeFile(file, '<h1>Design first</h1><style>body{background:#eef2ff;color:#22315a;font:24px sans-serif;padding:40px}</style><script>window.evilRan=true;parent.document.body.dataset.unsafe="yes"</script><img src="https://example.invalid/tracker.png"><a href="https://example.invalid/">Remote link</a>');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.getByLabel('Design title', { exact: true }).fill('Dashboard'); await page.getByLabel('Design version notes', { exact: true }).fill('Initial direction');
    await page.getByRole('button', { name: 'Import preview', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Design first', exact: true }).waitFor();
    const frame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.equal(await frame.evaluate(() => window.evilRan), undefined); assert.equal(await frame.evaluate(() => typeof window.codingHub), 'undefined');
    assert.equal(await page.evaluate(() => document.body.dataset.unsafe), undefined);
    assert.equal(await frame.locator('img').getAttribute('src'), null); assert.equal(await frame.locator('a').getAttribute('href'), null);
    await fs.writeFile(file, '<h1>Design second</h1><style>body{background:#e5fff2;color:#183729;font:24px sans-serif;padding:40px}</style>');
    await page.getByLabel('Design version notes', { exact: true }).fill('Second iteration'); await page.getByRole('button', { name: 'Save next version', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Design second', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Compare versions', exact: true }).click();
    await page.frameLocator('iframe').first().getByRole('heading', { name: 'Design first', exact: true }).waitFor();
    await page.frameLocator('iframe').last().getByRole('heading', { name: 'Design second', exact: true }).waitFor();
    await page.getByLabel('Design preview viewport', { exact: true }).selectOption('390');
    assert.equal(Math.round((await page.locator('iframe').first().boundingBox()).width), 390);
    if (process.env.CODING_HUB_DESIGN_ARCHIVE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_DESIGN_ARCHIVE_SCREENSHOT });
    await page.getByRole('button', { name: 'Show sessions', exact: true }).click(); assert.equal(await page.locator('.design-agents .session-tile').count(), 2);
    const imageFile = path.join(root, 'screenshot.png'); await page.screenshot({ path: imageFile });
    await page.getByRole('button', { name: 'New design', exact: true }).click();
    await page.getByLabel('Design title', { exact: true }).fill('Screenshot');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imageFile);
    await page.getByRole('button', { name: 'Import preview', exact: true }).click();
    await page.getByRole('img', { name: 'Screenshot version 1', exact: true }).waitFor();
    assert.ok(await page.getByRole('img', { name: 'Screenshot version 1', exact: true }).evaluate((image) => image.complete && image.naturalWidth > 0));
    const versions = await native(page, 'designs', { action: 'list' }); assert.equal(versions.length, 3);
    await openView(page, 'AI coaching');
    await page.getByLabel('Prompt wording', { exact: true }).fill('Just fix the component'); await page.getByLabel('Prompt outcome notes', { exact: true }).fill('Needed two retries');
    await page.getByRole('button', { name: 'Save prompt example', exact: true }).click(); await page.getByRole('checkbox', { name: 'Include prompt Just fix the component', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Review coaching report', exact: true }).click();
    assert.equal((await page.getByLabel('Reviewed coaching report', { exact: true }).textContent()).includes('Just fix the component'), false);
    await page.getByRole('checkbox', { name: 'Include prompt Just fix the component', exact: true }).check();
    assert.equal((await page.getByLabel('Reviewed coaching report', { exact: true }).textContent()).includes('Just fix the component'), true);
    assert.equal(await page.getByRole('button', { name: 'Prepare Codex coaching', exact: true }).isDisabled(), true);
    if (process.env.CODING_HUB_COACHING_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_COACHING_SCREENSHOT });
    await page.getByRole('checkbox', { name: 'Approve sharing coaching report through my CLI', exact: true }).check();
    await page.getByRole('button', { name: 'Prepare Codex coaching', exact: true }).click(); await page.locator('.session-tile').nth(2).waitFor();
    assert.equal(await page.locator('.session-tile[data-status="running"]').count(), 0, 'Preparing a report must not launch a provider CLI');
    await page.evaluate(() => { window.events = []; window.codingHub.onSessionEvent((event) => window.events.push(event)); });
    const tile = page.locator('.session-tile').nth(2); await tile.getByRole('button', { name: 'Start session', exact: true }).click();
    // READY can be in scrollback in a short software-rendered tile. Verify the
    // received startup event and the latest rendered size line independently.
    await page.waitForFunction(() => window.events.some((event) => event.type === 'data' && event.data.includes('READY')));
    await page.waitForFunction(() => document.querySelectorAll('.session-tile')[2].querySelector('.xterm').textContent.includes('SIZE:'));
    assert.equal(await page.evaluate(() => window.events.filter((event) => event.type === 'data').some((event) => event.data.includes('ECHO:'))), false, 'Start must not auto-answer trust prompts or send coaching');
    await tile.getByRole('button', { name: 'Send coaching request', exact: true }).click();
    await page.waitForFunction(() => window.events.some((event) => event.type === 'data' && event.data.includes('ECHO:Read COACHING_REPORT.md')));
    // The channel tile: state chip, a scope trace drawn from real output, and a detail row that waits for the header.
    assert.equal(await tile.getByRole('status', { name: 'Channel 3 run', exact: true }).textContent(), '●RUN');
    await page.waitForFunction(() => { const ys = [...document.querySelectorAll('.session-tile')[2].querySelector('.tr-scope-trace').getAttribute('d').matchAll(/ (-?[\d.]+)/g)].map((match) => Number(match[1])); return new Set(ys).size > 1; });
    await page.mouse.move(1, 1);
    const detail = tile.locator('.tr-tile-detail');
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('.session-tile')[2].querySelector('.tr-tile-detail')).opacity === '0');
    await tile.locator('.tr-tile-head').hover({ position: { x: 12, y: 12 } });
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('.session-tile')[2].querySelector('.tr-tile-detail')).opacity === '1');
    assert.match(await detail.textContent(), /pid \d+ · cwd /);
    await page.mouse.move(1, 1);
    // Enter on the tile itself moves into its terminal.
    await tile.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('.session-tile') === document.querySelectorAll('.session-tile')[2]);
    // An approval request shows on the tile until the person answers in the terminal.
    await tile.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('need-approval'); await page.keyboard.press('Enter');
    await tile.locator('.session-attention').getByText('Approval requested: npm test', { exact: true }).waitFor();
    assert.equal(await tile.getByRole('status', { name: 'Channel 3 hold', exact: true }).textContent(), '◆HOLD');
    assert.equal(await tile.getAttribute('data-state'), 'waiting');
    assert.match(await page.locator('.tr-sb-alert').textContent(), /CH3 needs approval/);
    // With another channel isolated, the status-bar alert reveals the waiting channel and focuses its terminal.
    await (await tileControl(page, 'Isolate session 1')).click();
    await page.waitForFunction(() => document.querySelectorAll('.session-tile').length === 1);
    await page.locator('.tr-sb-alert').click();
    await page.locator('.session-tile .session-attention').getByText('Approval requested: npm test', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('.session-tile')?.textContent.includes('Approval requested'));
    await (await tileControl(page, 'Restore grid')).click();
    await page.waitForFunction(() => document.querySelectorAll('.session-tile').length === 3);
    await tile.getByRole('button', { name: 'Answer in terminal', exact: true }).click(); await page.keyboard.type('y'); await page.keyboard.press('Enter');
    await tile.locator('.session-attention').waitFor({ state: 'detached' });
    await tile.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('fail-launch'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.session-tile')[2].querySelector('.session-error')?.textContent.includes('fixture invalid model'));
    // A short tile can push the repeated error into scrollback (the Windows console repaints the main screen
    // first), so scroll back a line at a time until it is in view, as a user would.
    await tile.locator('.xterm-screen').hover();
    for (let attempt = 0; !(await tile.locator('.xterm').textContent()).includes('fixture invalid model'); attempt++) { assert.ok(attempt < 60, 'The CLI error never appeared in the terminal'); if (attempt >= 20) await page.mouse.wheel(0, -20); await page.waitForTimeout(100); }
    await tile.getByRole('button', { name: 'Use Codex CLI defaults', exact: true }).click();
    assert.ok((await tile.textContent()).includes('Model and reasoning overrides cleared'));
    await app.close(); app = null;
    app = await _electron.launch({ executablePath: require('electron'), args, env }); page = await app.firstWindow(); await page.waitForSelector('.session-tile');
    assert.equal(await page.locator('.workspace-setup').count(), 0); assert.equal((await native(page, 'designs', { action: 'list' })).length, 3); assert.equal((await native(page, 'coaching', { action: 'list' })).length, 1);
    console.log('PASS: immutable design comparison and isolated static HTML, preview sizes, coding tiles, curated coaching selection/review/consent, separate idle report session, explicit request delivery, approval requests answered in the terminal, visible alternate-screen Codex failures, default-settings recovery, and persistent setup dismissal. Fixture CLIs; provider outcomes are not measured.');
  } catch (error) {
    // Print what each tile showed, so a CI failure includes the CLI's own output and the app's diagnostic.
    try { for (const window of app ? app.windows() : []) console.error('Visible state at failure:\n' + await window.evaluate(() => [...document.querySelectorAll('.session-tile')].map((tile, index) => `tile ${index}: error=${JSON.stringify(tile.querySelector('.session-error')?.textContent ?? null)} terminal=${JSON.stringify((tile.querySelector('.xterm-rows')?.textContent ?? '').slice(-600))}`).join('\n') + '\nevents=' + JSON.stringify((window.events ?? []).filter((event) => event.type !== 'data' || /Error|fixture/.test(event.data)).slice(-12)))); } catch { /* The window may be gone. */ }
    throw error;
  } finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
