// Manual check, not part of CI: Round Table seats (1.26) with the real Claude Code and Codex CLIs on your own logins, in
// the built app, on a scratch project and scratch Trace data. Uses a little of both plans (the Claude seats run Haiku).
//   1. A discussion table of three: Claude Code, Codex and a second Claude Code seat named Tests, with instructions of its own.
//   2. That seat's model changed on the open table (Seats), which restarts it; it is then asked what was said before.
//   3. A hierarchy with a Codex planner (who also gives the final review), a Claude Code builder, and two reviewers
//      (Codex, then Claude Code) taking the review one after another.
// Usage: npm run build && node scripts/real-table-seats-check.cjs <outDir>
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
const { startTable } = require('./lib/navigate.cjs');
const out = path.resolve(process.argv[2] ?? 'real-seats'); fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-seats-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, stdio: 'pipe' });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n\nA scratch project about lighthouses.\n'); git('add', '.'); git('commit', '-qm', 'base');
const env = { ...process.env, ...NO_DRIVE, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') }; delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 700)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
const allowAll = async (page) => { let n = 0; for (const button of await page.locator('button.button.primary', { hasText: /^Allow$/ }).all()) if (await button.isVisible().catch(() => false)) { await button.click().catch(() => {}); n++; } return n; };
const thread = (page) => page.locator('.chat-view.at-table .chat-thread').last().innerText().catch(() => '');
/** Waits until the bar's text passes `test` (answering approvals meanwhile), noting each change of status. */
async function until(page, bar, test, minutes, label) {
  const end = Date.now() + minutes * 60000; let seen = ''; let allowed = 0;
  while (Date.now() < end) {
    allowed += await allowAll(page); const text = await page.locator(bar).last().innerText().catch(() => ''); const status = (await page.locator(`${bar} .table-status`).last().innerText().catch(() => '')).trim();
    if (status !== seen) { seen = status; note(`${label}:status`, { status }); }
    if (test(text, status)) return { text, allowed }; await page.waitForTimeout(3000);
  }
  return { text: await page.locator(bar).last().innerText().catch(() => ''), allowed, timedOut: true };
}
(async () => {
  const app = await _electron.launch({ executablePath: require(path.join(repo, 'node_modules/electron')), args, env });
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  page.setDefaultTimeout(60000); const errors = []; page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  try {
    await page.waitForSelector('.tr-empty, .session-tile'); await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    note('channels-at-start', { tiles: await page.locator('.session-tile').count() });

    // 1. A discussion of three, the Claude seats on Haiku; the third seat has a name and instructions of its own.
    await startTable(page, 'Round Table', async (panel) => {
      await panel.getByLabel('Seat 1 model', { exact: true }).fill('haiku');
      await panel.getByRole('button', { name: 'Add seat', exact: true }).click();
      await panel.getByLabel('Seat 3 agent', { exact: true }).selectOption('claude'); await panel.getByLabel('Seat 3 model', { exact: true }).fill('haiku');
      await panel.getByLabel('Seat 3 name', { exact: true }).fill('Tests');
      await panel.getByLabel('Seat 3 instructions', { exact: true }).fill('Begin every reply with the single word PINEAPPLE on its own line.');
      await panel.getByLabel('Rounds', { exact: true }).selectOption('1'); await shot(page, '01-setup');
    });
    const box = page.getByRole('textbox', { name: 'Message to the Round Table' }); await box.waitFor({ timeout: 240000 });
    await page.waitForFunction(() => document.querySelector('.table-bar')?.textContent?.includes('drives'), null, { timeout: 240000 });
    note('discussion-open', { bar: await page.locator('.table-bar').innerText() });
    await box.fill('Do not change any file. In one sentence each: what is this project about, going by README.md? Remember the code word HERON for later.'); await box.press('Enter');
    await page.waitForTimeout(8000);
    let r = await until(page, '.table-bar', (text, status) => /Your turn/i.test(status), 8, 'discussion'); note('discussion-done', r);
    let text = await thread(page); await shot(page, '02-discussion');
    note('discussion-thread', { tail: text.slice(-2500), pineapple: /PINEAPPLE/.test(text), labels: { claude: /Claude Code · Driver/.test(text), codex: /Codex · Review/.test(text), tests: /Tests · Review/.test(text) } });

    // 2. The third seat's model changed on the open table: it restarts, the table seats itself again, and it still knows the conversation.
    await page.locator('.table-bar').getByRole('button', { name: 'Seats' }).click();
    const edit = page.locator('dialog.table-setup'); await edit.waitFor(); const which = [];
    for (const index of [1, 2, 3]) which.push(await edit.getByLabel(`Seat ${index} name`, { exact: true }).inputValue());
    const seat = which.indexOf('Tests') + 1; note('edit-panel', { names: which, seat });
    await edit.getByLabel(`Seat ${seat} model`, { exact: true }).fill('claude-haiku-5-5'); await shot(page, '03-edit');
    await edit.getByRole('button', { name: 'Apply', exact: true }).click();
    const closed = await edit.waitFor({ state: 'detached', timeout: 240000 }).then(() => true, () => false);
    note('model-change-applied', { closed, error: closed ? null : await edit.locator('[role=alert]').allInnerTexts().catch(() => []) });
    if (!closed) await edit.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
    await page.waitForFunction(() => document.querySelector('.table-bar')?.textContent?.includes('drives') && document.querySelector('.table-bar select'), null, { timeout: 240000 }).catch(() => {});
    await page.waitForTimeout(4000); note('after-model-change', { bar: await page.locator('.table-bar').innerText().catch(() => 'no bar'), tiles: await page.locator('.session-tile').count() });
    await box.fill('Do not change any file. Each of you: which code word did I ask you to remember? Answer in three words at most.'); await box.press('Enter');
    await page.waitForTimeout(8000);
    r = await until(page, '.table-bar', (t, status) => /Your turn/i.test(status), 8, 'recall'); note('recall-done', r);
    text = await thread(page); await shot(page, '04-recall'); note('recall-thread', { tail: text.slice(-1800), heron: (text.slice(-1800).match(/HERON/gi) ?? []).length });
    // The model each Claude seat really ran, from Claude Code's own transcripts of this scratch project.
    try {
      const home = path.join(os.homedir(), '.claude', 'projects'); const models = {};
      for (const folder of fs.readdirSync(home).filter((name) => name.toLowerCase().includes(path.basename(root).toLowerCase()))) for (const file of fs.readdirSync(path.join(home, folder)).filter((name) => name.endsWith('.jsonl'))) {
        const found = new Set(); for (const line of fs.readFileSync(path.join(home, folder, file), 'utf8').split('\n')) { const model = /"model":"([^"]+)"/.exec(line)?.[1]; if (model && model !== '<synthetic>') found.add(model); }
        models[file.slice(0, 8)] = [...found];
      }
      note('claude-models-used', models);
    } catch (error) { note('claude-models-used', { error: String(error).slice(0, 200) }); }
    await page.getByRole('button', { name: 'Close the Round Table', exact: true }).click(); await page.waitForTimeout(8000);
    note('discussion-closed', { tiles: await page.locator('.session-tile').count() });

    // 3. A hierarchy: Codex plans and gives the final review, Claude Code (Haiku) builds, Codex then Claude Code (Haiku) review.
    await startTable(page, 'Round Table (hierarchy)', async (panel) => {
      await panel.getByLabel('Seat 1 model', { exact: true }).fill('haiku');
      await panel.getByLabel('Seat 2 agent', { exact: true }).selectOption('codex'); await panel.getByLabel('Seat 2 model', { exact: true }).fill('');
      await panel.getByLabel('Seat 3 model', { exact: true }).fill('');
      await panel.getByRole('button', { name: 'Add seat', exact: true }).click();
      await panel.getByLabel('Seat 4 agent', { exact: true }).selectOption('claude'); await panel.getByLabel('Seat 4 model', { exact: true }).fill('haiku');
      const duties = panel.getByRole('group', { name: 'Seat 4 duties', exact: true });
      for (const duty of ['Plans', 'Challenges the plan', 'Final review']) if (await duties.getByLabel(duty, { exact: true }).isChecked()) await duties.getByLabel(duty, { exact: true }).uncheck();
      if (!await duties.getByLabel('Reviews', { exact: true }).isChecked()) await duties.getByLabel('Reviews', { exact: true }).check();
      await panel.getByLabel('Review rounds', { exact: true }).selectOption('1'); await shot(page, '05-hierarchy-setup');
      note('hierarchy-setup', { problem: await panel.locator('[role=alert]').allInnerTexts().catch(() => []) });
    });
    await page.waitForSelector('.chain-bar', { timeout: 300000 }); note('hierarchy-open', { bar: await page.locator('.chain-bar').innerText() }); await shot(page, '06-hierarchy-open');
    const task = page.getByRole('textbox', { name: 'Message to the Round Table' }).last();
    await task.fill('Create hello.txt containing exactly the word hello. Nothing else.'); await task.press('Enter');
    r = await until(page, '.chain-bar', (t) => /plan is ready|Approve plan/i.test(t), 10, 'plan'); note('plan', r); await shot(page, '07-plan');
    const approve = page.getByRole('button', { name: 'Approve plan', exact: true });
    if (await approve.isVisible().catch(() => false)) {
      await approve.click();
      r = await until(page, '.chain-bar', (t, status) => /^Done|approved|needs you|stopped|Continue/i.test(status) || /Continue/.test(t), 15, 'work'); note('work', r);
    }
    text = await page.locator('.chat-thread').last().innerText().catch(() => ''); await shot(page, '08-hierarchy-end');
    note('hierarchy-thread', { tail: text.slice(-3500), labels: [...new Set(text.match(/^(Planner|Builder|Reviewer 2|Reviewer)( · [^\n]+)?$/gm) ?? [])] });
    note('hello', { file: fs.existsSync(path.join(project, 'hello.txt')) ? fs.readFileSync(path.join(project, 'hello.txt'), 'utf8').slice(0, 60) : null, findings: await page.locator('.table-findings summary').last().innerText().catch(() => 'none') });
    note('page-errors', { errors });
  } catch (error) { note('error', { error: String(error).slice(0, 700), errors }); await shot(page, '99-error'); }
  // The scratch project and Trace data go; what the check saw is kept in <outDir>.
  finally { fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2)); await app.close().catch(() => {}); await removeFolder(root); }
})();
