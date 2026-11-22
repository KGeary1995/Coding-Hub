// Manual check, not part of CI: a Gemini CLI seat at a Round Table (1.28) with the real Claude Code and Gemini CLI on
// your own logins, in the built app, on a scratch project and scratch Trace data. Uses a little of both plans (the
// Claude seat runs Haiku). A discussion table of two: Claude Code leads and edits, Gemini CLI reviews. It checks that
// the Gemini seat answers under its own name, is refused as the seat that edits, and that its usage is counted.
// Usage: npm run build && node scripts/real-gemini-seat-check.cjs <outDir> [--hierarchy | --full]
// --full: instead, the table is set to Full access and each seat is asked to run a command; no approval may appear.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
const { startTable } = require('./lib/navigate.cjs');
const out = path.resolve(process.argv[2] ?? 'real-gemini-seat'); fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-gemini-seat-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, stdio: 'pipe' });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n\nA scratch project about lighthouses.\n'); git('add', '.'); git('commit', '-qm', 'base');
// No Drive folder, but the real Gemini CLI and its own data folder (NO_DRIVE hides both from ordinary tests).
const env = { ...process.env, CODING_HUB_DEFAULT_DRIVE_DIR: NO_DRIVE.CODING_HUB_DEFAULT_DRIVE_DIR, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODING_HUB_GEMINI_HOME', 'CODING_HUB_TEST_NO_GEMINI']) delete env[key];
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 900)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
const allowAll = async (page) => { let n = 0; for (const button of await page.locator('button.button.primary', { hasText: /^Allow$/ }).all()) if (await button.isVisible().catch(() => false)) { await button.click().catch(() => {}); n++; } return n; };
const thread = (page) => page.locator('.chat-view.at-table .chat-thread').last().innerText().catch(() => '');
(async () => {
  const app = await _electron.launch({ executablePath: require(path.join(repo, 'node_modules/electron')), args, env });
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  page.setDefaultTimeout(60000); const errors = []; page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  let failed = null;
  try {
    await page.waitForSelector('.tr-empty, .session-tile'); await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    await startTable(page, 'Round Table', async (panel) => {
      await panel.getByLabel('Seat 1 model', { exact: true }).selectOption('claude-haiku-5-5');
      // The lead is not offered Gemini CLI; the second seat is, and then cannot be the seat that edits.
      note('lead-agents', { options: await panel.getByLabel('Seat 1 agent', { exact: true }).locator('option').allTextContents() });
      await panel.getByLabel('Seat 2 agent', { exact: true }).selectOption('gemini');
      await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Seat 2 model"] option').length > 2, null, { timeout: 60000 }).catch(() => {});
      note('gemini-models', { options: (await panel.getByLabel('Seat 2 model', { exact: true }).locator('option').allTextContents()).slice(0, 8), editsDisabled: await panel.locator('input[type="radio"]').nth(1).isDisabled() });
      await panel.getByLabel('Rounds', { exact: true }).selectOption('1'); await shot(page, '01-setup');
    });
    const box = page.getByRole('textbox', { name: 'Message to the Round Table' }); await box.waitFor({ timeout: 240000 });
    await page.waitForFunction(() => document.querySelector('.table-bar')?.textContent?.includes('drives'), null, { timeout: 240000 });
    note('table-open', { bar: (await page.locator('.table-bar').innerText()).replace(/\s+/g, ' ') });
    if (process.argv.includes('--full')) {
      // Full access, set on the open table: it must reach the Gemini CLI seat, whose commands then run without an approval card. Nothing here clicks Allow.
      await page.getByLabel('Permissions', { exact: true }).last().selectOption('full'); await page.waitForTimeout(1500);
      const head = git('rev-parse', '--short', 'HEAD').toString().trim();
      await box.fill('Change no file. Each of you: run the command "git rev-parse --short HEAD" yourself and reply with only its output.'); await box.press('Enter');
      const until = Date.now() + 8 * 60000; let now = ''; let cards = 0;
      while (Date.now() < until) { cards = Math.max(cards, await page.locator('button.button.primary', { hasText: /^Allow$/ }).count()); const next = (await page.locator('.table-bar .table-status').last().innerText().catch(() => '')).trim(); if (next !== now) { now = next; note('status', { status: now }); } if (/Your turn/i.test(now) || cards) break; await page.waitForTimeout(1500); }
      const all = await thread(page); await shot(page, '02-full'); const gemini = all.split(/Gemini CLI\s*·\s*Review/).slice(1).join(' ');
      note('full', { head, cards, geminiSaysHead: gemini.includes(head), tail: all.slice(-900) });
      failed = cards ? 'An approval card appeared at Full access.' : !/Your turn/i.test(now) ? 'The table did not finish in time.' : !gemini.includes(head) ? 'The Gemini CLI seat did not report what the command printed.' : null;
      return;
    }
    await box.fill('Do not change any file. In one sentence each: what is this project about, going by README.md?'); await box.press('Enter');
    const end = Date.now() + 8 * 60000; let status = '';
    while (Date.now() < end) { await allowAll(page); const now = (await page.locator('.table-bar .table-status').last().innerText().catch(() => '')).trim(); if (now !== status) { status = now; note('status', { status }); } if (/Your turn/i.test(status)) break; await page.waitForTimeout(3000); }
    const text = await thread(page); await shot(page, '02-discussion');
    note('thread', { tail: text.slice(-1800), gemini: /Gemini CLI\s*·\s*Review/.test(text), claude: /Claude Code\s*·\s*Driver/.test(text), lighthouse: (text.match(/lighthouse/gi) ?? []).length });
    const today = await page.evaluate(async () => (await window.codingHub.workbench({ action: 'usage-today' })));
    note('usage-today', today);
    if (!/Your turn/i.test(status)) failed = 'The table did not finish in time.'; else if (!/Gemini CLI\s*·\s*Review/.test(text)) failed = 'No reply labelled as the Gemini CLI seat.';
    if (!failed && process.argv.includes('--hierarchy')) {
      // 2. A hierarchy: Claude Code (Haiku) builds and plans, Gemini CLI challenges the plan and reviews the work.
      await page.getByRole('button', { name: 'Close the Round Table', exact: true }).click(); await page.waitForTimeout(8000);
      await startTable(page, 'Round Table (hierarchy)', async (panel) => {
        await panel.getByLabel('Seat 1 model', { exact: true }).selectOption('claude-haiku-5-5'); await panel.getByLabel('Seat 2 model', { exact: true }).selectOption('claude-haiku-5-5');
        await panel.getByLabel('Seat 3 agent', { exact: true }).selectOption('gemini');
        await panel.getByLabel('Review rounds', { exact: true }).selectOption('1'); await shot(page, '03-hierarchy-setup');
        note('hierarchy-setup', { problem: await panel.locator('[role=alert]').allInnerTexts().catch(() => []) });
      });
      await page.waitForSelector('.chain-bar', { timeout: 300000 }); note('hierarchy-open', { bar: (await page.locator('.chain-bar').innerText()).replace(/\s+/g, ' ') });
      const task = page.getByRole('textbox', { name: 'Message to the Round Table' }).last();
      await task.fill('Create hello.txt containing exactly the word hello. Nothing else.'); await task.press('Enter');
      const wait = async (test, minutes, label) => { const until = Date.now() + minutes * 60000; let seen = ''; while (Date.now() < until) { await allowAll(page); const bar = await page.locator('.chain-bar').last().innerText().catch(() => ''); const now = (await page.locator('.chain-bar .table-status').last().innerText().catch(() => '')).trim(); if (now !== seen) { seen = now; note(`${label}:status`, { status: now }); } if (test(bar, now)) return true; await page.waitForTimeout(3000); } return false; };
      const planned = await wait((bar) => /plan is ready|Approve plan/i.test(bar), 10, 'plan'); await shot(page, '04-plan');
      const approve = page.getByRole('button', { name: 'Approve plan', exact: true });
      if (planned && await approve.isVisible().catch(() => false)) { await approve.click(); await wait((bar, now) => /^Done|approved|needs you|stopped|Continue/i.test(now) || /Continue/.test(bar), 15, 'work'); }
      const all = await page.locator('.chat-thread').last().innerText().catch(() => ''); await shot(page, '05-hierarchy-end');
      const labels = [...new Set(all.match(/^(Planner|Builder|Reviewer|Challenger)( · [^\n]+)?$/gm) ?? [])];
      note('hierarchy-thread', { tail: all.slice(-2500), labels, hello: fs.existsSync(path.join(project, 'hello.txt')) ? fs.readFileSync(path.join(project, 'hello.txt'), 'utf8') : null });
      if (!planned) failed = 'The hierarchy produced no plan in time.'; else if (!/APPROVED|FINDING|CHALLENGE|No findings|no challenge/i.test(all)) failed = 'No review or challenge appears in the hierarchy thread.';
    }
  } catch (error) { failed = String(error).slice(0, 600); await shot(page, 'failed'); note('thread-at-failure', { tail: (await thread(page)).slice(-1200), bar: await page.locator('.table-bar').innerText().catch(() => '') }); }
  finally {
    note('page-errors', { errors }); fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
    await app.close().catch(() => {}); await removeFolder(root);
  }
  if (failed) { console.error('FAILED:', failed); process.exitCode = 1; } else console.log('PASS: a Gemini CLI seat answered at a Round Table led by Claude Code.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
