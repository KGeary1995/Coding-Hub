// Manual check, not part of CI: a discussion Round Table with the real Claude Code and Codex on your own logins, in the
// built app, on a scratch project and scratch Trace data. Uses a little of both plans (the Claude seats run Haiku).
// Three seats: Claude Code leads and edits, Codex and a second Claude Code review. It checks that what each seat says
// reaches the others and that the driver changes files only once the discussion is over: each seat suggests a line
// for a file, and the driver then writes the file with a line from every seat.
// Usage: npm run build && node scripts/real-discussion-check.cjs <outDir>
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
const { startTable } = require('./lib/navigate.cjs');
const out = path.resolve(process.argv[2] ?? 'real-discussion'); fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-discussion-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, stdio: 'pipe' });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n\nA scratch project about lighthouses.\n'); git('add', '.'); git('commit', '-qm', 'base');
const env = { ...process.env, ...NO_DRIVE, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[key];
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 1500)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
const allowAll = async (page) => { for (const button of await page.locator('button.button.primary', { hasText: /^Allow$/ }).all()) if (await button.isVisible().catch(() => false)) await button.click().catch(() => {}); };
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
      await panel.getByRole('button', { name: 'Add seat', exact: true }).click();
      await panel.getByLabel('Seat 3 model', { exact: true }).selectOption('claude-haiku-5-5');
      note('setup', { rounds: await panel.getByLabel('Rounds', { exact: true }).inputValue(), agents: await Promise.all([1, 2, 3].map((n) => panel.getByLabel(`Seat ${n} agent`, { exact: true }).inputValue())) }); await shot(page, '01-setup');
    });
    const box = page.getByRole('textbox', { name: 'Message to the Round Table' }); await box.waitFor({ timeout: 240000 });
    await page.waitForFunction(() => document.querySelector('.table-bar')?.textContent?.includes('drives'), null, { timeout: 240000 });
    note('table-open', { bar: (await page.locator('.table-bar').innerText()).replace(/\s+/g, ' ') });
    const notes = path.join(project, 'NOTES.md'); let early = false;
    await box.fill('Create NOTES.md with exactly three short facts about lighthouses, one suggested by each seat at this table, each line ending with the name of the seat that suggested it.');
    await box.press('Enter');
    const end = Date.now() + 12 * 60000; let status = ''; const seen = [];
    while (Date.now() < end) {
      await allowAll(page); const now = (await page.locator('.table-bar .table-status').last().innerText().catch(() => '')).trim();
      // The file must not exist while they still discuss: the driver writes it once the discussion is over.
      if (/answering|^Round /i.test(now) && fs.existsSync(notes)) early = true;
      if (now !== status) { status = now; seen.push(now); note('status', { status }); } if (/Your turn/i.test(status)) break; await page.waitForTimeout(2000);
    }
    const text = await thread(page); await shot(page, '02-end'); fs.writeFileSync(path.join(out, 'thread.txt'), text);
    const file = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : null;
    note('result', { statuses: seen, early, file, declined: (text.match(/Trace declined[^\n]*/g) ?? []).slice(0, 4) });
    if (!/Your turn/i.test(status)) failed = 'The table did not finish in time.';
    else if (!seen.some((item) => /^Round 1 of/.test(item))) failed = 'No discussion round ran: the answers were not passed on.';
    else if (early) failed = 'NOTES.md was written while the seats were still discussing.';
    else if (!seen.some((item) => /making the changes/.test(item))) failed = 'The driver was not given its turn to make the changes.';
    else if (!file) failed = 'The driver did not write NOTES.md.';
    else if (!/Codex/.test(file) || !/Claude Code 2/.test(file)) failed = 'NOTES.md does not carry the other seats\' suggestions: what they said did not reach the driver.';
  } catch (error) { failed = String(error).slice(0, 600); await shot(page, 'failed'); note('thread-at-failure', { tail: (await thread(page)).slice(-1500), bar: await page.locator('.table-bar').innerText().catch(() => '') }); }
  finally {
    note('page-errors', { errors }); fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
    await app.close().catch(() => {}); await removeFolder(root).catch(() => {});
    console.log(failed ? `FAILED: ${failed}` : 'PASS: the seats discussed first, and the driver then wrote the file with a line from every seat.'); process.exit(failed ? 1 : 0);
  }
})();
