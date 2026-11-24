const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The background runner end to end (docs/background-runner.md): a channel started in Trace keeps running when Trace's
// main process is killed (a crash), and the Trace opened next takes it up, with what it wrote before, and types into it.
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-runner-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  const env = { ...process.env, ...NO_DRIVE, CODING_HUB_RUNNER: '1', CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  const open = async () => { const app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(30000); return { app, page }; };
  const channel = (page) => page.locator('.session-tile').filter({ has: page.getByRole('status', { name: /^Channel 2 / }) });
  const type = async (page, text) => { await channel(page).locator('.xterm-helper-textarea').focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  let app;
  try {
    ({ app } = await open()); let page = await app.firstWindow();
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await page.waitForSelector('.session-tile');
    await channel(page).getByRole('button', { name: 'Start channel', exact: true }).click();
    await channel(page).locator('.xterm-rows').filter({ hasText: 'READY' }).waitFor();
    await type(page, 'before-crash'); await channel(page).locator('.xterm-rows').filter({ hasText: 'ECHO:before-crash' }).waitFor();
    console.log('a channel runs in the background runner');

    // Trace's main process is killed, as in a crash: nothing of Trace's shutdown runs.
    // Only the main process, by its id (not its tree, which a crash would not take either). Playwright's kill() was
    // seen to report an exit while the main process ran on, holding the single-instance lock.
    const mainPid = await app.evaluate(() => process.pid); app.process().removeAllListeners(); try { process.kill(mainPid, 'SIGKILL'); } catch { /* Gone. */ }
    for (let i = 0; i < 100 && alive(mainPid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(mainPid), false, 'the main process was killed'); app = null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (process.env.RUNNER_SMOKE_DEBUG) console.log(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${path.basename(root)}*' -or $_.Name -like 'Trace Runner*' } | % { "$($_.ProcessId) $($_.Name) $($_.CommandLine.Substring(0, [Math]::Min(160, $_.CommandLine.Length)))" }`]).toString());

    ({ app, page } = await open());
    // The channel is taken up, not started again: what it wrote before is on screen, and it answers.
    await channel(page).locator('.xterm-rows').filter({ hasText: 'ECHO:before-crash' }).waitFor();
    await type(page, 'after-reopen'); await channel(page).locator('.xterm-rows').filter({ hasText: 'ECHO:after-reopen' }).waitFor();
    assert.equal(await channel(page).getByRole('button', { name: 'Start channel', exact: true }).count(), 0, 'the channel shows as running');
    console.log('the Trace opened next took the channel up, with its screen, and typed into it');

    await channel(page).getByRole('button', { name: 'Stop CH2', exact: true }).click();
    await channel(page).getByRole('button', { name: 'Start channel', exact: true }).waitFor();
    console.log('runner desktop smoke passed');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    await app?.close().catch(() => {});
    // The runner, and anything a failed run left in it: found by the pid it logged when it began listening.
    const log = await fs.readFile(path.join(root, 'storage', 'runner', 'runner.log'), 'utf8').catch(() => '');
    for (const [, pid] of log.matchAll(/listening, pid (\d+)/g)) try { if (process.platform === 'win32') require('node:child_process').execFileSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); else process.kill(Number(pid), 'SIGKILL'); } catch { /* Gone. */ }
    await removeFolder(root).catch(() => {});
  }
})();
