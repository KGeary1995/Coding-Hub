const assert = require('node:assert/strict');
const { realpath, mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PtyManager } = require('../dist-electron/electron/services/cli/pty-manager');

(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coding-hub-pty-')));
  const directories = [path.join(root, 'claude-project'), path.join(root, 'codex-project')];
  await Promise.all(directories.map((directory) => mkdir(directory)));
  const outputs = new Map();
  const exits = new Set();
  const manager = new PtyManager((_owner, event) => {
    if (event.type === 'data') outputs.set(event.sessionId, (outputs.get(event.sessionId) ?? '') + event.data);
    if (event.type === 'exit') exits.add(event.sessionId);
  }, {
    discover: async (engine) => ({
      info: { engine, available: true, version: '2.1.296', executable: process.execPath, supportsModel: true, supportsConfig: true, supportsNoDaemon: false, error: null },
      executable: { file: process.execPath, prefixArgs: [path.join(__dirname, 'fixtures/interactive-cli.cjs')], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: process.execPath },
    }),
  });
  const wait = async (test) => {
    const deadline = Date.now() + 6000;
    while (!test()) { if (Date.now() >= deadline) throw new Error('PTY smoke check timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  };
  try {
    const runs = await Promise.all(['claude', 'codex'].map((engine, index) => manager.start(1, {
      sessionId: engine, cwd: directories[index], cols: 80, rows: 24,
      config: engine === 'claude' ? { engine, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } : { engine, model: '', reasoningEffort: null },
    })));
    await wait(() => runs.every((run) => outputs.get(run.sessionId)?.includes('READY')));
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      assert.ok(outputs.get(run.sessionId).includes(directories[index]));
      const ref = { sessionId: run.sessionId, runId: run.runId };
      manager.resize(1, { ...ref, cols: 112 + index, rows: 32 + index });
      manager.write(1, { ...ref, data: `hello-${run.sessionId}\r` });
    }
    await wait(() => runs.every((run) => outputs.get(run.sessionId)?.includes(`ECHO:hello-${run.sessionId}`)));
    for (const run of runs) assert.ok(!outputs.get(run.sessionId).includes(`ECHO:hello-${run.sessionId === 'claude' ? 'codex' : 'claude'}`));
    await wait(() => outputs.get('claude')?.includes('SIZE:112x32') && outputs.get('codex')?.includes('SIZE:113x33'));
    for (const run of runs) manager.write(1, { sessionId: run.sessionId, runId: run.runId, data: 'spawn-child\r' });
    await wait(() => runs.every((run) => /CHILD:\d+/.test(outputs.get(run.sessionId))));
    const children = runs.map((run) => Number(outputs.get(run.sessionId).match(/CHILD:(\d+)/)[1]));
    await manager.dispose();
    assert.equal(exits.size, 2);
    for (const pid of children) assert.throws(() => process.kill(pid, 0));
    for (const run of runs) assert.throws(() => process.kill(run.pid, 0));
    console.log('PASS: Electron native PTYs, two isolated working directories, ANSI streams, keyboard input, resize propagation, output isolation, and CLI/child-process shutdown.');
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
