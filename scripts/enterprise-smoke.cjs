const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { openView, addChannel } = require('./lib/navigate.cjs');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-enterprise-')));
  const bin = path.join(root, 'bin'), project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      const folder = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(folder, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "console.log(12345)"' } }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'pipe' });
  await fs.mkdir(path.join(project, 'src')); await fs.writeFile(path.join(project, 'src/app.txt'), 'edit');
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app; const errors = [];
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Live design</h1><script>window.live=true;fetch("https://example.invalid/").catch(()=>window.blocked=true)</script>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const native = async (page, method, request) => { const result = await page.evaluate(({ method, request }) => window.codingHub[method](request), { method, request }); assert.equal(result.ok, true, result.error?.message); return result.value; };
  const wb = (page, request) => native(page, 'workbench', request);
  async function launch() {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await page.evaluate(() => { window.events = []; window.usages = []; window.codingHub.onSessionEvent((e) => window.events.push(e)); window.codingHub.onUsage((e) => window.usages.push(e)); });
    return page;
  }
  try {
    let page = await launch();
    const runtime = await wb(page, { action: 'runtime' }); assert.equal(runtime.version, require('../package.json').version); assert.equal(runtime.storagePath, env.CODING_HUB_STORAGE_DIR);
    const diagnostic = await wb(page, { action: 'diagnose', engine: 'codex', directory: project });
    assert.equal(diagnostic.steps.find((s) => s.name === 'Interactive terminal transport').state, 'passed');
    assert.equal(diagnostic.steps.find((s) => s.name === 'Provider and model completion').state, 'unverified');
    await fs.mkdir(env.CODEX_HOME, { recursive: true }); await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), 'model = [secret-invalid');
    const malformed = await wb(page, { action: 'diagnose', engine: 'codex', directory: project }); assert.equal(malformed.steps.find((s) => s.name === 'Local configuration syntax').state, 'failed'); assert.ok(!JSON.stringify(malformed).includes('secret-invalid')); await fs.unlink(path.join(env.CODEX_HOME, 'config.toml'));
    const config = { engine: 'codex', model: '', reasoningEffort: null };
    const original = await native(page, 'startSession', { sessionId: randomUUID(), cwd: project, config, cols: 80, rows: 24 });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.data?.includes('READY')), original.runId);
    await native(page, 'writeSession', { sessionId: original.sessionId, runId: original.runId, data: 'first task\r' });
    await page.waitForFunction((id) => window.usages.some((u) => u.runId === id && u.input === 100), original.runId);
    // Codex reports an approval request as an OSC 9 notification in its output.
    await native(page, 'writeSession', { sessionId: original.sessionId, runId: original.runId, data: 'need-approval\r' });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.type === 'attention' && e.message === 'Approval requested: npm test'), original.runId);
    await native(page, 'stopSession', { sessionId: original.sessionId, runId: original.runId });
    const conversations = await wb(page, { action: 'native-list' }); const conversation = conversations.find((c) => c.engine === 'codex'); assert.ok(conversation); assert.equal(conversation.directory, project);
    assert.equal((await wb(page, { action: 'native-resume', key: conversation.key })).directory, project);
    const resumed = await native(page, 'startSession', { sessionId: randomUUID(), cwd: project, config: { ...config, resumeId: conversation.id }, cols: 80, rows: 24 });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.data?.includes('RESUMING:')), resumed.runId);
    const duplicate = await page.evaluate((request) => window.codingHub.startSession(request), { sessionId: randomUUID(), cwd: project, config: { ...config, resumeId: conversation.id }, cols: 80, rows: 24 }); assert.equal(duplicate.ok, false);
    await native(page, 'writeSession', { sessionId: resumed.sessionId, runId: resumed.runId, data: 'second task\r' });
    await page.waitForFunction((id) => window.usages.some((u) => u.runId === id && u.input === 100 && u.output === 25), resumed.runId);
    await native(page, 'stopSession', { sessionId: resumed.sessionId, runId: resumed.runId });
    const claudeConfig = { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } };
    const claudeRun = await native(page, 'startSession', { sessionId: randomUUID(), cwd: project, config: claudeConfig, cols: 80, rows: 24 });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.data?.includes('READY')), claudeRun.runId);
    await native(page, 'writeSession', { sessionId: claudeRun.sessionId, runId: claudeRun.runId, data: 'claude task\r' });
    await page.waitForFunction((id) => window.usages.some((u) => u.runId === id && u.input === 100), claudeRun.runId);
    // Claude reports a permission prompt through the HTTP Notification hook the app adds at launch.
    await native(page, 'writeSession', { sessionId: claudeRun.sessionId, runId: claudeRun.runId, data: 'need-approval\r' });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.type === 'attention' && e.message === 'Claude needs your permission to use Bash'), claudeRun.runId);
    await native(page, 'stopSession', { sessionId: claudeRun.sessionId, runId: claudeRun.runId });
    assert.ok((await wb(page, { action: 'native-list' })).some((c) => c.engine === 'claude' && c.id === claudeRun.runId));
    const claudeResume = await native(page, 'startSession', { sessionId: randomUUID(), cwd: project, config: { ...claudeConfig, resumeId: claudeRun.runId }, cols: 80, rows: 24 });
    await page.waitForFunction((id) => window.events.some((e) => e.runId === id && e.data?.includes('RESUMING:')), claudeResume.runId);
    await native(page, 'writeSession', { sessionId: claudeResume.sessionId, runId: claudeResume.runId, data: 'resumed claude task\r' });
    await page.waitForFunction((id) => window.usages.some((u) => u.runId === id && u.input === 100 && u.cached === 20), claudeResume.runId);
    await native(page, 'stopSession', { sessionId: claudeResume.sessionId, runId: claudeResume.runId });
    const profile = await wb(page, { action: 'verification-save', name: 'Fixture check', directory: project, steps: [{ label: 'Check', tool: 'npm', args: ['run', 'check'] }], timeoutSeconds: 15 });
    const verification = await wb(page, { action: 'verification-run', id: profile.id }); assert.equal(verification.passed, true); assert.ok(verification.steps[0].output.includes('12345'));
    const taskRequest = { action: 'task-save', title: 'Frontend', directory: project, sessionId: null, scope: ['src/**'], status: 'active', notes: '', verificationId: null };
    const task = await wb(page, taskRequest); await wb(page, { ...taskRequest, title: 'Styles', scope: ['src/app.txt'] });
    const audit = await wb(page, { action: 'task-audit' }); assert.equal(audit.overlaps.length, 1); assert.ok(audit.changes.some((c) => c.path === 'src/app.txt' && c.tasks.length === 2));
    await wb(page, { ...taskRequest, id: task.id, status: 'done', notes: 'Fixture check passed; reviewed src/app.txt', verificationId: verification.id });
    const experiment = await wb(page, { action: 'experiment-save', name: 'Scope comparison', hypothesis: 'Explicit scope reduces rework', criterion: 'Verified result', promptA: 'Fix it', promptB: 'Fix src/app.txt and run the check' });
    await wb(page, { action: 'trial-add', experimentId: experiment.id, variant: 'A', runId: original.runId, minutes: 5, rework: 1, outcome: 'partial', evidence: 'Fixture measured run' });
    await wb(page, { action: 'trial-add', experimentId: experiment.id, variant: 'B', runId: resumed.runId, minutes: 3, rework: 0, outcome: 'successful', evidence: 'Passing fixture verification' });
    assert.equal((await wb(page, { action: 'experiment-list' })).trials.length, 2);
    const previewEvent = app.waitForEvent('window'); await wb(page, { action: 'preview-open', url }); const previewWindow = await previewEvent;
    await previewWindow.waitForFunction(() => window.live && window.blocked); assert.equal(await previewWindow.evaluate(() => typeof window.codingHub), 'undefined'); assert.equal(await previewWindow.evaluate(() => typeof window.require), 'undefined');
    const capture = await wb(page, { action: 'preview-capture', title: 'Live dashboard', notes: 'Local dev preview', projectDirectory: project }); assert.equal(capture.snapshot.kind, 'image'); assert.ok(capture.content.length > 100);
    await wb(page, { action: 'annotation-add', snapshotId: capture.snapshot.id, x: 40, y: 25, text: 'Improve spacing' });
    const feedback = await wb(page, { action: 'design-feedback', snapshotId: capture.snapshot.id }); assert.ok((await fs.readFile(path.join(feedback.directory, 'DESIGN_FEEDBACK.md'), 'utf8')).includes('Improve spacing'));
    // The feedback folder is registered with the current shared rules (empty rules need no instruction file).
    const feedbackRules = await page.evaluate((directory) => window.codingHub.hub({ action: 'rules-read', directories: [directory] }), feedback.directory);
    assert.equal(feedbackRules.ok, true); assert.equal(feedbackRules.value.targets[0].applied, true); assert.ok(feedbackRules.value.directories.includes(feedbackRules.value.targets[0].directory));
    await wb(page, { action: 'preview-close' });
    await openView(page, 'Design workspace');
    await page.getByRole('button', { name: 'Live dashboard version 1', exact: true }).click();
    await page.getByText('Live preview, annotations, and agent feedback', { exact: true }).click();
    await page.getByRole('button', { name: 'Prepare Codex design feedback', exact: true }).click(); await page.locator('.session-tile').nth(2).waitFor();
    assert.equal(await page.locator('.session-tile[data-status="running"]').count(), 0, 'Preparing design feedback must not launch a provider');
    await openView(page, 'Session history');
    await page.getByRole('button', { name: 'View native CLI conversations', exact: true }).click();
    await page.getByLabel('Search native conversations', { exact: true }).fill(conversation.id);
    await page.getByRole('button', { name: 'Resume in new tile', exact: true }).click(); await page.locator('.session-tile').nth(3).waitFor();
    assert.equal(await page.locator('.session-tile[data-status="running"]').count(), 0, 'Resume preparation must remain idle');
    for (const name of ['Task coordination', 'Verification profiles', 'AI coaching', 'Settings']) {
      await openView(page, name); await page.waitForTimeout(150);
      if (process.env.CODING_HUB_REVIEW_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CODING_HUB_REVIEW_SCREENSHOTS, 'AI-Coding-Hub-v' + runtime.version + '-' + name.toLowerCase().replaceAll(' ', '-') + '.png') });
    }
    await page.getByRole('heading', { name: 'Running application', exact: true }).waitFor();
    if (process.env.CODING_HUB_ENTERPRISE_SCREENSHOT) await page.screenshot({ path: process.env.CODING_HUB_ENTERPRISE_SCREENSHOT });
    const created = await wb(page, { action: 'backup-create', includeLogs: true }); assert.ok(created.record.files >= 8);
    const restored = await wb(page, { action: 'backup-restore', id: created.record.id }); assert.equal(restored.restartRequired, true); assert.notEqual(restored.restoredPath, runtime.storagePath);
    assert.equal((await wb(page, { action: 'runtime' })).restartRequired, true);
    await app.close(); app = null; page = await launch();
    assert.equal((await wb(page, { action: 'runtime' })).storagePath, restored.restoredPath);
    const workspace = (await native(page, 'loadWorkspace')).workspace;
    const restoredReview = workspace.sessions.find((session) => session.title === 'Codex · design review');
    assert.ok(restoredReview.binding.cwd.startsWith(restored.restoredPath + path.sep));
    assert.equal(workspace.sessions.find((session) => session.title === 'Codex · resumed').config.resumeId, conversation.id);
    assert.equal((await wb(page, { action: 'experiment-list' })).trials.length, 2);
    assert.equal((await wb(page, { action: 'task-list' })).length, 2);
    assert.equal((await wb(page, { action: 'verification-list' })).results[0].passed, true);
    assert.equal((await wb(page, { action: 'annotation-list', snapshotId: capture.snapshot.id })).length, 1);
    assert.equal((await native(page, 'designs', { action: 'list' })).length, 1);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: native diagnostics and redaction, approval requests from both CLIs, real Claude/Codex resume and delta-only token accounting, duplicate resume guard, approved npm verification, task overlap audit and completion evidence, measured A/B trials, isolated live preview and blocked remote requests, screenshot capture, annotations and feedback, local backup restore across app restart, and new navigation. Fixture CLIs; no provider request or Windows installation measured.');
  } catch (error) {
    // Show what each CLI printed and which events arrived (the fixture reports APPROVAL:requested, hook-failed or
    // unsupported), so a CI failure says where an approval request or usage report stopped.
    try {
      const window = app && app.windows()[0];
      if (window) console.error('Session events at failure:\n' + await window.evaluate(() => (window.events ?? []).slice(-60).map((event) => `${String(event.runId).slice(0, 8)} ${event.type}${event.type === 'data' ? ' ' + JSON.stringify(event.data.slice(-200)) : event.message ? ' ' + JSON.stringify(event.message) : ''}`).join('\n')));
    } catch { /* The window may already be gone. */ }
    throw error;
  } finally { if (app) await app.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
