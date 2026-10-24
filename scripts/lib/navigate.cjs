// Opens a view by its name through the Trace top bar: a primary tab, or an item in the Insight or Agent setup menus.
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
  throw new Error(`No navigation entry named ${name}`);
}

/** Adds a channel (session tile) for an engine through + Channel. */
async function addChannel(page, engine = 'Claude Code') {
  await page.getByRole('button', { name: 'New channel', exact: true }).click();
  await page.getByRole('menuitem', { name: engine, exact: true }).click();
}

module.exports = { openView, addChannel };
