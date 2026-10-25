// Validate the production layout in an isolated profile without starting agent CLIs.
const assert = require('node:assert/strict');
const { realpath, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel } = require('./lib/navigate.cjs');
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
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.cwd()] }); });
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await addChannel(page, 'Claude Code');
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
        return { overflow: document.body.scrollWidth > innerWidth + 1, footer: footer.bottom, height: innerHeight, canvas: canvas.height, tiles: [...document.querySelectorAll('.session-tile')].map((tile) => ({ width: tile.clientWidth, height: tile.clientHeight, share: tile.getBoundingClientRect().height / canvas.height })), gridBottom: Math.max(...[...document.querySelectorAll('.session-tile')].map((tile) => tile.getBoundingClientRect().bottom)), canvasBottom: canvas.bottom };
      });
      assert.equal(bounds.overflow, false, `horizontal overflow at ${width}px / ${scale}%`);
      assert.ok(bounds.footer <= bounds.height + 1, `status bar below viewport at ${scale}%`);
      assert.ok(bounds.canvas > 200);
      assert.equal(bounds.tiles.length, 4);
      // The 2 × 2 grid fills the canvas without scrolling: each row takes about half of it. At 1100 × 800 / 125% a
      // tile is about 266 px under xvfb and 254 px on Windows, whose window frame takes part of the 800 px.
      assert.ok(bounds.gridBottom <= bounds.canvasBottom + 1, `grid overflows the canvas at ${width}px / ${scale}%`);
      assert.ok(bounds.tiles.every((tile) => tile.width > 200 && tile.height >= 220 && tile.share >= 0.45), `tiles at ${width}px / ${scale}%: ${JSON.stringify(bounds.tiles)}`);
      if (process.env.CODING_HUB_DESIGN_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CODING_HUB_DESIGN_SCREENSHOTS, `hub-${width}-${scale}.png`) });
    }
    await page.getByRole('button', { name: 'Show explorer', exact: true }).click();
    await page.waitForSelector('.workspace-explorer');
    await page.getByRole('button', { name: 'Hide explorer', exact: true }).click();
    assert.equal(await page.locator('.workspace-explorer').count(), 0);
    // G then a letter opens a view; keys typed into fields are left alone.
    await page.evaluate(() => (document.activeElement)?.blur());
    await page.keyboard.press('g'); await page.keyboard.press('u');
    await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
    await page.keyboard.press('g'); await page.keyboard.press('w');
    await page.locator('.session-tile').first().waitFor();
    // Occasional tools live on More tools, not in the Insight menu, and each one leads back there.
    await page.getByRole('button', { name: 'Insight views', exact: true }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Usage', 'Session history', 'Files', 'More tools']);
    await page.getByRole('menuitem', { name: 'More tools', exact: true }).click();
    assert.deepEqual(await page.locator('.more-tools h2').allTextContents(), ['Design workspace', 'AI coaching', 'Task coordination', 'Verification profiles']);
    await page.getByRole('button', { name: 'Open Task coordination', exact: true }).click();
    await page.getByRole('heading', { name: 'Task coordination', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Insight views', exact: true }).textContent(), 'More tools▾');
    await page.getByRole('button', { name: 'More tools', exact: true }).click();
    await page.getByRole('heading', { name: 'More tools', exact: true }).waitFor();
    await page.keyboard.press('g'); await page.keyboard.press('w');
    await page.locator('.session-tile').first().waitFor();
    console.log('PASS: four-session workbench, responsive canvas, 125% zoom, visible status bar, explorer toggle, G-letter view shortcuts, and the More tools page.');
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
