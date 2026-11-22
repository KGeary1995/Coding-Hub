// Opens a view by its name through the Trace top bar: a primary tab, an item in the Insight or Agent setup menus, or a
// tool on the More tools page.
async function openView(page, name) {
  const tab = page.locator('.tr-tabs').getByRole('button', { name, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  if (name === 'Help & AI guide') { await page.getByRole('button', { name: 'Open help', exact: true }).click(); return; }
  for (const menu of ['Insight views', 'Agent setup']) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    const item = page.getByRole('menuitem', { name, exact: true });
    if (await item.count()) { await item.click(); return; }
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Insight views', exact: true }).click();
  await page.getByRole('menuitem', { name: 'More tools', exact: true }).click();
  const tool = page.locator('.more-tools').getByRole('button', { name: `Open ${name}`, exact: true });
  if (await tool.count()) { await tool.click(); return; }
  throw new Error(`No navigation entry named ${name}`);
}

/** Adds a channel (session tile) for an engine through + Channel. */
async function addChannel(page, engine = 'Claude Code') {
  await page.getByRole('button', { name: 'New channel', exact: true }).click();
  await page.getByRole('menuitem', { name: engine, exact: true }).click();
}

/**
 * Starts a Round Table through + Channel: the menu item opens the setup panel (seats, models, presets) with that kind's
 * table chosen, and Start Round Table starts it as it is. `setup`: changes made in the panel first.
 */
async function startTable(page, item = 'Round Table', setup) {
  await page.getByRole('button', { name: 'New channel', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  const panel = page.locator('dialog.table-setup'); await panel.waitFor();
  if (setup) await setup(panel);
  await panel.getByRole('button', { name: 'Start Round Table', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
}

/**
 * A control in a channel's detail row, which shows when the person points at the tile's header, or while a control in it
 * has the keyboard focus. The test's own pointer is not enough: the window is on the real screen, and the real pointer
 * moving over it (the person at the computer) took the header's hover away before the click, which then waited 20 s on a
 * hidden row ("terminal-frame intercepts pointer events"). The focus keeps the row shown whatever the pointer does.
 */
async function tileControl(scope, name) {
  const button = scope.getByRole('button', { name, exact: true });
  await button.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " tr-tile-top ")]').hover({ position: { x: 12, y: 12 } });
  await button.focus();
  return button;
}

module.exports = { openView, addChannel, startTable, tileControl };
