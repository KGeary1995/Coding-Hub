// Launches a packaged app (the path to its executable is the argument) with a fixture Claude CLI, opens a project and
// starts a channel, and waits for the CLI's output. It proves the packaged terminal binding and helper really start a
// CLI, which is what failed on macOS when spawn-helper was not executable.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
(async () => {
  const executable = process.argv[2]; if (!executable) throw new Error('Usage: node scripts/packaged-smoke.cjs <packaged app executable>');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-packaged-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), PATH: bin + path.delimiter + process.env.PATH }; delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(root, 'profile')];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  try {
    app = await _electron.launch({ executablePath: executable, args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForSelector('.tr-empty, .session-tile');
    assert.equal(await page.evaluate(async () => (await window.codingHub.workbench({ action: 'runtime' })).value.edition), 'installed');
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    await page.evaluate(() => { window.events = []; window.codingHub.onSessionEvent((event) => window.events.push(event)); });
    await page.locator('.session-tile').first().getByRole('button', { name: 'Start session', exact: true }).click();
    await page.waitForFunction(() => window.events.some((event) => event.type === 'data' && event.data.includes('READY')));
    assert.equal(await page.evaluate(() => window.events.some((event) => event.type === 'exit')), false, 'the CLI exited instead of running');
    console.log(`PASS: packaged app (${path.basename(executable)}) starts a CLI in a real terminal.`);
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
