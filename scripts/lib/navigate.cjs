// Opens a view by its name through the Trace top bar: a primary tab, or an item in the Insight or Agent setup menus.
/** Settings → Show advanced tools (simple mode, 1.38.0): the smokes test the views and settings it hides. */
async function showAdvanced(page) {
  await openView(page, 'Settings', false);
  const box = page.getByLabel('Show advanced tools', { exact: true });
  if (!await box.isChecked()) { await box.check(); await page.waitForFunction(() => document.querySelector('[aria-label="Show advanced tools"]')?.checked === true); }
  await page.locator('#settings-hooks-title').waitFor();
}
async function openView(page, name, advanced = true) {
  const tab = page.locator('.tr-tabs').getByRole('button', { name, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  if (name === 'Help & AI guide') { await page.getByRole('button', { name: 'Open help', exact: true }).click(); return; }
  // Settings shows its advanced parts only with the switch on: a smoke opening it means to test them.
  for (const menu of ['Insight views', 'Agent setup']) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    const item = page.getByRole('menuitem', { name, exact: true });
    if (await item.count()) { await item.click(); if (name === 'Settings' && advanced) await showAdvanced(page); return; }
    await page.keyboard.press('Escape');
  }
  // A view simple mode leaves out of the menus: shown once advanced tools are on.
  if (advanced) { await showAdvanced(page); return openView(page, name, false); }
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
 * A control in a channel's controls row, which the tile's controls button (the ellipsis in its header) opens and closes;
 * the row also stands open while the channel's settings, its conversation or its close question is. The row is opened
 * here when it is closed, so the control can be pressed. A closed row is not drawn, so the control is looked for among
 * the hidden too.
 */
async function tileControl(scope, name) {
  const button = scope.getByRole('button', { name, exact: true, includeHidden: true });
  await button.waitFor({ state: 'attached' });
  if (!await button.isVisible()) await button.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " tr-tile-top ")]').locator('.tr-tile-more').click();
  await button.waitFor();
  return button;
}

/**
 * Sets a Codex channel's model in its engine settings (open on `tile`). Once Codex has listed its models the field is a
 * list chosen by name, with "Another model…" for an exact ID; until then it is the ID field alone.
 */
async function setCodexModel(tile, model) {
  await tile.locator('.ui-hint').filter({ hasText: 'Loading models from your local Codex CLI' }).waitFor({ state: 'detached' });
  const field = tile.getByLabel('codex model', { exact: true });
  if (await field.evaluate((element) => element.tagName !== 'SELECT')) { await field.fill(model); return; }
  if (await field.locator(`option[value="${model}"]`).count()) { await field.selectOption(model); return; }
  await field.selectOption('other'); await tile.getByLabel('codex model ID', { exact: true }).fill(model);
}
module.exports = { setCodexModel, openView, showAdvanced, addChannel, startTable, tileControl };
