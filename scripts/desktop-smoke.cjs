const assert = require('node:assert/strict');
const { realpath, mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { openView, addChannel, tileControl } = require('./lib/navigate.cjs');

(async () => {
  // Canonical long form: Windows temp paths can use 8.3 short names (RUNNER~1) that the app resolves.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coding-hub-desktop-')));
  const bin = path.join(root, 'bin');
  const projects = [path.join(root, 'claude-project'), path.join(root, 'codex-project')];
  await Promise.all([bin, ...projects].map((directory) => mkdir(directory)));
  const git = (directory, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, stdio: 'pipe' });
  for (const directory of projects) git(directory, 'init', '-b', 'main');
  await mkdir(path.join(projects[0], 'src'));
  await writeFile(path.join(projects[0], 'src/main.ts'), 'export const message = "baseline";\nexport const steady = true;\n');
  await writeFile(path.join(projects[0], 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(projects[1], 'README.md'), 'Second repository independent.\n');
  for (const directory of projects) { git(directory, 'config', 'core.autocrlf', 'false'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'Desktop fixture baseline'); }
  await writeFile(path.join(projects[0], 'src/main.ts'), 'export const message = "staged";\nexport const steady = true;\n');
  git(projects[0], 'add', 'src/main.ts');
  await writeFile(path.join(projects[0], 'src/main.ts'), 'export const message = "working";\nexport const steady = true;\n');
  await writeFile(path.join(projects[0], 'scratch.md'), 'An untracked note.\n');
  await writeFile(path.join(projects[0], 'binary.bin'), Buffer.from([0, 3, 4]));
  const indexBeforeReview = await readFile(path.join(projects[0], '.git/index'));
  const fixture = await readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      const packageName = engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
      const packageRoot = path.join(bin, 'node_modules', ...packageName.split('/'));
      await mkdir(packageRoot, { recursive: true });
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, bin: { [engine]: 'fixture.cjs' } }));
      await writeFile(path.join(packageRoot, 'fixture.cjs'), fixture);
      await writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  const env = { ...process.env };
  env.CODING_HUB_STORAGE_DIR = path.join(root, 'storage');
  env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
  env.CODEX_HOME = path.join(root, 'codex-config');
  const driveFolder = path.join(root, 'drive-folder');
  await mkdir(driveFolder);
  // Electron must start in desktop mode; fixture npm shims set their own Node mode later.
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = bin + path.delimiter + (env[pathKey] ?? '');
  if (process.platform === 'linux') {
    env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
    env.XDG_CACHE_HOME = path.join(root, 'xdg-cache');
    await Promise.all([env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME].map((directory) => mkdir(directory)));
  }
  const args = [path.resolve(__dirname, '..'), '--production'];
  args.unshift('--user-data-dir=' + path.join(root, 'electron-profile'));
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  const pids = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack));
    // With no project the workspace shows the empty screen instead of channels.
    await page.waitForFunction(() => window.codingHub && document.querySelector('.tr-empty'));
    await page.getByRole('heading', { name: 'Open a project', exact: true }).waitFor();
    await page.locator('.tr-engine-row').first().waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await page.evaluate(() => {
      window.testEvents = [];
      window.codingHub.onSessionEvent((event) => window.testEvents.push(event));
    });
    // Account login works before selecting a project; fixture output is never saved as a coding run.
    await openView(page, 'Accounts & connections');
    await page.waitForFunction(() => document.querySelectorAll('.account-card button.button.primary:not(:disabled)').length >= 2);
    assert.equal(await page.getByRole('heading', { name: 'Accounts & connections', exact: true }).isVisible(), true);
    const initialAccounts = await page.evaluate(() => window.codingHub.accounts({ action: 'status' }));
    assert.equal(initialAccounts.ok, true); assert.equal(initialAccounts.value.find((item) => item.provider === 'claude').state, 'not-authenticated');
    for (const provider of ['claude', 'codex']) {
      await page.getByRole('button', { name: provider === 'claude' ? 'Connect Claude Code' : 'Connect OpenAI Codex', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.account-terminal')?.textContent.includes('READY'));
      await page.locator('.account-terminal .xterm-helper-textarea').focus();
      await page.keyboard.type('complete-login'); await page.keyboard.press('Enter');
      await page.waitForFunction((name) => [...document.querySelectorAll('.account-card')].some((card) => card.textContent.includes(name) && card.textContent.includes('Connected through local CLI')), provider === 'claude' ? 'Claude Code' : 'OpenAI Codex');
    }
    assert.equal((await page.evaluate(() => window.codingHub.listHistory())).value.length, 0);
    assert.equal((await page.evaluate(() => window.codingHub.loadWorkspace())).value.workspace, null);
    await page.getByRole('button', { name: 'Go to workspace', exact: true }).click();
    // Mock only the OS dialog selection. Everything after it uses actual native IPC and PTYs.
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, projects[0]);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    const second = page.locator('.session-tile').nth(1);
    await (await tileControl(page, 'Engine settings for session 2')).click();
    await second.getByLabel('Working directory', { exact: true }).selectOption('independent');
    await second.getByLabel('Repository path', { exact: true }).fill(projects[1]);
    await second.getByLabel('codex model', { exact: true }).fill('fixture-model');
    await (await tileControl(page, 'Engine settings for session 2')).click();
    await page.locator('.session-tile').nth(0).getByRole('button', { name: 'Start session', exact: true }).click();
    await second.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.waitForFunction(() => window.testEvents.filter((event) => event.type === 'started').length === 2);
    pids.push(...await page.evaluate(() => window.testEvents.filter((event) => event.type === 'started').map((event) => event.pid)));
    await page.waitForFunction(() => window.testEvents.filter((event) => event.type === 'data').map((event) => event.data).join('').includes('READY'));
    const first = page.locator('.session-tile').nth(0);
    await first.locator('.xterm').evaluate((element) => { window.firstTerminalElement = element; });
    await first.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('desktop-first');
    await page.keyboard.press('Enter');
    await second.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('desktop-second');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const data = window.testEvents.filter((event) => event.type === 'data').map((event) => event.data).join('');
      return data.includes('ECHO:desktop-first') && data.includes('ECHO:desktop-second');
    });
    const starts = await page.evaluate(() => window.testEvents.filter((event) => event.type === 'started'));
    assert.deepEqual(starts.map((event) => event.cwd).sort(), projects.sort());
    await (await tileControl(page, 'Engine settings for session 1')).click();
    assert.equal(await first.getByLabel('claude model', { exact: true }).isDisabled(), true);
    await (await tileControl(page, 'Engine settings for session 1')).click();
    // A file found through the command menu opens selected in Files.
    await page.keyboard.press('Control+Shift+P');
    await page.getByLabel('Search commands', { exact: true }).fill('/steady');
    await page.getByRole('option').filter({ hasText: 'main.ts' }).first().waitFor();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="File contents"]')?.textContent.includes('"working"'));
    assert.match(await page.locator('.file-preview .code-heading h2').textContent(), /src\/main\.ts$/);
    // A memory note under another project key opens selected in Shared memory.
    assert.equal((await page.evaluate(() => window.codingHub.hub({ action: 'memory-write', project: 'other-key', title: 'Menu handoff', content: 'quokka decision', author: 'human' }))).ok, true);
    await page.keyboard.press('Control+Shift+P');
    await page.getByLabel('Search commands', { exact: true }).fill('#quokka');
    await page.getByRole('option').filter({ hasText: 'Menu handoff' }).first().waitFor();
    await page.keyboard.press('Enter');
    await page.locator('.memory-history .hub-preview').getByRole('heading', { name: 'Menu handoff', exact: true }).waitFor();
    assert.equal(await page.locator('.project-key input').inputValue(), 'other-key');
    await openView(page, 'Files');
    await page.getByRole('treeitem', { name: 'Folder src', exact: true }).click();
    await page.getByRole('treeitem', { name: 'File src/main.ts', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="File contents"]')?.textContent.includes('"working"'));
    assert.equal(await page.getByRole('treeitem', { name: 'Folder .git', exact: true }).count(), 0);
    await writeFile(path.join(projects[0], 'src/main.ts'), 'export const message = "working desktop edit";\nexport const steady = true;\n');
    await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="File contents"]')?.textContent.includes('working desktop edit'));
    if (process.env.CODING_HUB_TEST_FILES_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_FILES_SCREENSHOT, fullPage: true });
    const context = await page.evaluate((directory) => window.codingHub.openRepository({ directory }), projects[0]);
    assert.equal(context.ok, true);
    const traversal = await page.evaluate((repositoryId) => window.codingHub.readFile({ repositoryId, path: '../outside' }), context.value.id);
    assert.equal(traversal.ok, false); assert.equal(traversal.error.code, 'INVALID_PATH');
    const metadata = await page.evaluate((repositoryId) => window.codingHub.readFile({ repositoryId, path: '.git/config' }), context.value.id);
    assert.equal(metadata.ok, false);
    await page.evaluate((repositoryId) => window.codingHub.closeRepository({ repositoryId }), context.value.id);
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await page.getByRole('button', { name: 'Unstaged src/main.ts', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Git diff"] .addition')?.textContent.includes('working desktop edit'));
    await page.getByRole('button', { name: 'Staged src/main.ts', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Git diff"] .addition')?.textContent.includes('"staged"'));
    assert.ok(await page.locator('.diff-line.deletion').count());
    if (process.env.CODING_HUB_TEST_DIFF_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_DIFF_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Untracked scratch.md', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Git diff"]')?.textContent.includes('An untracked note.'));
    await page.getByRole('button', { name: 'Unstaged binary.bin', exact: true }).click();
    await page.getByRole('heading', { name: 'Binary file changed', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Binary file changed', exact: true }).isVisible(), true);
    await writeFile(path.join(projects[0], 'later.md'), 'Added while the view was open.\n');
    await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await page.getByRole('button', { name: 'Untracked later.md', exact: true }).waitFor();
    const codexSession = starts.find((run) => run.engine === 'codex').sessionId;
    await page.getByLabel('Repository context', { exact: true }).selectOption(codexSession);
    await page.getByRole('heading', { name: 'Working tree is clean', exact: true }).waitFor();
    await openView(page, 'Files');
    await page.getByRole('treeitem', { name: 'File README.md', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="File contents"]')?.textContent.includes('Second repository independent.'));
    assert.deepEqual(await readFile(path.join(projects[0], '.git/index')), indexBeforeReview);
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    assert.equal(await first.locator('.xterm').evaluate((element) => element === window.firstTerminalElement), true);
    await (await tileControl(page, 'Isolate session 1')).click();
    assert.equal(await page.locator('.session-tile').count(), 1);
    assert.equal(await page.locator('.xterm').evaluate((element) => element === window.firstTerminalElement), true);
    await (await tileControl(page, 'Restore grid')).click();
    // Resize handles belong to the grid wrapper; use its first visible grip.
    const grip = await page.locator('.react-resizable-handle').first().boundingBox();
    await page.mouse.move(grip.x + 12, grip.y + 12);
    await page.mouse.down();
    await page.mouse.move(grip.x + 112, grip.y + 58, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => window.testEvents.filter((event) => event.type === 'data' && event.data.includes('SIZE:')).length >= 3);
    await page.getByRole('button', { name: 'Split vertically: columns', exact: true }).click();
    await page.keyboard.press('Control+Shift+P');
    await page.getByLabel('Search commands', { exact: true }).fill('settings');
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('heading', { name: 'Workspace settings', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: 'Application updates', exact: true }).isVisible(), true);
    assert.equal((await page.evaluate(() => window.codingHub.updates({ action: 'status' }))).value.phase, 'disabled');
    assert.equal((await page.evaluate(() => window.codingHub.updates({ action: 'check' }))).error.code, 'UPDATES_DISABLED');
    assert.equal((await page.evaluate(() => window.codingHub.updates({ action: 'check', url: 'https://untrusted.invalid' }))).error.code, 'INVALID_UPDATE_REQUEST');
    await page.getByLabel('Local Drive folder', { exact: true }).fill(driveFolder);
    await page.getByRole('button', { name: 'Add model price', exact: true }).click();
    await page.getByLabel('Rate model 1', { exact: true }).fill('fixture-model');
    await page.getByLabel('input price 1', { exact: true }).fill('2');
    await page.getByLabel('output price 1', { exact: true }).fill('10');
    await page.getByLabel('cacheRead price 1', { exact: true }).fill('1');
    await page.getByLabel('cacheWrite price 1', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Preferences saved locally.' }).waitFor();
    await openView(page, 'Usage');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.usage-table tbody tr').length === 2);
    const usage = await page.evaluate(() => window.codingHub.hub({ action: 'usage' }));
    assert.equal(usage.ok, true);
    assert.equal(usage.value.length, 2);
    assert.equal(usage.value.every((u) => u.input > 0 && u.output > 0 && u.cost > 0), true);
    assert.equal(usage.value.find((u) => u.engine === 'codex').context.limit, 1000);
    if (process.env.CODING_HUB_TEST_USAGE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_USAGE_SCREENSHOT, fullPage: true });
    await openView(page, 'Shared memory');
    await page.getByLabel('Title', { exact: true }).fill('Desktop handoff');
    await page.getByLabel('Notes', { exact: true }).fill('Validation passed; continue from the saved task.');
    await page.getByRole('button', { name: 'Save handoff', exact: true }).click();
    await page.getByRole('heading', { name: 'Desktop handoff', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Folder sync complete' }).waitFor();
    const notes = await page.evaluate(() => window.codingHub.hub({ action: 'memory-list', project: 'coding-hub' }));
    assert.equal(notes.ok, true); assert.equal(notes.value.length, 1);
    const syncedNote = JSON.parse(await readFile(path.join(driveFolder, 'AI-Coding-Hub-Memory', 'coding-hub', notes.value[0].id + '.json'), 'utf8'));
    assert.equal(syncedNote.content, 'Validation passed; continue from the saved task.');
    await page.getByRole('button', { name: 'Enable memory for both CLIs', exact: false }).click();
    await page.getByRole('button', { name: 'Install local memory server', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Memory configured for both CLIs.' }).waitFor();
    await openView(page, 'MCP servers');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.server-card').length === 2);
    await page.locator('.server-card').first().getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
    const inventory = await page.evaluate((directory) => window.codingHub.hub({ action: 'inventory', directory }), projects[0]);
    assert.equal(inventory.ok, true);
    assert.equal(inventory.value.servers.filter((s) => !s.enabled).length, 1);
    await openView(page, 'Skills & plugins');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.extension-row').length >= 2);
    await page.locator('.extension-row').first().click();
    await page.waitForFunction(() => document.querySelector('.hub-preview pre')?.textContent.includes('coding-hub-memory'));
    assert.deepEqual(await readFile(path.join(projects[0], '.git/index')), indexBeforeReview);
    await openView(page, 'Help & AI guide');
    await page.getByRole('heading', { name: 'How Trace works', exact: true }).waitFor();
    await page.getByLabel('Search help topics', { exact: true }).fill('model context protocol');
    await page.getByRole('heading', { name: 'Model Context Protocol (MCP)', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open MCP servers', exact: true }).click();
    await openView(page, 'Shared rules');
    await page.getByRole('heading', { name: 'Your shared instructions', exact: true }).waitFor();
    await page.getByLabel('Rules for both engines', { exact: true }).fill('Run relevant tests. Preserve public APIs.');
    const ruleTargets = page.locator('.rules-target input[type="checkbox"]');
    assert.equal(await ruleTargets.count(), 2);
    for (const checkbox of await ruleTargets.all()) await checkbox.uncheck();
    await page.getByRole('button', { name: 'Save and apply', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Shared rules saved locally.' }).waitFor();
    const blockedRules = await page.evaluate((cwd) => window.codingHub.startSession({ sessionId: 'rules-unapplied', cwd, config: { engine: 'codex', model: '', reasoningEffort: null }, cols: 80, rows: 24 }), projects[0]);
    assert.equal(blockedRules.ok, false); assert.equal(blockedRules.error.code, 'RULES_NOT_APPLIED');
    for (const checkbox of await ruleTargets.all()) await checkbox.check();
    await page.getByRole('button', { name: 'Save and apply', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'applied to both engines in 2 projects' }).waitFor();
    const savedRules = await page.evaluate((directories) => window.codingHub.hub({ action: 'rules-read', directories }), projects);
    assert.equal(savedRules.ok, true); assert.equal(savedRules.value.targets.every((t) => t.applied), true);
    for (const directory of projects) for (const name of ['CLAUDE.md', 'AGENTS.md']) assert.match(await readFile(path.join(directory, name), 'utf8'), /Run relevant tests. Preserve public APIs./);
    assert.match(await readFile(path.join(projects[0], 'AGENTS.md'), 'utf8'), /coding-hub-memory:start/);
    await page.getByLabel('Rules for both engines', { exact: true }).fill('Run relevant tests. Preserve public APIs. Save a handoff.');
    await page.getByRole('button', { name: 'Save and apply', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'applied to both engines in 2 projects' }).waitFor();
    assert.equal((await readFile(path.join(projects[0], 'CLAUDE.md'), 'utf8')).match(/coding-hub-rules:start/g).length, 1);
    if (process.env.CODING_HUB_TEST_RULES_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_RULES_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Read the rules guide', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared rules for both engines', exact: true }).waitFor();
    if (process.env.CODING_HUB_TEST_HELP_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_HELP_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Open Shared rules', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#shared-rules-editor')?.value === 'Run relevant tests. Preserve public APIs. Save a handoff.');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Show explorer', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Folder src', exact: true }).click();
    await page.getByRole('treeitem', { name: 'File src/main.ts', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.explorer-preview')?.textContent.includes('working desktop edit'));
    await page.getByRole('button', { name: 'Close workspace explorer', exact: true }).click();





    const invalid = await page.evaluate(() => window.codingHub.startSession({ sessionId: 'invalid', cwd: '/', executable: 'shell', config: { engine: 'codex', model: '', reasoningEffort: null }, cols: 80, rows: 24 }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'INVALID_REQUEST');
    const stale = await page.evaluate((run) => window.codingHub.writeSession({ sessionId: run.sessionId, runId: '00000000-0000-4000-8000-000000000000', data: 'bad' }), starts[0]);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'STALE_SESSION');
    // Wait for grid transitions and assert the restored two-column layout does not overlap.
    await page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll('.session-tile')].map((tile) => tile.getBoundingClientRect());
      return tiles.length === 2 && tiles[0].right <= tiles[1].left && Math.abs(tiles[0].top - tiles[1].top) < 2;
    });
    if (process.env.CODING_HUB_TEST_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_TEST_SCREENSHOT, fullPage: true });
    await first.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('spawn-child'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /CHILD:\d+/.test(window.testEvents.filter((event) => event.type === 'data').map((event) => event.data).join('')));
    const childPid = await page.evaluate(() => Number(window.testEvents.filter((event) => event.type === 'data').map((event) => event.data).join('').match(/CHILD:(\d+)/)[1]));
    await (await tileControl(first, 'Stop')).click();
    const stoppedRun = starts.find((run) => run.engine === 'claude');
    await page.waitForFunction((runId) => window.testEvents.some((event) => event.type === 'exit' && event.runId === runId), stoppedRun.runId);
    assert.throws(() => process.kill(stoppedRun.pid, 0));
    assert.throws(() => process.kill(childPid, 0));
    // A stopped channel's Review changes opens Changes on that channel's own repository context.
    await first.getByRole('button', { name: /^Review changes/ }).click();
    await page.getByLabel('Repository context', { exact: true }).waitFor();
    assert.match(await page.getByLabel('Repository context', { exact: true }).locator('option:checked').textContent(), /^Session 1 · /);
    await openView(page, 'Workspace');
    await (await tileControl(first, 'Restart')).click();
    await page.waitForFunction(() => window.testEvents.filter((event) => event.type === 'started').length === 3);
    pids.push(...await page.evaluate(() => window.testEvents.filter((event) => event.type === 'started').slice(2).map((event) => event.pid)));
    await openView(page, 'Session history');
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.history-run').length === 3);
    const recorded = await page.evaluate(() => window.codingHub.listHistory());
    assert.equal(recorded.ok, true);
    const ended = recorded.value.find((run) => run.status === 'completed');
    assert.ok(ended);
    const output = await page.evaluate((runId) => window.codingHub.readRunLog({ runId }), ended.runId);
    assert.equal(output.ok, true);
    assert.match(output.value.text, /ECHO:desktop-first/);
    if (process.platform !== 'win32') assert.match(output.value.text, /FINAL:fixture shutdown/);
    else assert.match(output.value.text, /ECHO:desktop-first/);
    assert.equal(output.value.text.includes('\x1b'), false);
    const invalidLog = await page.evaluate(() => window.codingHub.readRunLog({ runId: '../../other' }));
    assert.equal(invalidLog.ok, false);
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    // Deliberately close immediately after a layout change; the host requests a final snapshot.
    await page.getByRole('button', { name: 'Split horizontally: rows', exact: true }).click();
    assert.deepEqual(errors, []);
    await app.close();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    const restored = await app.firstWindow();
    restored.on('pageerror', (error) => errors.push(error.stack));
    await restored.waitForFunction(() => document.querySelectorAll('.session-tile').length === 2);
    assert.equal(await restored.getByRole('button', { name: 'Start session', exact: true }).count(), 2);
    const saved = await restored.evaluate(() => window.codingHub.loadWorkspace());
    assert.equal(saved.ok, true);
    assert.equal(saved.value.workspace.rootDirectory, projects[0]);
    assert.equal(saved.value.workspace.layoutMode, 'rows');
    assert.equal(saved.value.workspace.sessions[1].config.model, 'fixture-model');
    assert.deepEqual(saved.value.workspace.sessions[1].binding, { mode: 'independent', cwd: projects[1] });
    assert.equal(saved.value.workspace.sessions.some((item) => 'pid' in item || 'runId' in item), false);
    const restoredRules = await restored.evaluate((directories) => window.codingHub.hub({ action: 'rules-read', directories }), projects);
    assert.equal(restoredRules.ok, true); assert.equal(restoredRules.value.content, 'Run relevant tests. Preserve public APIs. Save a handoff.'); assert.equal(restoredRules.value.targets.every((t) => t.applied), true);
    const restoredNotes = await restored.evaluate(() => window.codingHub.hub({ action: 'memory-list', project: 'coding-hub' }));
    assert.equal(restoredNotes.ok, true); assert.equal(restoredNotes.value.length, 1);
    const restoredUsage = await restored.evaluate(() => window.codingHub.hub({ action: 'usage' }));
    assert.equal(restoredUsage.ok, true); assert.ok(restoredUsage.value.length >= 2);
    const restoredPreferences = await restored.evaluate(() => window.codingHub.hub({ action: 'preferences' }));
    assert.equal(restoredPreferences.ok, true); assert.equal(restoredPreferences.value.driveDirectory, driveFolder);
    const history = await restored.evaluate(() => window.codingHub.listHistory());
    assert.equal(history.ok, true);
    assert.equal(history.value.length, 3);
    assert.equal(history.value.every((run) => run.status === 'completed'), true);
    await openView(restored, 'Session history');
    await restored.waitForFunction(() => document.querySelectorAll('.history-run').length === 3);
    // Concurrent engine discovery can change start order. Select the original
    // Claude run by identity rather than assuming it is the oldest list entry.
    const originalClaudeIndex = history.value.findIndex((run) => run.runId === starts.find((run) => run.engine === 'claude').runId);
    assert.ok(originalClaudeIndex >= 0);
    await restored.locator('.history-run').nth(originalClaudeIndex).click();
    await restored.waitForFunction(() => document.querySelector('pre[aria-label="Saved terminal output"]')?.textContent.includes('ECHO:desktop-first'));
    // Exercise v1.2 workflows against the production bridge and visible UI.
    await restored.getByRole('button', { name: 'Restore launch settings to a session', exact: true }).click();
    await restored.getByRole('button', { name: 'Confirm restore', exact: true }).click();
    assert.equal(await restored.locator('.session-tile').count(), 3);
    assert.equal(await restored.getByRole('button', { name: 'Start session', exact: true }).count(), 3);
    await restored.keyboard.press('F1');
    assert.equal(await restored.getByRole('heading', { name: 'Help & AI guide', exact: true }).isVisible(), true);
    await openView(restored, 'Settings');
    await restored.getByLabel('Interface scale', { exact: true }).selectOption('110');
    await restored.getByLabel('Information density', { exact: true }).selectOption('compact');
    await restored.getByLabel('Higher contrast', { exact: true }).check();
    assert.equal(await restored.evaluate(() => document.documentElement.dataset.density), 'compact');
    assert.equal(await restored.evaluate(() => document.documentElement.dataset.contrast), 'high');
    await restored.getByLabel('Interface scale', { exact: true }).selectOption('100');
    await restored.keyboard.press('Alt+1');
    await restored.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    const tree = await restored.evaluate((directory) => window.codingHub.projectTools({ action: 'worktree-create', directory }), projects[0]);
    assert.equal(tree.ok, true); assert.ok(tree.value.branch.startsWith('coding-hub/'));
    assert.equal(await readFile(path.join(tree.value.directory, 'src/main.ts'), 'utf8'), 'export const message = "baseline";\nexport const steady = true;\n');
    const removed = await restored.evaluate((id) => window.codingHub.projectTools({ action: 'worktree-remove', id }), tree.value.id); assert.equal(removed.ok, true);
    await writeFile(path.join(projects[0], 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(456)"' } }));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const check = await restored.evaluate((directory) => window.codingHub.projectChecks({ action: 'run', directory, script: 'test' }), projects[0]);
    assert.equal(check.ok, true); assert.equal(check.value.exitCode, 0); assert.ok(check.value.output.includes('456'));
    const audit = await restored.evaluate((directory) => window.codingHub.projectChecks({ action: 'inspect', directory }), projects[0]);
    assert.equal(audit.ok, true); assert.equal(audit.value.rulesApplied, true);
    await openView(restored, 'Shared memory');
    await restored.getByLabel('Search handoffs', { exact: true }).fill('no-such-handoff');
    assert.equal(await restored.getByRole('heading', { name: 'No matching handoffs', exact: true }).isVisible(), true);
    await restored.getByLabel('Search handoffs', { exact: true }).fill('');
    await restored.locator('.memory-history .extension-row').first().click();
    await restored.getByRole('button', { name: 'Revise as a new handoff', exact: true }).click();
    await restored.getByLabel('Notes', { exact: true }).fill('Revised handoff from desktop smoke.');
    await restored.getByRole('button', { name: 'Save handoff', exact: true }).click();
    await restored.waitForFunction(() => document.querySelectorAll('.memory-history .extension-row').length === 2);
    const revisions = await restored.evaluate(() => window.codingHub.hub({ action: 'memory-list', project: 'coding-hub' }));
    assert.equal(revisions.ok, true); assert.ok(revisions.value.some((note) => note.supersedes));
    // A note under the default key, opened from another view, stays selected once Shared memory loads.
    await openView(restored, 'Files');
    await restored.keyboard.press('Control+Shift+P');
    await restored.getByLabel('Search commands', { exact: true }).fill('#Revised handoff from desktop');
    await restored.getByRole('option').first().waitFor();
    await restored.keyboard.press('Enter');
    await restored.waitForFunction(() => document.querySelector('.memory-history .hub-preview pre')?.textContent === 'Revised handoff from desktop smoke.');
    assert.ok(restoredUsage.value.every((usage) => usage.source && usage.confidence === 'reported'));
    await restored.getByRole('button', { name: 'Projects', exact: true }).click();
    await restored.getByLabel('Existing folder path', { exact: true }).fill(projects[0]);
    await restored.getByRole('button', { name: 'Open this path', exact: true }).click();
    assert.equal(await restored.locator('.session-tile').count(), 3);
    await restored.getByRole('button', { name: 'Projects', exact: true }).click();
    await restored.getByLabel('Project parent folder', { exact: true }).fill(root);
    await restored.getByLabel('New project name', { exact: true }).fill('new-desktop-project');
    await restored.getByLabel('Initialize a Git repository (requires Git)', { exact: true }).uncheck();
    await restored.getByRole('button', { name: 'Create and open project', exact: true }).click();
    await restored.waitForFunction(() => document.querySelector('.tr-detail-facts')?.textContent.includes('new-desktop-project'));
    assert.equal((await restored.evaluate(() => window.codingHub.loadWorkspace())).value.workspace.rootDirectory, path.join(root, 'new-desktop-project'));
    if (process.env.CODING_HUB_TEST_SCREENSHOT) await restored.screenshot({ path: process.env.CODING_HUB_TEST_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
    await app.close();
    const blockedStorage = path.join(root, 'not-a-directory');
    await writeFile(blockedStorage, 'Preserve this existing file.');
    app = await _electron.launch({ executablePath: require('electron'), args, env: { ...env, CODING_HUB_STORAGE_DIR: blockedStorage } });
    const degraded = await app.firstWindow();
    degraded.on('pageerror', (error) => errors.push(error.stack));
    await degraded.waitForFunction(() => document.querySelectorAll('.session-tile').length === 2);
    assert.equal(await degraded.getByRole('alert').count(), 1);
    const unavailable = await degraded.evaluate(() => window.codingHub.loadWorkspace());
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, 'STORAGE_UNAVAILABLE');
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, projects[0]);
    await degraded.getByRole('button', { name: 'Open project', exact: true }).click();
    await degraded.locator('.session-tile').first().getByRole('button', { name: 'Start session', exact: true }).click();
    await degraded.waitForFunction(() => document.querySelector('.session-tile[data-status="running"]'));
    await app.close();
    assert.equal(await readFile(blockedStorage, 'utf8'), 'Preserve this existing file.');
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/preload, real PTYs, input/resize/retention/cleanup, SQLite restoration/history, unavailable storage, native file tree/preview/refresh, path rejection, staged/unstaged/untracked/binary Git review, independent repositories, an unchanged Git index, live structured usage/cost, MCP toggles, skill inspection, local handoffs, Drive folder sync, restored integration state, searchable AI help, shared rules for both engines, launch blocking for unapplied rules, update bridge/source edition status, isolated worktrees, recovery settings, project checks, memory revisions/search, usage provenance, accessibility controls, account login without a workspace, private login output excluded from history, typed folder selection, and new local project setup.');
  } catch (error) {
    // Print what the visible terminals and alerts said, so a CI failure shows the CLI's own error.
    try {
      const windows = app ? app.windows() : [];
      for (const window of windows) console.error('Visible state at failure:\n' + await window.evaluate(() => [...document.querySelectorAll('.account-terminal, .xterm-rows, [role="alert"], .session-error')].map((node) => `[${node.className || node.getAttribute('role')}] ${node.textContent.trim().slice(-1500)}`).join('\n')));
    } catch { /* The window may already be gone. */ }
    // Resize diagnostics: size reports so far, then a direct resize of the first running session.
    try {
      const window = app && app.windows()[0];
      if (window) console.error('Resize probe:', JSON.stringify(await window.evaluate(async () => {
        const sizes = () => (window.testEvents ?? []).filter((event) => event.type === 'data' && event.data.includes('SIZE:')).map((event) => event.data.match(/SIZE:\d+x\d+/g)).flat();
        const before = sizes(); const started = (window.testEvents ?? []).filter((event) => event.type === 'started');
        const run = started[0]; if (!run) return { before, note: 'no started session' };
        const result = await window.codingHub.resizeSession({ sessionId: run.sessionId, runId: run.runId, cols: 61, rows: 17 });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { before, resize: result.ok ? 'ok' : result.error, after: sizes() };
      })));
    } catch (resizeError) { console.error('Resize probe failed:', resizeError); }
    // Compare how Electron-as-Node behaves inside a pseudoconsole with and without the launch bootstrap.
    try {
      const probe = path.join(root, 'pty-probe.cjs'); await writeFile(probe, 'process.stdout.write("PROBE-READY " + (process.env.ELECTRON_RUN_AS_NODE ?? "cleared") + "\\n"); setTimeout(() => process.exit(0), 300);');
      console.error('PTY probe:', JSON.stringify(await app.evaluate(async (_electron, [file, appRoot]) => {
        const pty = process.getBuiltinModule('node:module').createRequire(appRoot + '/package.json')('node-pty');
        const run = (args) => new Promise((resolve) => { let out = ''; const term = pty.spawn(process.execPath, args, { cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); term.onData((data) => { out += data; }); const timer = setTimeout(() => { try { term.kill(); } catch { /* Gone. */ } resolve({ out: out.slice(-400), timedOut: true }); }, 8000); term.onExit((event) => { clearTimeout(timer); resolve({ out: out.slice(-400), exitCode: event.exitCode }); }); });
        return { plain: await run([file]), bootstrap: await run(['--import=data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE', file]) };
      }, [probe, path.resolve(__dirname, '..')])));
    } catch (probeError) { console.error('PTY probe failed:', probeError); }
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
