const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron } = require('playwright-core');
const { artifactNames, installBaselineVersion } = require('./release-paths.cjs');
const command = promisify(execFile);
const version = require('../package.json').version;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error(message);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function nativeResult(page, method, request) {
  const result = await page.evaluate(({ method, request }) => window.codingHub[method](request), { method, request });
  assert.equal(result.ok, true, result.error?.message); return result.value;
}
(async () => {
  if (process.platform !== 'win32') throw new Error('Installed-app validation requires native Windows. Linux execution is not a passing Windows test.');
  if (process.env.GITHUB_ACTIONS !== 'true' && !process.argv.includes('--isolated-windows-vm')) throw new Error('Run this installation test in GitHub Actions or an isolated Windows VM with --isolated-windows-vm. It installs/uninstalls the application and changes that VM’s app registration.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-installed-')));
  const install = path.join(root, 'application'); const data = path.join(root, 'data'); const profile = path.join(root, 'profile'); const project = path.join(root, 'project'); const bin = path.join(root, 'bin');
  assert.equal(/\s/.test(install), false, 'Use a Windows TEMP path without spaces for the NSIS /D argument.');
  const baselineVersion = installBaselineVersion();
  const baseline = path.resolve(__dirname, '../release/baseline', artifactNames(baselineVersion)[0]);
  const candidate = path.resolve(__dirname, '../release', artifactNames(version)[0]);
  assert.notEqual(version, baselineVersion, 'Candidate must have a higher version than the baseline.');
  assert.ok(await exists(baseline), 'Build the baseline installer first.'); assert.ok(await exists(candidate), 'Build the candidate installer first.');
  await Promise.all([project, bin, data].map((folder) => fs.mkdir(folder)));
  await command('git', ['-c', 'core.hooksPath=', 'init', '-b', 'main', project]);
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
    await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
    await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
  }
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: data, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const installedExecutable = path.join(install, 'AI Coding Hub.exe'); const args = ['--user-data-dir=' + profile];
  let app; let uninstalled = false;
  const report = { baselineVersion, candidateVersion: version, platform: process.platform, passed: false, checks: [], fixtureCLIs: true, authenticatedProviderCompletion: false, publishedFeedUpdate: false, error: null };
  try {
    await command(baseline, ['/S', '/D=' + install], { timeout: 120_000 }); await waitFor(() => exists(installedExecutable), 'Baseline installer did not produce its executable.');
    report.checks.push('baseline-install');
    app = await _electron.launch({ executablePath: installedExecutable, args, env }); let page = await app.firstWindow();
    await page.waitForFunction(() => window.codingHub && document.querySelectorAll('.session-tile').length === 2);
    const status = await nativeResult(page, 'updates', { action: 'status' }); assert.equal(status.version, baselineVersion); assert.notEqual(status.phase, 'disabled');
    await nativeResult(page, 'updates', { action: 'automatic', enabled: false });
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.waitForFunction(async (directory) => { const loaded = await window.codingHub.loadWorkspace(); return loaded.ok && loaded.value.workspace?.rootDirectory === directory; }, project);
    const initial = await nativeResult(page, 'loadWorkspace'); assert.ok(initial.workspace);
    const rules = await nativeResult(page, 'hub', { action: 'rules-read', directories: [project] });
    await nativeResult(page, 'hub', { action: 'rules-save', content: 'Run project checks. Preserve APIs. Save a handoff.', revision: rules.revision, targets: rules.targets.map(({ directory, claudeHash, codexHash }) => ({ directory, claudeHash, codexHash })) });
    await nativeResult(page, 'hub', { action: 'memory-install', project: 'upgrade-fixture', directory: project });
    await nativeResult(page, 'hub', { action: 'memory-write', project: 'upgrade-fixture', title: 'Upgrade handoff', content: 'Preserve this note across installation.', author: 'human' });
    // Preferences are only written once changed; save a non-default one so upgrade and uninstall must keep it.
    await nativeResult(page, 'hub', { action: 'save-preferences', preferences: { ...await nativeResult(page, 'hub', { action: 'preferences' }), terminalFontSize: 15 } });
    for (const session of initial.workspace.sessions) {
      const run = await nativeResult(page, 'startSession', { sessionId: session.id, cwd: project, config: session.config, cols: 90, rows: 24 });
      await nativeResult(page, 'writeSession', { sessionId: run.sessionId, runId: run.runId, data: 'upgrade-data\r' });
      await page.waitForFunction(async (runId) => { const usage = await window.codingHub.hub({ action: 'usage' }); return usage.ok && usage.value.some((record) => record.runId === runId); }, run.runId);
      await nativeResult(page, 'stopSession', { sessionId: run.sessionId, runId: run.runId });
    }
    const before = {
      workspace: (await nativeResult(page, 'loadWorkspace')).workspace,
      preferences: await nativeResult(page, 'hub', { action: 'preferences' }),
      rules: await nativeResult(page, 'hub', { action: 'rules-read', directories: [project] }),
      memory: await nativeResult(page, 'hub', { action: 'memory-list', project: 'upgrade-fixture' }),
      usage: await nativeResult(page, 'hub', { action: 'usage' }),
      history: await nativeResult(page, 'listHistory'),
    };
    const counts = JSON.stringify({ history: before.history.map(({ runId, engine, exitCode }) => ({ runId, engine, exitCode })), usage: before.usage.map(({ runId, engine, input, output, eventCount }) => ({ runId, engine, input, output, eventCount })) });
    assert.equal(before.history.length, 2, counts); assert.equal(before.usage.length, 2, counts);
    const logs = await Promise.all(before.history.map((run) => nativeResult(page, 'readRunLog', { runId: run.runId })));
    for (const log of logs) assert.ok(log.text.includes('upgrade-data'));
    const instructions = await Promise.all(['CLAUDE.md', 'AGENTS.md', '.mcp.json', '.codex/config.toml'].map((file) => fs.readFile(path.join(project, file))));
    await app.close(); app = null;
    report.checks.push('installed-preload-pty-usage-history-rules-memory');
    await command(candidate, ['/S', '/D=' + install], { timeout: 120_000 });
    app = await _electron.launch({ executablePath: installedExecutable, args, env }); page = await app.firstWindow();
    await page.waitForFunction(() => window.codingHub && document.querySelectorAll('.session-tile').length === 2);
    assert.equal((await nativeResult(page, 'updates', { action: 'status' })).version, version);
    assert.equal((await nativeResult(page, 'updates', { action: 'status' })).automaticChecks, false);
    assert.deepEqual((await nativeResult(page, 'loadWorkspace')).workspace, before.workspace);
    for (const [key, request] of Object.entries({ preferences: { action: 'preferences' }, rules: { action: 'rules-read', directories: [project] }, memory: { action: 'memory-list', project: 'upgrade-fixture' }, usage: { action: 'usage' } })) assert.deepEqual(await nativeResult(page, 'hub', request), before[key]);
    assert.deepEqual(await nativeResult(page, 'listHistory'), before.history);
    for (let i = 0; i < logs.length; i++) assert.deepEqual(await nativeResult(page, 'readRunLog', { runId: before.history[i].runId }), logs[i]);
    for (const [i, file] of ['CLAUDE.md', 'AGENTS.md', '.mcp.json', '.codex/config.toml'].entries()) assert.deepEqual(await fs.readFile(path.join(project, file)), instructions[i]);
    report.checks.push('installer-upgrade-preserves-data-and-config');
    await app.close(); app = null;
    await command(path.join(install, 'Uninstall AI Coding Hub.exe'), ['/S'], { timeout: 120_000 });
    await waitFor(async () => !await exists(installedExecutable), 'Uninstaller did not remove the app executable.');
    uninstalled = true;
    for (const file of ['storage.db', 'preferences.json', 'shared-rules.json', 'updates.json', 'memory/upgrade-fixture/' + before.memory[0].id + '.json', 'telemetry/usage.db']) assert.ok(await exists(path.join(data, file)), `Uninstall removed retained data: ${file}`);
    report.checks.push('uninstall-preserves-local-data'); report.passed = true;
    console.log('PASS: native Windows installation, installed Electron/preload/PTys with fixture CLIs, version upgrade preserving workspace/history/logs/rules/preferences/memory/usage, and uninstall preserving data. Real provider authentication, Drive cloud upload, signing identity, and published-feed upgrades require separate validation.');
  } catch (error) { report.error = error.message; throw error; }
  finally {
    await app?.close().catch(() => {});
    const reportPath = path.resolve(__dirname, '../release/windows-install-report.json');
    await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    if (uninstalled) await fs.rm(root, { recursive: true, force: true }); else console.error('Installation-test files retained for diagnosis:', root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
