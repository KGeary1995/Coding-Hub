// Validate the production layout in an isolated profile without starting agent CLIs.
const assert = require('node:assert/strict');
const { realpath, mkdtemp } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-design-')));
  const env = { ...process.env, ...NO_DRIVE, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') };
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
      // Three channels in the grid: two above, and the third across the whole second row (no empty quarter).
      if (i === 0) await page.waitForFunction(() => { const [a, b, c] = [...document.querySelectorAll('.session-tile')].map((tile) => tile.getBoundingClientRect()); return c && Math.abs(a.top - b.top) < 2 && c.top >= a.bottom && Math.abs(c.left - a.left) < 2 && Math.abs(c.right - b.right) < 2; });
    }
    // xterm stacks its own layers over the terminal (the WebGL renderer's link layer is a canvas at z-index 2). None may
    // lie over an idle channel's start area and take its clicks: a layer like it is added here, so this holds without WebGL.
    await page.waitForFunction(() => [...document.querySelectorAll('.session-tile')].every((tile) => tile.querySelector('.xterm-screen') && tile.querySelector('.session-welcome .button.primary')));
    const covered = await page.evaluate(() => [...document.querySelectorAll('.session-tile')].filter((tile) => {
      const layer = document.createElement('canvas'); layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:2'; tile.querySelector('.xterm-screen').append(layer);
      const button = tile.querySelector('.session-welcome .button.primary'); const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); layer.remove();
      return !button.contains(hit);
    }).length);
    assert.equal(covered, 0, 'The Start button in the middle of an idle channel stays on top of the terminal\'s own layers');
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
      // All three engines' plan limits in the bar, as StatusBar draws them (no CLI answers here, so they are put in, and
      // any real ones set aside meanwhile): each chip is drawn and none reaches past the bar's end, at every size.
      const plans = await page.evaluate(() => {
        const footer = document.querySelector('.app-statusbar'); const real = [...footer.querySelectorAll('.tr-sb-plan')]; for (const chip of real) chip.style.display = 'none';
        const chip = (engine, name) => `<button class="tr-sb-cell tr-sb-plan" data-smoke><svg class="tr-sb-engine tr-state ${engine}" width="12" height="12"></svg><span class="tr-sb-plan-name">${name}</span><span class="tr-sb-window ok"><small>5h</small><i class="tr-sb-meter ui-meter ${engine}"><i style="width:42%"></i></i> 42%</span><span class="tr-sb-window critical worst"><small>wk</small><i class="tr-sb-meter ui-meter danger"><i style="width:100%"></i></i> 100%</span></button>`;
        footer.querySelector('.tr-sb-today').insertAdjacentHTML('afterend', chip('claude', 'Claude') + chip('codex', 'Codex') + chip('gemini', 'Gemini'));
        // The widest a chip gets: a named account in use near its cap after the default login's limits, and the mark of a
        // failed check (StatusBar draws both inside the chip, after its limits).
        const widest = footer.querySelector('.tr-sb-plan[data-smoke]'); widest.classList.add('stale'); widest.insertAdjacentHTML('beforeend', '<span class="tr-sb-account critical">Work 92%</span><svg class="tr-sb-stale" width="12" height="12"></svg>');
        const end = footer.getBoundingClientRect().right; const chips = [...footer.querySelectorAll('.tr-sb-plan[data-smoke]')].map((node) => { const { right, width } = node.getBoundingClientRect(); return { right, width, label: node.querySelector('.tr-sb-window.worst small').getBoundingClientRect().width, text: node.innerText.replace(/\s+/g, ' ').trim() }; });
        const past = [...footer.children].filter((item) => { const box = item.getBoundingClientRect(); return box.width > 1 && box.right > end + 1; }).map((item) => item.className);
        footer.querySelectorAll('[data-smoke]').forEach((node) => node.remove()); for (const chip of real) chip.style.display = '';
        return { end, chips, past };
      });
      assert.equal(plans.chips.length, 3);
      assert.ok(plans.chips.every((chip) => chip.width > 1 && chip.right <= plans.end + 1) && plans.past.length === 0, `three plan chips at ${width}px / ${scale}%: ${JSON.stringify(plans)}`);
      // However far a chip collapses, the limit it keeps is named ("wk"), not a bare percentage.
      assert.ok(plans.chips.every((chip) => chip.label > 1), `a plan chip's fullest limit has lost its name at ${width}px / ${scale}%: ${JSON.stringify(plans.chips)}`);
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
    // AI coaching and Verification are in the Insight menu itself (1.31.5; before, on a More tools page), and the menu
    // names the view it is on.
    await page.getByRole('button', { name: 'Insight views', exact: true }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Usage', 'Session history', 'Files', 'Search', 'AI coaching', 'Verification profiles']);
    await page.getByRole('menuitem', { name: 'Verification profiles', exact: true }).click();
    await page.getByRole('heading', { name: 'Verification profiles', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Insight views', exact: true }).textContent(), 'Verification profiles▾');
    // A "?" opens its words as a note, from the keyboard too, and Escape closes it (1.31.5; it was a tooltip only).
    const help = page.getByRole('button', { name: 'Help: verification profiles', exact: true }); await help.focus(); await page.keyboard.press('Enter');
    await page.getByRole('note').filter({ hasText: 'a confirmation shows its exact commands' }).waitFor(); assert.equal(await help.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); await page.getByRole('note').filter({ hasText: 'a confirmation shows its exact commands' }).waitFor({ state: 'detached' });
    // Settings says when the form holds changes not saved yet, and Discard puts them back (1.31.5).
    await openView(page, 'Settings'); const font = page.getByLabel('Terminal font size', { exact: true }); const fontBefore = await font.inputValue();
    assert.equal(await page.getByText('Unsaved changes', { exact: true }).count(), 0); await font.fill(String(Number(fontBefore) + 1));
    await page.getByText('Unsaved changes', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'detached' }); assert.equal(await font.inputValue(), fontBefore);
    // Higher contrast keeps a focused field's accent border and an error's colour, and compact density leaves the cards
    // drawn edge to edge without padding (1.31.1: a rule for each outweighed them).
    // Search loads when first opened: the field is waited for before it is measured (a slower machine had none yet).
    await openView(page, 'Search'); const field = page.getByLabel('Workspace search query', { exact: true }); await field.waitFor();
    const looks = await page.evaluate(async () => {
      const root = document.documentElement; const before = { contrast: root.dataset.contrast, density: root.dataset.density }; root.dataset.contrast = 'high'; root.dataset.density = 'compact';
      const input = document.querySelector('[aria-label="Workspace search query"]'); input.focus(); await new Promise((resolve) => setTimeout(resolve, 500)); // after the border's fade
      const probe = document.createElement('i'); probe.style.color = 'var(--tr-accent)'; document.body.append(probe); const accent = getComputedStyle(probe).color;
      probe.style.color = 'var(--tr-danger)'; const danger = getComputedStyle(probe).color; probe.className = 'ui-hint error-message'; probe.style.color = ''; const hint = getComputedStyle(probe).color; probe.remove();
      const card = document.createElement('div'); card.className = 'repository-workbench ui-card'; document.body.append(card); const padding = getComputedStyle(card).paddingTop; card.remove();
      const focused = getComputedStyle(input).borderTopColor; input.blur(); root.dataset.contrast = before.contrast ?? 'normal'; root.dataset.density = before.density ?? 'comfortable';
      return { accent, focused, danger, hint, padding };
    });
    assert.equal(looks.focused, looks.accent, `a focused field's border in higher contrast: ${JSON.stringify(looks)}`);
    assert.equal(looks.hint, looks.danger, `an error hint's colour in higher contrast: ${JSON.stringify(looks)}`);
    assert.equal(looks.padding, '0px', 'the Changes card has no padding in compact density');
    await field.waitFor();
    await page.keyboard.press('g'); await page.keyboard.press('w');
    await page.locator('.session-tile').first().waitFor();
    // Today's total is a chip that opens Usage, by the keyboard as by the pointer, with its focus ring inside its own edge
    // (the box it leaves a short bar in clips, and outside it the ring was cut off).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; document.documentElement.style.setProperty('--display-scale', '1'); });
    await page.waitForTimeout(350);
    const todayChip = page.locator('.tr-sb-today-button');
    assert.equal(await todayChip.evaluate((chip) => chip.tagName + ' ' + chip.tabIndex + ' ' + chip.closest('.tr-sb-today').classList.contains('gone')), 'BUTTON 0 false');
    await todayChip.focus(); assert.equal(await todayChip.evaluate((chip) => getComputedStyle(chip).outlineOffset), '-2px');
    for (const key of ['Enter', 'Space']) {
      await todayChip.focus(); await page.keyboard.press(key); await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
      await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('g'); await page.keyboard.press('w'); await page.locator('.session-tile').first().waitFor();
    }
    await todayChip.click(); await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('g'); await page.keyboard.press('w'); await page.locator('.session-tile').first().waitFor();
    // Eight channels, the most there are, in the narrowest windows: nothing in the status bar may reach past its end,
    // where Needs you and the alert stand, and each tile keeps its name, its state and its controls button in view.
    for (let i = 0; i < 4; i++) await addChannel(page, 'Claude Code');
    await page.waitForFunction(() => document.querySelectorAll('.session-tile').length === 8);
    for (const [width, height, scale] of [[900, 700, 100], [1100, 800, 125]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await page.evaluate((value) => { document.documentElement.style.zoom = String(value / 100); document.documentElement.style.setProperty('--display-scale', String(value / 100)); }, scale);
      await page.getByRole('button', { name: 'Arrange in grid', exact: true }).click();
      await page.waitForTimeout(350);
      const bar = await page.evaluate(() => {
        const footer = document.querySelector('.app-statusbar'); const end = footer.getBoundingClientRect().right;
        const drawn = (node) => { const box = node.getBoundingClientRect(); return box.width > 1 && box.height > 1; };
        return { channels: footer.querySelectorAll('.tr-sb-channel').length, past: [...footer.children].filter((item) => drawn(item) && item.getBoundingClientRect().right > end + 1).map((item) => item.className),
          hidden: [...document.querySelectorAll('.session-tile')].filter((tile) => { const edge = tile.getBoundingClientRect(); return [...tile.querySelectorAll('.tr-tile-name, .tr-state-chip, .tr-tile-more')].some((part) => { const box = part.getBoundingClientRect(); return !drawn(part) || box.right > edge.right + 1 || box.left < edge.left - 1; }); }).map((tile) => `${Math.round(tile.getBoundingClientRect().width)} px: ` + [...tile.querySelectorAll('.tr-tile-name, .tr-state-chip, .tr-tile-more')].map((part) => `${part.className.split(' ')[0]} ${Math.round(part.getBoundingClientRect().width)}`).join(', ')) };
      });
      // The same with everything that asks for the person in the bar at once. No channel runs here, so their parts are
      // put in as StatusBar draws them (the layout is the stylesheet's): Needs you and a storage failure
      // in place of the saved state. Each must be drawn, inside the bar, and clear of the one before it.
      const asking = await page.evaluate(() => {
        const footer = document.querySelector('.app-statusbar'); const saved = footer.querySelector('.storage-status'); const before = { name: saved.className, html: saved.innerHTML };
        saved.className = 'tr-sb-cell storage-status tr-sb-drop error'; saved.innerHTML = '<span class="tr-sb-inner"><svg width="12" height="12"></svg><span class="tr-sb-error-words">Storage needs attention</span></span>';
        footer.insertAdjacentHTML('beforeend', '<div class="needs-you" data-smoke><button class="tr-sb-cell needs-you-cell">Needs you<span class="needs-you-sep"> · </span><span class="ui-count waiting">2</span></button></div>');
        const end = footer.getBoundingClientRect(); const box = (selector) => { const { left, right, width, height } = footer.querySelector(selector).getBoundingClientRect(); return { left, right, width, height }; };
        const parts = { failure: box('.storage-status.error svg'), needs: box('.needs-you-cell'), lastChannel: box('.tr-sb-channel:nth-child(8)') };
        footer.querySelectorAll('[data-smoke]').forEach((node) => node.remove()); saved.className = before.name; saved.innerHTML = before.html;
        return { left: end.left, right: end.right, parts };
      });
      for (const [name, part] of Object.entries(asking.parts)) assert.ok(part.width > 1 && part.height > 1 && part.left >= asking.left - 1 && part.right <= asking.right + 1, `${name} is not in view in the status bar with eight channels at ${width}px / ${scale}%: ${JSON.stringify(asking)}`);
      assert.ok(asking.parts.lastChannel.right <= asking.parts.failure.left + 1 && asking.parts.failure.right <= asking.parts.needs.left + 1, `status bar items overlap with eight channels at ${width}px / ${scale}%: ${JSON.stringify(asking)}`);
      // Where the Today chip has left the bar it is out of the tab order too, and where it shows it is whole and in it.
      const today = await page.evaluate(() => { const chip = document.querySelector('.tr-sb-today-button'); const box = chip.closest('.tr-sb-today'); const a = chip.getBoundingClientRect(); const b = box.getBoundingClientRect(); return { gone: box.classList.contains('gone'), tab: chip.tabIndex, hidden: chip.getAttribute('aria-hidden'), drawn: a.top - b.top < b.height / 2 && a.width > 1 && a.right <= b.right + 1 }; });
      assert.ok(today.gone ? today.tab === -1 && today.hidden === 'true' && !today.drawn : today.tab === 0 && today.hidden === null && today.drawn, `the Today chip with eight channels at ${width}px / ${scale}%: ${JSON.stringify(today)}`);
      assert.equal(bar.channels, 8);
      assert.deepEqual(bar.past, [], `status bar items past its end with eight channels at ${width}px / ${scale}%`);
      assert.deepEqual(bar.hidden, [], `tiles whose name, state or controls button is out of view with eight channels at ${width}px / ${scale}%`);
    }
    console.log('PASS: four-channel workbench, responsive canvas, 125% zoom, visible status bar, explorer toggle, G-letter view shortcuts, AI coaching and Verification in the Insight menu, and eight channels in the narrowest windows.');
  } finally {
    await app?.close().catch(() => {});
    await removeFolder(root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
