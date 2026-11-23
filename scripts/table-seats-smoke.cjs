// Round Table seats end to end, against stand-in CLIs (scripts/fixtures/table-seats-cli.cjs) that log what they receive:
// the setup panel (seats, names, instructions, who edits), changing the seats of an open table, saved tables ("Yours"), a
// hierarchy with a second reviewer and no final review, and the table seated again after a restart on the same profile.
// Set TABLE_SMOKE_SHOTS to a folder to keep a screenshot of each stage.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { startTable, tileControl } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'table-seats-cli.cjs');
const SHOTS = process.env.TABLE_SMOKE_SHOTS;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-tables-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project'); const logFile = path.join(root, 'received.log');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder))); await fs.writeFile(logFile, ''); if (SHOTS) await fs.mkdir(SHOTS, { recursive: true });
  for (const engine of ['claude', 'codex']) {
    const wrapper = `process.env.TABLE_SMOKE_ENGINE = ${JSON.stringify(engine)}; require(${JSON.stringify(FIXTURE)});`;
    if (process.platform === 'win32') {
      const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), wrapper); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + wrapper, { mode: 0o755 });
  }
  const env = { ...process.env, ...NO_DRIVE, TABLE_SMOKE_LOG: logFile, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');

  const errors = []; let app; let page;
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.stack ?? String(error)));
    await page.waitForSelector('.tr-empty, .session-tile');
  };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const received = async () => (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const until = async (check, message, timeout = 30000) => { const end = Date.now() + timeout; let last; while (Date.now() < end) { last = await check(); if (last) return last; await sleep(150); } throw new Error('Timed out: ' + message); };
  const sendTo = async (scope, text) => {
    const box = scope.getByRole('textbox', { name: 'Message to the Round Table', exact: true });
    await until(() => box.isEnabled(), 'the message box is enabled', 90000); await box.fill(text); await box.press('Enter');
  };
  const discussionTile = () => page.locator('.session-tile').filter({ has: page.locator('.table-bar:not(.chain-bar)') });
  const hierarchyTile = () => page.locator('.session-tile').filter({ has: page.locator('.chain-bar') });
  const roles = (tile) => tile.locator('.table-bar:not(.chain-bar) .table-roles');
  const idle = (tile) => tile.locator('.table-bar:not(.chain-bar) .table-status').filter({ hasText: 'Your turn' }).waitFor({ timeout: 60000 });
  const openSeats = async (tile) => { const button = tile.locator('.table-bar:not(.chain-bar)').getByRole('button', { name: 'Seats', exact: true }); await until(() => button.isEnabled(), 'Seats can be pressed', 30000); await button.click(); const panel = page.locator('dialog.table-setup'); await panel.waitFor(); return panel; };
  const apply = async (panel) => { await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await panel.waitFor({ state: 'detached', timeout: 60000 }); };
  const seatNamed = async (name) => (await received()).find((entry) => entry.type === 'recv' && entry.text.includes(`The others call you ${name}.`));

  try {
    await launch();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    const firstTiles = await page.locator('.session-tile').count();

    // 1. A discussion with three seats: Claude Code, Codex and a second Codex named Tests, with instructions of its own.
    const INSTRUCTIONS = 'Only look at the unit tests and say what is missing.';
    await startTable(page, 'Round Table', async (panel) => {
      assert.equal(await panel.getByRole('heading', { name: 'New Round Table' }).count(), 1);
      await panel.getByRole('button', { name: 'Add seat', exact: true }).click();
      await panel.getByLabel('Seat 3 agent', { exact: true }).selectOption('codex'); await panel.getByLabel('Seat 3 name', { exact: true }).fill('Tests'); await panel.getByLabel('Seat 3 instructions', { exact: true }).fill(INSTRUCTIONS);
      assert.equal(await panel.getByRole('list', { name: 'Seats' }).getByRole('listitem').count(), 3);
      await shot('1-setup-three-seats');
    });
    const tile = discussionTile(); await tile.waitFor({ timeout: 90000 });
    await roles(tile).filter({ hasText: 'Tests' }).waitFor({ timeout: 90000 });
    assert.equal((await roles(tile).textContent()).trim(), 'Claude Code drives · Codex and Tests review');
    assert.equal(await page.locator('.session-tile').count(), firstTiles + 1, 'the hidden seats have no tile of their own');
    // Three agents are running: one Claude chat and two Codex app servers.
    // (Codex's app server is also started, with no thread, to list models and plan limits: those are not seats.)
    const seated = async () => (await received()).filter((entry) => entry.type === 'thread' || (entry.type === 'start' && entry.mode === 'chat'));
    await until(async () => (await seated()).length >= 3, 'three agents started'); assert.deepEqual((await seated()).map((entry) => entry.engine).sort(), ['claude', 'codex', 'codex'], 'three agents started');
    await sendTo(tile, 'Hello table');
    for (const name of ['Claude Code', 'Codex', 'Tests']) {
      await tile.locator('.chat-message.assistant').filter({ has: page.locator('.chat-author', { hasText: name }) }).filter({ hasText: `Answer from ${name}.` }).first().waitFor({ timeout: 60000 });
    }
    await idle(tile);
    const authors = (await tile.locator('.chat-message.assistant .chat-author').allTextContents()).map((text) => text.trim());
    for (const name of ['Claude Code', 'Codex', 'Tests']) assert.ok(authors.some((author) => author.startsWith(name)), `an answer labelled ${name}: ${JSON.stringify(authors)}`);
    const tests = await seatNamed('Tests'); assert.ok(tests, 'the Tests seat was briefed');
    const testsFirst = (await received()).find((entry) => entry.pid === tests.pid && entry.type === 'recv');
    assert.deepEqual(testsFirst, tests, 'the brief with the instructions is the Tests seat\'s first prompt'); assert.equal(tests.engine, 'codex');
    assert.ok(tests.text.includes("[The person's own instructions for you at this table]\n" + INSTRUCTIONS) && tests.text.includes('Hello table'), 'the Tests seat received its instructions with the first prompt');
    for (const entry of (await received()).filter((item) => item.type === 'recv' && item.pid !== tests.pid)) assert.ok(!entry.text.includes(INSTRUCTIONS), 'another seat was sent the Tests instructions');
    await shot('2-three-seat-thread');
    // The two starting channels are closed (each time the first one: the rest are renumbered), to leave room for the hierarchy
    // below: Trace runs at most eight agents and terminals, and this table (3 now) and that one (4) use seven of them.
    for (let closed = 0; closed < firstTiles; closed++) {
      const first = page.locator('.session-tile').filter({ has: page.locator('[aria-label="Close channel 1"]') }); await (await tileControl(first, 'Close channel 1')).click();
      await until(async () => (await page.locator('.session-tile').count()) === firstTiles + 1 - (closed + 1), `starting channel ${closed + 1} is closed`);
    }
    const base = 1;

    // 2. Who edits: with three seats the bar has a select; choosing Tests says so.
    const driver = tile.locator('.table-bar:not(.chain-bar)').locator('select[aria-label="Agent that edits files"]');
    assert.deepEqual(await driver.locator('option').allTextContents(), ['Claude Code', 'Codex', 'Tests']);
    await driver.selectOption({ label: 'Tests' });
    await roles(tile).filter({ hasText: 'Tests drives' }).waitFor();
    assert.equal((await roles(tile).textContent()).trim(), 'Tests drives · Claude Code and Codex review');

    // 3. Seats: rename one seat, then take the third away.
    let panel = await openSeats(tile);
    assert.equal(await panel.getByRole('heading', { name: 'Seats at this Round Table' }).count(), 1);
    assert.equal(await panel.getByLabel('Seat 3 name', { exact: true }).inputValue(), 'Tests');
    assert.equal(await panel.getByLabel('Seat 3 instructions', { exact: true }).inputValue(), INSTRUCTIONS, 'the edit panel shows the saved instructions');
    await panel.getByLabel('Seat 2 name', { exact: true }).fill('Codex Reviewer'); await shot('3-edit-seats');
    await apply(panel);
    await roles(tile).filter({ hasText: 'Codex Reviewer' }).waitFor();
    assert.equal((await roles(tile).textContent()).trim(), 'Tests drives · Claude Code and Codex Reviewer review');
    const testsPid = tests.pid; assert.ok(alive(testsPid), 'the Tests seat runs before it is removed');
    panel = await openSeats(tile); await panel.getByRole('button', { name: 'Remove Seat 3', exact: true }).click(); await apply(panel);
    await until(() => !alive(testsPid), 'the removed seat\'s process stopped', 20000);
    await until(async () => (await roles(tile).textContent()).trim() === 'Claude Code drives · Codex Reviewer reviews', 'two seats remain, Claude Code editing', 20000);
    assert.equal(await tile.locator('.table-bar:not(.chain-bar) select[aria-label="Agent that edits files"]').count(), 0, 'two seats have no "Edits files" select');
    assert.equal(await page.locator('.session-tile').count(), base, 'no channel tile is left behind by the removed seat');
    // The removed seat is also gone from the saved workspace (no leftover channel).
    await until(async () => (await page.evaluate(async () => (await window.codingHub.loadWorkspace()).value.workspace.sessions.length)) === 2, `the saved workspace holds the lead and its one remaining seat only`, 15000).catch(async (error) => { throw new Error(error.message + ' ' + JSON.stringify(await page.evaluate(async () => (await window.codingHub.loadWorkspace()).value.workspace.sessions.map((item) => ({ id: item.id.slice(0, 6), engine: item.config.engine, chat: item.config.chat, table: item.roundTable ? item.roundTable.seats?.map((seat) => seat.session.slice(0, 6)) : undefined }))))); });
    // Seat a third again (Codex, Tests): a new seat on an open table.
    panel = await openSeats(tile); await panel.getByRole('button', { name: 'Add seat', exact: true }).click();
    await panel.getByLabel('Seat 3 agent', { exact: true }).selectOption('codex'); await panel.getByLabel('Seat 3 name', { exact: true }).fill('Tests'); await apply(panel);
    await roles(tile).filter({ hasText: 'Tests' }).waitFor(); assert.match((await roles(tile).textContent()).trim(), /^Claude Code drives · Codex Reviewer and Tests review$/);

    // 4. Save as preset: a three-seat table kept as "Smoke trio", offered under "Yours", then deleted.
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Round Table', exact: true }).click();
    panel = page.locator('dialog.table-setup'); await panel.waitFor();
    assert.equal(await panel.locator('optgroup[label="Yours"]').count(), 0, 'no saved table yet');
    await panel.getByRole('button', { name: 'Add seat', exact: true }).click(); await panel.getByLabel('Name for a saved table', { exact: true }).fill('Smoke trio');
    await panel.getByRole('button', { name: 'Save as preset', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Saved as one of your tables.' }).waitFor();
    await panel.getByRole('button', { name: 'Close', exact: true }).click(); await panel.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Round Table', exact: true }).click();
    panel = page.locator('dialog.table-setup'); await panel.waitFor();
    assert.deepEqual(await panel.locator('optgroup[label="Yours"] option').allTextContents(), ['Smoke trio · discussion'], 'the saved table is offered under Yours');
    await panel.getByLabel('Table', { exact: true }).selectOption({ label: 'Smoke trio · discussion' });
    assert.equal(await panel.getByRole('list', { name: 'Seats' }).getByRole('listitem').count(), 3, 'the saved table brings its three seats');
    await shot('4-saved-preset');
    await panel.getByRole('button', { name: 'Delete preset', exact: true }).click(); await panel.getByRole('button', { name: 'Delete preset', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Deleted.' }).waitFor(); assert.equal(await panel.locator('optgroup[label="Yours"]').count(), 0, 'the deleted table is no longer offered');
    await panel.getByRole('button', { name: 'Close', exact: true }).click(); await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.session-tile').count(), base, 'a panel that is only closed starts nothing');

    // 5. A hierarchy with a second reviewer (Claude Code, reviews only) and no final review.
    await startTable(page, 'Round Table (hierarchy)', async (setup) => {
      await setup.getByRole('button', { name: 'Add seat', exact: true }).click();
      await setup.getByLabel('Seat 4 agent', { exact: true }).selectOption('claude');
      const duties = async (seat, wanted) => { const group = setup.getByRole('group', { name: `Seat ${seat} duties`, exact: true }); for (const label of ['Plans', 'Challenges the plan', 'Reviews', 'Final review']) { const box = group.getByLabel(label, { exact: true }); if (await box.isChecked() !== wanted.includes(label)) await box.setChecked(wanted.includes(label)); } };
      await duties(4, ['Reviews']); await duties(2, ['Plans']);
      // Seats changed, another table asks first; Escape answers only that question, and the seats stay (1.31.2).
      await setup.getByLabel('Table', { exact: true }).selectOption({ index: 0 });
      const replace = setup.getByRole('group', { name: 'Replace the seats you changed?', exact: true }); await replace.waitFor();
      await replace.getByRole('button', { name: 'Keep', exact: true }).focus(); await page.keyboard.press('Escape'); await replace.waitFor({ state: 'detached' });
      assert.ok(await setup.isVisible(), 'Escape closed only the question'); assert.equal(await setup.getByLabel('Seat 4 agent', { exact: true }).count(), 1, 'the changed seats are kept');
      assert.equal(await setup.getByRole('group', { name: 'Seat 2 duties' }).getByLabel('Final review', { exact: true }).isChecked(), false);
      await shot('5-hierarchy-setup');
    });
    const chain = hierarchyTile(); await chain.waitFor({ timeout: 90000 });
    await sendTo(chain, 'Plan a footer');
    const bar = chain.locator('.chain-bar');
    await bar.getByRole('button', { name: 'Approve plan', exact: true }).click({ timeout: 90000 });
    await bar.locator('.table-status').filter({ hasText: 'Done: the review rounds are over' }).waitFor({ state: 'attached', timeout: 90000 });
    const reviews = (await received()).filter((entry) => entry.type === 'recv' && entry.text.includes('[Step: review'));
    assert.deepEqual(reviews.map((entry) => entry.engine), ['codex', 'claude'], 'both reviewers were asked, the Codex reviewer (seat 3) first and the Claude Code reviewer (seat 4) after it');
    assert.notEqual(reviews[0].pid, reviews[1].pid); assert.ok(reviews[1].text.includes('Reviewer 2'), 'the second reviewer is named Reviewer 2 in its brief');
    assert.equal((await received()).filter((entry) => entry.type === 'recv' && entry.text.includes('[Step: final review')).length, 0, 'no seat was asked for a final review');
    assert.equal((await received()).filter((entry) => entry.type === 'recv' && /\[Step: (fix|changes)/.test(entry.text)).length, 0, 'a clean review needs no fix step');
    assert.equal(await bar.locator('.chain-steps li').filter({ hasText: /final/i }).count(), 0, 'the steps have no final review');
    assert.equal(await bar.locator('.chain-steps li.current, .chain-steps li:not(.past)').count(), 0, 'every step is past');
    await shot('6-hierarchy-done');
    // A hierarchy table shows a seat's own conversation too, as a discussion table does (1.31.2).
    const showSeat = bar.getByLabel("Show an agent's own conversation", { exact: true }); const seatNames = (await showSeat.locator('option').allTextContents()).slice(1);
    assert.ok(seatNames.length >= 2, `seats offered: ${seatNames}`); await showSeat.selectOption({ index: 1 });
    await chain.locator('.table-seated').filter({ hasText: `${seatNames[0]}'s own conversation` }).waitFor(); await showSeat.selectOption(''); await chain.locator('.table-seated').waitFor({ state: 'detached' });
    // In a tile too short for it the bar folds, and it unfolds once there is room again: measured on resize, not on
    // every draw (1.30.3). Typing in the message box does not change it.
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 520));
    await until(async () => (await bar.getAttribute('class')).includes('folded'), 'the hierarchy bar folds in a short tile', 15000);
    const box = chain.getByRole('textbox', { name: 'Message to the Round Table', exact: true }); await box.pressSequentially('abc'); await box.fill('');
    assert.ok((await bar.getAttribute('class')).includes('folded'), 'typing does not unfold the bar');
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, Math.max(height, 1000)), size);
    await until(async () => !(await bar.getAttribute('class')).includes('folded'), 'the hierarchy bar unfolds with room again', 15000);

    // 6. Restart on the same profile: the three-seat table is seated again with the same names.
    await sleep(1500); await app.close(); app = null;
    await launch();
    const started2 = (await seated()).length;
    let pressed = [];
    await until(async () => {
      if (await discussionTile().count() && /Claude Code drives · Codex Reviewer and Tests review/.test(await roles(discussionTile()).first().textContent().catch(() => ''))) return true;
      for (const name of ['Start channel', 'Reopen', 'Retry']) for (const button of await page.getByRole('button', { name, exact: true }).all()) if (await button.isVisible()) { pressed.push(name); await button.click().catch(() => {}); }
      return false;
    }, 'the three-seat table seated again after a restart', 120000);
    assert.equal(await page.locator('.session-tile').count(), 2, 'after the restart the two table channels (discussion and hierarchy) are the only tiles');
    assert.match((await roles(discussionTile()).first().textContent()).trim(), /^Claude Code drives · Codex Reviewer and Tests review$/);
    assert.equal(await discussionTile().locator('.table-bar:not(.chain-bar) select[aria-label="Agent that edits files"] option').count(), 3);
    console.log(`restart: channels started by the person: ${pressed.length ? pressed.join(', ') : 'none (they started themselves)'}; processes started before the restart: ${started2}`);
    await shot('7-after-restart');

    // 7. No page errors anywhere.
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS: Round Table seats: three-seat discussion (each seat answers under its own name, the third seat got its instructions), who edits, renaming and removing a seat (its process stopped, no leftover tile) and adding one, saving and deleting a table, a hierarchy with two reviewers and no final review running to done, the three-seat table seated again after a restart, and no page errors.');
  } finally {
    await app?.close().catch(() => {});
    await removeFolder(root);
  }
})().catch((error) => { console.error(error); process.exit(1); });
