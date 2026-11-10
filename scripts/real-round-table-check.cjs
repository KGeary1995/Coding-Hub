// A real Round Table (Claude Code + Codex, the person's own logins) in the built branch: a task delivered to it, an
// approval answered, findings, TASK COMPLETE, then a message queued while the agents work and Trace quit before they
// finish; after reopening, the table comes back with its findings and the kept message. Scratch project and Trace data.
// Manual check, not part of CI: it starts the real Claude Code and Codex CLIs on your own logins and uses a little of both
// plans. Usage: npm run build && node scripts/real-round-table-check.cjs <outDir>
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const out = path.resolve(process.argv[2] ?? 'real-table'); fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-real-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n'); git('add', '.'); git('commit', '-qm', 'base');
const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') }; delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 300)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
async function launch() {
  const app = await _electron.launch({ executablePath: require(path.join(repo, 'node_modules/electron')), args, env });
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  page.setDefaultTimeout(60000); return { app, page };
}
const allowAll = async (page) => { let n = 0; for (const button of await page.locator('button.button.primary', { hasText: /^Allow$/ }).all()) { if (await button.isVisible().catch(() => false)) { await button.click().catch(() => {}); n++; } } return n; };
const taskColumn = async (page) => page.evaluate(() => { for (const section of document.querySelectorAll('.task-board section')) if (section.textContent.includes('Create hello.txt')) return { column: section.getAttribute('aria-label'), text: [...section.querySelectorAll('article')].map((a) => a.textContent).join(' | ').slice(0, 500) }; return null; });
(async () => {
  let { app, page } = await launch();
  try {
    await page.waitForSelector('.tr-empty, .session-tile'); await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Round Table', exact: true }).click();
    const box = page.getByRole('textbox', { name: 'Message to the Round Table' }); await box.waitFor({ timeout: 180000 });
    await page.waitForFunction(() => document.querySelector('.table-bar')?.textContent?.includes('drives'), null, { timeout: 180000 });
    await page.getByRole('combobox', { name: 'Permissions' }).selectOption('ask').catch((e) => note('permissions-failed', { error: String(e) }));
    await page.locator('.table-rounds select').selectOption('1');
    await shot(page, '01-table-open'); note('table-open', { bar: await page.locator('.table-bar').innerText() });
    // Deliver a task to the table from Tasks.
    await page.getByRole('button', { name: 'Tasks', exact: true }).first().click(); await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByLabel('Task title').fill('Create hello.txt containing the word hello');
    await page.getByLabel('Task details').fill('Codex, as reviewer: read hello.txt after the change and report anything wrong as a FINDING line (at least one, even a small one).');
    const options = await page.getByLabel('Task agent session').locator('option').allTextContents(); note('channels', { options });
    const lead = options.findIndex((text) => /^CH\d/.test(text) && !/not running/.test(text)); await page.getByLabel('Task agent session').selectOption({ index: lead });
    await page.getByRole('button', { name: 'Save and send', exact: true }).click(); note('task-sent', { channel: options[lead] });
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const until = Date.now() + 9 * 60000; let allowed = 0; let state = null;
    while (Date.now() < until) {
      allowed += await allowAll(page); await page.waitForTimeout(4000);
      const bar = await page.locator('.table-bar').innerText().catch(() => '');
      if (/They agree|Your turn|idle/i.test(bar) && !/working/i.test(bar)) { await page.getByRole('button', { name: 'Tasks', exact: true }).first().click(); state = await taskColumn(page); await page.getByRole('button', { name: 'Workspace', exact: true }).click(); if (state && state.column !== 'Working') break; if (state && /blocked|not confirmed|TASK BLOCKED|without saying/i.test(state.text)) break; }
    }
    note('task-result', { allowed, state, file: fs.existsSync(path.join(project, 'hello.txt')) ? fs.readFileSync(path.join(project, 'hello.txt'), 'utf8').slice(0, 100) : null });
    const findings = await page.locator('.table-findings summary').innerText().catch(() => 'none'); note('findings', { findings }); await shot(page, '02-after-task');
    await page.getByRole('button', { name: 'Tasks', exact: true }).first().click(); await shot(page, '03-tasks'); await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    // Queue a message while the agents work, then quit before they finish.
    await box.fill('Read hello.txt and README.md, then describe both in three sentences.'); await box.press('Enter'); await page.waitForTimeout(300);
    await box.fill('Then add a second line world to hello.txt.'); await box.press('Enter');
    await page.waitForFunction(() => document.querySelector('.table-waiting'), null, { timeout: 20000 }).catch(() => {});
    note('queued', { bar: await page.locator('.table-bar').innerText() }); await shot(page, '04-queued');
    await page.waitForTimeout(2500); // the window's autosave
    await app.close();
    ({ app, page } = await launch());
    await page.waitForSelector('.session-tile'); await page.waitForTimeout(3000); await shot(page, '05-reopened');
    const tableTile = page.locator('.session-tile').filter({ hasText: 'Round Table' }); await tableTile.getByRole('button', { name: /^Start/ }).first().click();
    await page.waitForFunction(() => document.querySelector('.table-waiting') || document.querySelector('.table-bar')?.textContent?.includes('drives'), null, { timeout: 240000 }).catch(() => {});
    await page.waitForTimeout(5000);
    note('restored', { bar: await page.locator('.table-bar').innerText().catch(() => 'no bar'), notice: await page.locator('.tr-toast').allInnerTexts().catch(() => []) }); await shot(page, '06-restored');
    const drop = page.getByRole('button', { name: 'Drop it', exact: true }); if (await drop.isVisible().catch(() => false)) { await drop.click(); note('dropped', {}); }
  } catch (error) { note('error', { error: String(error).slice(0, 500) }); await shot(page, '99-error'); }
  finally { fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2)); await app.close().catch(() => {}); }
})();
