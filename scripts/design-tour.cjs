// Screenshots every desktop view in an isolated profile, for checking the design page by page (no agent CLIs start).
// Usage: npm run build && node scripts/design-tour.cjs <outDir>
const { realpath, mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel } = require('./lib/navigate.cjs');

const VIEWS = ['Changes', 'Projects', 'Usage', 'Session history', 'Files', 'More tools', 'AI coaching', 'Tasks', 'Verification profiles',
  'Accounts & connections', 'Shared memory', 'Shared rules', 'MCP servers', 'Skills & plugins', 'Settings', 'Workflow center', 'Help & AI guide'];

(async () => {
  const out = path.resolve(process.argv[2] ?? 'design-tour'); await mkdir(out, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-tour-')));
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  let app;
  const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name); };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.waitForSelector('.tr-empty, .session-tile');
    await shot(page, '00-start');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.cwd()] }); });
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.waitForSelector('.session-tile');
    for (const engine of ['Claude Code', 'Terminal']) await addChannel(page, engine);
    await page.getByRole('button', { name: 'Arrange in grid', exact: true }).click();
    await shot(page, '01-workspace');
    await page.locator('.session-tile').first().click({ position: { x: 200, y: 12 } }).catch(() => {});
    await shot(page, '02-workspace-focused');
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await shot(page, '03-new-channel-menu'); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+P'); await shot(page, '04-command-menu'); await page.keyboard.press('Escape');
    let index = 5;
    for (const view of VIEWS) {
      try { await openView(page, view); await shot(page, `${String(index).padStart(2, '0')}-${view.replace(/[^a-z]+/gi, '-').toLowerCase()}`); }
      catch (error) { console.log('skip', view, error.message.split('\n')[0]); }
      index++;
    }
  } finally {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
