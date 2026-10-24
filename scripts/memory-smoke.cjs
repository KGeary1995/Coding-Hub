const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'coding-hub-memory-')));
  const children = new Set();
  async function connect() {
    const child = spawn(require('electron'), [path.resolve(__dirname, '../dist-electron/electron/services/hub/memory-server.js'), root, 'shared-project'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
    const pending = new Map(); let next = 0;
    readline.createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line); const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message); } });
    child.stderr.on('data', () => {});
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; const timeout = setTimeout(() => reject(new Error('MCP request timed out: ' + method)), 5000); pending.set(id, (result) => { clearTimeout(timeout); resolve(result); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    // Malformed JSON envelopes must not crash the standalone server.
    child.stdin.write('null\n[]\n42\n');
    const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }); assert.equal(initialized.result.protocolVersion, '2025-06-18');
    const tools = await call('tools/list'); assert.deepEqual(tools.result.tools.map((t) => t.name), ['read_memory', 'write_handoff']);
    const close = () => new Promise((resolve) => { child.once('exit', () => { children.delete(child); resolve(); }); child.stdin.end(); });
    return { call, close };
  }
  try {
    const claude = await connect(); const written = await claude.call('tools/call', { name: 'write_handoff', arguments: { title: 'Claude handoff', content: 'Implement the remaining task; validation passed.', author: 'claude' } }); assert.equal(written.result.isError, undefined);
    const expanded = await claude.call('tools/call', { name: 'write_handoff', arguments: { title: 'Escaped handoff', content: '\x01'.repeat(60000), author: 'claude' } }); assert.equal(expanded.result.isError, undefined); await claude.close();
    const codex = await connect(); const read = await codex.call('tools/call', { name: 'read_memory', arguments: {} }); const notes = JSON.parse(read.result.content[0].text); assert.equal(notes.length, 2); assert.equal(notes[0].author, 'claude'); assert.equal(notes.find((note) => note.title === 'Escaped handoff').content.length, 60000);
    const rejected = await codex.call('tools/call', { name: 'write_handoff', arguments: { title: '', content: 'Invalid note', author: 'codex' } }); assert.equal(rejected.result.isError, true); await codex.close();
    console.log('PASS: standalone MCP negotiation, tool discovery, malformed-envelope recovery, escaped handoff persistence, Codex read after restart, and validation rejection.');
  } finally { for (const child of children) child.kill(); await fs.rm(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
