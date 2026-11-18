// Screenshots every desktop view in an isolated profile, for checking the design page by page (no agent CLIs start).
// Usage: npm run build && node scripts/design-tour.cjs <outDir> [--dev] [--only=usage,settings] [--size=1440x900] [--visible]
//   --dev      load the window from a running Vite server (npx vite --host 127.0.0.1, with CODING_HUB_NO_HMR=1 so an
//              edit elsewhere does not reload the page mid-tour) instead of dist/, so no build is needed between edits
//   --only     take only the shots whose name contains one of these words
//   --visible  leave the window on screen; by default it is moved off screen so it does not cover the person's work
const { realpath, mkdtemp, mkdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');

const VIEWS = ['Changes', 'Projects', 'Usage', 'Session history', 'Files', 'More tools', 'AI coaching', 'Tasks', 'Verification profiles',
  'Accounts & connections', 'Shared memory', 'Shared rules', 'MCP servers', 'Skills & plugins', 'Settings', 'Workflow center', 'Help & AI guide'];

const flags = process.argv.slice(3);
const flag = (name) => flags.find((value) => value === `--${name}` || value.startsWith(`--${name}=`))?.split('=')[1] ?? (flags.includes(`--${name}`) ? '' : undefined);
const only = flag('only')?.split(',').map((word) => word.trim().toLowerCase()).filter(Boolean) ?? [];
const [width, height] = (flag('size') ?? '1440x900').split('x').map(Number);

(async () => {
  const out = path.resolve(process.argv[2] ?? 'design-tour'); await mkdir(out, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-tour-')));
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), ...(flag('dev') === undefined ? ['--production'] : [])];
  let app;
  const wanted = (name) => !only.length || only.some((word) => name.toLowerCase().includes(word));
  const shot = async (page, name) => { if (!wanted(name)) return; await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name); };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h, hide]) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(w, h); if (hide) window.setPosition(-30000, 0); }, [width, height, flag('visible') === undefined]);
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
      const name = `${String(index).padStart(2, '0')}-${view.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
      try { if (wanted(name)) { await openView(page, view); await shot(page, name); } }
      catch (error) { console.log('skip', view, error.message.split('\n')[0]); }
      index++;
    }
  } finally {
    await app?.close().catch(() => {});
    await removeFolder(root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
