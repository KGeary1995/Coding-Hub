// Validate the production layout in an isolated profile without starting agent CLIs.
const assert = require('node:assert/strict');
const { realpath, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-design-')));
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const page = await app.firstWindow();
    await page.waitForSelector('.session-tile');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.cwd()] }); });
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await page.locator('.dropdown button').first().click();
    }
    for (const [width, height, scale] of [[1440, 960, 100], [1100, 800, 100], [900, 700, 100], [1100, 800, 125]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value / 100);
        document.documentElement.style.setProperty('--display-scale', String(value / 100));
      }, scale);
      await page.getByRole('button', { name: 'Arrange in grid', exact: true }).click();
      await page.waitForTimeout(350); // ResizeObserver and grid transitions settle.
      const bounds = await page.evaluate(() => {
        const canvas = document.querySelector('.workspace-canvas').getBoundingClientRect();
        const footer = document.querySelector('.app-statusbar').getBoundingClientRect();
        return { overflow: document.body.scrollWidth > innerWidth + 1, footer: footer.bottom, height: innerHeight, canvas: canvas.height, tiles: [...document.querySelectorAll('.session-tile')].map((tile) => ({ width: tile.clientWidth, height: tile.clientHeight })) };
      });
      assert.equal(bounds.overflow, false, `horizontal overflow at ${width}px / ${scale}%`);
      assert.ok(bounds.footer <= bounds.height + 1, `status bar below viewport at ${scale}%`);
      assert.ok(bounds.canvas > 200);
      assert.equal(bounds.tiles.length, 4);
      assert.ok(bounds.tiles.every((tile) => tile.width > 200 && tile.height >= 290));
      if (process.env.CODING_HUB_DESIGN_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CODING_HUB_DESIGN_SCREENSHOTS, `hub-${width}-${scale}.png`) });
    }
    await page.getByRole('button', { name: 'Show explorer', exact: true }).click();
    await page.waitForSelector('.workspace-explorer');
    await page.getByRole('button', { name: 'Hide explorer', exact: true }).click();
    assert.equal(await page.locator('.workspace-explorer').count(), 0);
    console.log('PASS: four-session workbench, responsive canvas, 125% zoom, visible status bar, and explorer toggle.');
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
