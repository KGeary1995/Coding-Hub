// Manual check, not part of CI: a real ACP agent other than Gemini as a custom agent (1.41.0, docs/custom-agents.md), in the
// built app, on a scratch project and scratch Trace data. The agent is Claude Code through its ACP adapter
// (`npm i -g @agentclientprotocol/claude-agent-acp`), on your own Claude sign-in; ANTHROPIC_MODEL keeps it on Haiku.
// It adds the agent through Agents → From a list (a repository with trace-agent.json, fetched with this computer's Git, so a
// private one works), chats with it from + Channel (shared memory over ACP, Ask declines a file change, Allow edits makes
// it), continues the conversation after a restart (session/load), and runs a Round Table of two of its chats.
// Usage: npm run build && node scripts/real-acp-agent-check.cjs <outDir> [owner/repo]
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
const { openView, addChannel, tileControl } = require('./lib/navigate.cjs');
const out = path.resolve(process.argv[2] ?? 'real-acp-agent'); fs.mkdirSync(out, { recursive: true });
const shared = process.argv[3] ?? 'KGeary1995/trace-agent-test';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-acp-agent-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, stdio: 'pipe' });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n\nA scratch project about lighthouses.\n'); git('add', '.'); git('commit', '-qm', 'base');
const env = { ...process.env, CODING_HUB_DEFAULT_DRIVE_DIR: NO_DRIVE.CODING_HUB_DEFAULT_DRIVE_DIR, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[key];
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 900)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
const checks = []; const check = (name, ok, detail) => { checks.push({ name, ok: !!ok }); note(`check:${name}`, { ok: !!ok, detail }); };
(async () => {
  let app; let page; const errors = []; let failed = null;
  const launch = async () => {
    app = await _electron.launch({ executablePath: require(path.join(repo, 'node_modules/electron')), args, env });
    page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
    // The save dialog is answered "Save agent" (button 0); the folder picker gets the scratch project.
    await app.evaluate(({ dialog }, folder) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    page.setDefaultTimeout(60000); page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
    await page.waitForSelector('.tr-empty, .session-tile');
  };
  let session = null; const tileOf = async () => { session ??= await page.locator('.session-tile').filter({ hasText: 'Claude ACP chat' }).first().getAttribute('data-session'); return page.locator(`.session-tile[data-session="${session}"]`); };
  // The getting-started card can cover a tile's header controls; the tile's own Start in its middle is used instead.
  const start = async (tile) => { await page.getByRole('button', { name: 'Hide the guide', exact: true }).click({ timeout: 3000 }).catch(() => {}); await tile.getByRole('button', { name: 'Start channel', exact: true }).click(); };
  const box = (tile) => tile.getByRole('textbox', { name: 'Message to Claude ACP', exact: true });
  const ready = () => page.waitForFunction(() => [...document.querySelectorAll('.session-tile textarea')].some((b) => b.getAttribute('aria-label') === 'Message to Claude ACP' && !b.disabled), null, { timeout: 120000 });
  const turn = async (tile, text, minutes = 4, answer = null) => {
    const before = await tile.locator('.chat-message.assistant').count();
    await box(tile).fill(text); await box(tile).press('Enter');
    // A turn is over when the "working" line has gone after a reply came; approval cards are counted, never clicked.
    const until = Date.now() + minutes * 60000; let cards = 0; let seenBusy = false;
    while (Date.now() < until) {
      const card = tile.locator('button.button.primary', { hasText: /^Allow$/ }); const open = await card.count(); cards += open ? 1 : 0;
      // An approval card is answered as a person would (answer: 'Allow' or 'Deny') and noted; with no answer the turn stops waiting.
      if (open && answer) { note('card', { text: (await tile.locator('.chat-approval, .chat-message').last().innerText().catch(() => '')).slice(0, 300), answer }); await tile.getByRole('button', { name: answer, exact: true }).last().click(); await page.waitForTimeout(1500); continue; }
      const working = await tile.locator('.chat-working').count() > 0; seenBusy ||= working;
      if (!working && (seenBusy || await tile.locator('.chat-message.assistant').count() > before) && await tile.locator('.chat-message.assistant').count() > before) { await page.waitForTimeout(2000); if (!(await tile.locator('.chat-working').count())) break; }
      if (cards && !answer) break;
      await page.waitForTimeout(1500);
    }
    const all = await tile.locator('.chat-message.assistant').allInnerTexts();
    return { reply: all.slice(before).join('\n').slice(-1500), cards, thread: (await tile.locator('.chat-thread').innerText().catch(() => '')).slice(-1500) };
  };
  try {
    await launch();
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    // 1. From a list: paste the repository, Get it, check the form, Save (the system dialog answered above).
    await openView(page, 'Agents');
    await page.getByLabel('GitHub repository with an agent', { exact: true }).fill(shared);
    await page.getByRole('button', { name: 'Get it', exact: true }).click();
    const form = page.locator('article.agent-form'); await form.waitFor({ timeout: 90000 }); await shot(page, '01-fetched');
    const formText = (await form.innerText()).replace(/\s+/g, ' ');
    check('fetched', /From KGeary1995\/trace-agent-test|From .*trace-agent-test/.test(formText) && await page.getByLabel('Agent program', { exact: true }).inputValue() === 'claude-agent-acp', formText.slice(0, 400));
    check('modes-in-form', await page.getByLabel('Ask mode', { exact: true }).inputValue() === 'plan' && await page.getByLabel('Full access mode', { exact: true }).inputValue() === 'bypassPermissions', null);
    check('nothing-saved-on-fetch', !(await page.locator('.agents-panel .ui-row').filter({ hasText: 'Claude ACP' }).count()), null);
    await form.getByRole('button', { name: 'Test start', exact: true }).click(); await page.waitForTimeout(4000);
    note('test-start', { text: (await page.locator('.agents-panel').innerText()).replace(/\s+/g, ' ').match(/.{0,80}0\.112\.0.{0,80}/)?.[0] ?? null });
    await form.getByRole('button', { name: 'Save agent', exact: true }).click();
    await page.locator('.agents-panel .ui-row').filter({ hasText: 'Claude ACP' }).filter({ hasText: 'On' }).waitFor({ timeout: 30000 }); await shot(page, '02-saved');
    check('saved-on', true, null);
    // 2. A chat from + Channel, with Trace's shared memory over ACP.
    await openView(page, 'Workspace'); await addChannel(page, 'Claude ACP chat');
    let tile = await tileOf(); await start(tile); await ready();
    note('default-permissions', { level: await tile.getByLabel('Permissions', { exact: true }).inputValue().catch(() => null) });
    let t = await turn(tile, 'Do not change any file. Reply on one line: the word PONG, then "memory: yes" if you have a tool from an MCP server named coding-hub-memory (for example read_memory), else "memory: no".');
    await shot(page, '03-first'); check('first-reply', /PONG/.test(t.reply), t.reply); check('memory-over-acp', /memory:\s*yes/i.test(t.reply), t.reply);
    // 3. Ask is read-only: a file change is declined.
    await tile.getByLabel('Permissions', { exact: true }).selectOption('ask'); await page.waitForTimeout(1500);
    t = await turn(tile, 'Create a file named ask.txt in the project folder containing the word hi. Try to write it even if you are unsure.', 4, 'Deny');
    await shot(page, '04-ask'); check('ask-declined', !fs.existsSync(path.join(project, 'ask.txt')), { reply: t.reply, cards: t.cards });
    // 3b. At Ask, a person approves the agent's own "Approve Plan" (Claude's ExitPlanMode): does Ask stay read-only?
    t = await turn(tile, 'Make a one-line plan to create a file named plan.txt in the project folder containing the word hi, then ask me to approve the plan (ExitPlanMode). Once it is approved, create the file.', 5, 'Allow');
    await shot(page, '04b-ask-plan-approved'); check('ask-stays-read-only-after-plan-approval', !fs.existsSync(path.join(project, 'plan.txt')), { reply: t.reply, cards: t.cards, level: await tile.getByLabel('Permissions', { exact: true }).inputValue().catch(() => null) });
    // 4. Allow edits: the file is made without an approval card.
    await tile.getByLabel('Permissions', { exact: true }).selectOption('edits'); await page.waitForTimeout(1500);
    t = await turn(tile, 'Now create a file named edits.txt in the project folder containing exactly the word hi.', 4, null);
    await shot(page, '05-edits'); check('edits-made', fs.existsSync(path.join(project, 'edits.txt')), { reply: t.reply, cards: t.cards });
    note('edits-cards', { cards: t.cards });
    // 5. Restart: the conversation continues (session/load), earlier messages shown again.
    await (await tileControl(tile, 'Stop')).click(); await page.waitForTimeout(3000);
    tile = await tileOf(); await tile.getByRole('button', { name: 'Restart', exact: true }).click(); await ready();
    await page.waitForTimeout(3000); const shown = await tile.locator('.chat-thread').innerText().catch(() => '');
    check('history-shown-after-restart', /PONG/.test(shown), shown.slice(-600));
    t = await turn(tile, 'Do not change any file. What single word in capitals did you reply with at the start of this conversation? Reply with only that word.');
    await shot(page, '06-resumed'); check('resumed-remembers', /PONG/.test(t.reply), t.reply);
    if (process.argv.includes('--until-resume')) return;
    // 6. A Round Table of two Claude ACP chats: one drives, one reviews.
    await tile.getByRole('button', { name: 'Round Table: add agents', exact: true }).click(); const setup = page.locator('dialog.table-setup'); await setup.waitFor();
    note('seat-agents', { options: await setup.getByLabel('Seat 2 agent', { exact: true }).locator('option').allTextContents() });
    await setup.getByLabel('Seat 2 agent', { exact: true }).selectOption('custom:claude-acp');
    await setup.getByRole('button', { name: 'Start Round Table', exact: true }).click(); await setup.waitFor({ state: 'detached', timeout: 120000 });
    await tile.locator('.table-roles').filter({ hasText: /drives/ }).waitFor({ state: 'attached', timeout: 180000 });
    note('table-roles', { roles: (await tile.locator('.table-roles').innerText().catch(() => '')).replace(/\s+/g, ' ') });
    const tableBox = tile.getByRole('textbox', { name: 'Message to the Round Table', exact: true }); await tableBox.fill('Do not change any file. In one sentence: what is this project about, going by README.md?'); await tableBox.press('Enter');
    const end = Date.now() + 8 * 60000; let status = '';
    while (Date.now() < end) { const now = (await tile.locator('.table-status').last().innerText().catch(() => '')).trim(); if (now !== status) { status = now; note('table-status', { status }); } if (/Your turn/i.test(status)) break; await page.waitForTimeout(3000); }
    const table = await tile.locator('.chat-thread').innerText().catch(() => ''); await shot(page, '07-table');
    check('table-finished', /Your turn/i.test(status), status); check('reviewer-answered', /Claude ACP 2/.test(table) && /lighthouse/i.test(table), table.slice(-1500));
    await tile.getByRole('button', { name: 'Close the Round Table', exact: true }).click().catch(() => {}); await page.waitForTimeout(3000);
  } catch (error) { failed = String(error).slice(0, 600); await shot(page, 'failed'); note('at-failure', { thread: (await page.locator('.chat-thread').last().innerText().catch(() => '')).slice(-1200) }); }
  finally {
    note('page-errors', { errors }); fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
    await app?.close().catch(() => {}); if (process.env.KEEP_TRACE_DATA) console.log('kept', root); else await removeFolder(root);
  }
  const bad = checks.filter((item) => !item.ok).map((item) => item.name);
  if (failed || bad.length) { console.error('FAILED:', failed ?? '', bad.join(', ')); process.exitCode = 1; } else console.log(`PASS: ${checks.length} checks with Claude Code over ACP as a custom agent.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
