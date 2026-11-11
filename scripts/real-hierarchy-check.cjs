// Manual check, not part of CI: a hierarchy Round Table with the real CLIs on your own logins (Fable 5.2 plans and gives
// the final review, Opus 5.5 builds and fixes, Codex reviews), in the built app, on a scratch project and scratch Trace
// data. A task is given, the plan approved, Trace quit part way, reopened and continued, until the planner approves.
// Uses some of your Claude and Codex plans. Usage: npm run build && node scripts/real-hierarchy-check.cjs <outDir> [--reject-once]
// --reject-once: the task asks the planner to send its first final review back (CHANGES NEEDED), to run the loop back
// through Fix and Codex's review; the restart part is skipped.
// --revise-and-models: sets the planner's model to Sonnet 5.5 on the bar and restarts the table, sends the plan back with
// a change, approves the revised plan, stops once Codex reviews, and reads Claude Code's transcripts for the models used.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { _electron } = require(path.join(repo, 'node_modules/playwright-core'));
const { tileControl } = require('./lib/navigate.cjs');
const out = path.resolve(process.argv[2] ?? 'real-hierarchy'); const rejectOnce = process.argv.includes('--reject-once'); const reviseAndModels = process.argv.includes('--revise-and-models'); fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-chain-'))); const project = path.join(root, 'project'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, stdio: 'pipe' });
git('init', '-q'); fs.writeFileSync(path.join(project, 'README.md'), '# Scratch\n'); git('add', '.'); git('commit', '-qm', 'base');
const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage') }; delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
const args = ['--user-data-dir=' + path.join(root, 'profile'), repo, '--production'];
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data).slice(0, 400)); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {}); };
async function launch() {
  const app = await _electron.launch({ executablePath: require(path.join(repo, 'node_modules/electron')), args, env });
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  page.setDefaultTimeout(60000); return { app, page };
}
const bar = (page) => page.locator('.chain-bar').innerText().catch(() => '');
const allowAll = async (page) => { let n = 0; for (const button of await page.locator('button.button.primary', { hasText: /^Allow$/ }).all()) if (await button.isVisible().catch(() => false)) { await button.click().catch(() => {}); n++; } return n; };
async function until(page, test, minutes, label) {
  const end = Date.now() + minutes * 60000; let seen = ''; let allowed = 0;
  while (Date.now() < end) { allowed += await allowAll(page); const text = await bar(page); const status = (await page.locator('.chain-bar .table-status').innerText().catch(() => '')).trim(); if (status !== seen) { seen = status; note(`${label}:status`, { status }); } if (test(text)) return { text, allowed }; await page.waitForTimeout(3000); }
  return { text: await bar(page), allowed, timedOut: true };
}
(async () => {
  let { app, page } = await launch();
  try {
    await page.waitForSelector('.tr-empty, .session-tile'); await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Round Table (hierarchy)', exact: true }).click();
    await page.waitForSelector('.chain-bar', { timeout: 240000 }); await shot(page, '01-open'); note('open', { bar: await bar(page) });
    const box = page.getByRole('textbox', { name: 'Message to the Round Table' });
    if (reviseAndModels) {
      // The planner's model, changed on the bar, is used once the table starts again.
      // Models change while the channel is stopped (a running seat keeps its model).
      const tile = page.locator('.session-tile').filter({ hasText: 'Round Table' }); await (await tileControl(tile, 'Stop')).click(); await page.waitForTimeout(3000);
      await page.locator('.chain-models summary').click(); const field = page.getByLabel('Planner model'); await field.waitFor(); await page.waitForFunction(() => !document.querySelector('[aria-label="Planner model"]')?.disabled, null, { timeout: 30000 }).catch(() => {});
      await field.fill('claude-sonnet-5-5'); await field.press('Tab'); note('model-set', { label: await page.locator('.chain-models').innerText() });
      // A stopped channel offers Restart in its detail row.
      await (await tileControl(tile, 'Restart')).click();
      await page.waitForFunction(() => document.querySelector('.chain-bar .table-status')?.textContent?.includes('Give it a task'), null, { timeout: 240000 }); note('restarted', { bar: await bar(page) });
      await box.fill('Create hello.txt containing the word hello.'); await box.press('Enter');
      let r = await until(page, (text) => /plan is ready/i.test(text), 10, 'plan'); note('plan', r); await shot(page, '02-plan');
      await box.fill('Also add a line to README.md saying that hello.txt exists.'); await box.press('Enter');
      r = await until(page, (text) => /Plan…|planning/i.test(text) && !/plan is ready/i.test(text), 2, 'revising'); note('revising', r);
      r = await until(page, (text) => /plan is ready/i.test(text), 10, 'revised'); note('revised', r);
      const planner = await page.locator('.chat-thread').innerText(); note('revised-plan-mentions-readme', { yes: /README/i.test(planner.slice(-4000)) }); await shot(page, '03-revised');
      await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
      r = await until(page, (text) => /Codex reviewing|Approved by|Stopped|Needs you/i.test(text), 15, 'build'); note('built', r);
      await page.getByRole('button', { name: 'Stop', exact: true }).first().click().catch(() => {}); await page.waitForTimeout(3000);
      // Which model each Claude seat ran on, from Claude Code's own transcripts of this project.
      const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
      const sessions = fs.existsSync(projects) ? fs.readdirSync(projects).filter((name) => name.endsWith('.jsonl')).map((name) => { const lines = fs.readFileSync(path.join(projects, name), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
        const first = lines.find((entry) => entry.type === 'user' && typeof entry.message?.content === 'string')?.message.content ?? lines.find((entry) => entry.type === 'user')?.message?.content?.[0]?.text ?? '';
        return { role: /\[Step: plan|You are the planner/.test(first) ? 'planner' : /\[Step: implement|You are the builder/.test(first) ? 'builder' : 'other', models: [...new Set(lines.filter((entry) => entry.type === 'assistant').map((entry) => entry.message?.model).filter(Boolean))] }; }) : [];
      note('models', { sessions });
      return;
    }
    await box.fill(rejectOnce ? 'Create hello.txt containing the word hello, and a test.sh that checks it. Planner: in your first final review, end with CHANGES NEEDED: add a one-line comment at the top of test.sh saying what it checks. In your next final review, approve if that comment is there.' : 'Create hello.txt containing the word hello, and a test.sh that checks it.'); await box.press('Enter');
    let r = await until(page, (text) => /plan is ready/i.test(text), 10, 'plan'); note('plan', r); await shot(page, '02-plan');
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
    r = await until(page, (text) => /Codex reviewing|Approved by|Stopped|Needs you/i.test(text), 15, 'build'); note('built', r); await shot(page, '03-reviewing');
    if (rejectOnce) {
      r = await until(page, (text) => /Approved by|Needs you|planner still asks|without APPROVED/i.test(text), 40, 'finish'); note('finished', r); await shot(page, '05-finished');
      note('files', { test: fs.existsSync(path.join(project, 'test.sh')) ? fs.readFileSync(path.join(project, 'test.sh'), 'utf8').split('\n').slice(0, 3) : null });
      return;
    }
    // Quit part way, reopen, start the table again, and continue where it stopped.
    await page.waitForTimeout(2500); await app.close(); ({ app, page } = await launch());
    await page.waitForSelector('.session-tile'); const tile = page.locator('.session-tile').filter({ hasText: 'Round Table' });
    await tile.getByRole('button', { name: /^Start/ }).first().click();
    r = await until(page, (text) => /Continue|Approved by|Give it a task/i.test(text), 6, 'reopen'); note('reopened', r); await shot(page, '04-reopened');
    const cont = page.getByRole('button', { name: 'Continue', exact: true }); if (await cont.isVisible().catch(() => false)) await cont.click();
    r = await until(page, (text) => /Approved by|Needs you|planner still asks|without APPROVED/i.test(text), 25, 'finish'); note('finished', r); await shot(page, '05-finished');
    note('files', { hello: fs.existsSync(path.join(project, 'hello.txt')) ? fs.readFileSync(path.join(project, 'hello.txt'), 'utf8').slice(0, 80) : null, test: fs.existsSync(path.join(project, 'test.sh')) });
    note('findings', { text: await page.locator('.table-findings summary').innerText().catch(() => 'none') });
  } catch (error) { note('error', { error: String(error).slice(0, 500) }); await shot(page, '99-error'); }
  finally { fs.writeFileSync(path.join(out, 'log.json'), JSON.stringify(log, null, 2)); await app.close().catch(() => {}); }
})();
