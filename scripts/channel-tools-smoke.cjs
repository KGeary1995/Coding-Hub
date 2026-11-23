// The channel-tools MCP server (1.33.0) as a CLI starts it, against Trace's channel tools with stand-in channels: the
// four tools, a message marked as from the asking channel, the refusals, and the tools stopping once turned off.
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { ChannelTools } = require('../dist-electron/electron/services/cli/channel-tools.js');

(async () => {
  const RUN = '11111111-1111-4111-8111-111111111111'; const sent = []; let on = true;
  const tools = new ChannelTools({
    enabled: () => on, sessionOf: (runId) => runId === RUN ? 'me' : null, replies: (sessionId, count) => [`last ${count} of ${sessionId}`],
    channels: () => [{ channel: 1, sessionId: 'me', name: 'Planner', engine: 'claude', running: true, waiting: null, folder: '/p' }, { channel: 2, sessionId: 'builder', name: 'Builder', engine: 'codex', running: true, waiting: null, folder: '/p' }],
    send: async (sessionId, text) => { sent.push([sessionId, text]); },
  });
  await tools.start(); const url = tools.register(RUN);
  const child = spawn(require('electron'), [path.resolve(__dirname, '../dist-electron/electron/services/hub/channel-server.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODING_HUB_CHANNEL_TOOLS_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let next = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line); const done = pending.get(message.id); if (done) { pending.delete(message.id); done(message); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => reject(new Error('MCP request timed out: ' + method)), 10000); pending.set(id, (value) => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => { const answer = await call('tools/call', { name, arguments: args }); return { error: answer.result.isError === true, value: answer.result.isError ? answer.result.content[0].text : JSON.parse(answer.result.content[0].text) }; };
  try {
    child.stdin.write('null\n[]\n');
    assert.equal((await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).result.serverInfo.name, 'trace-channels');
    assert.deepEqual((await call('tools/list')).result.tools.map((item) => item.name), ['list_channels', 'read_channel', 'send_to_channel', 'wait_for_channel']);
    assert.deepEqual((await tool('list_channels', {})).value.channels.map((item) => [item.channel, item.you]), [[1, true], [2, false]]);
    assert.deepEqual((await tool('read_channel', { channel: 2, replies: 2 })).value.replies, ['last 2 of builder']);
    assert.deepEqual((await tool('send_to_channel', { channel: 2, text: 'Build step 1.' })).value, { sent: true, channel: 2 });
    assert.deepEqual(sent, [['builder', '[Message from CH1 (Planner): an agent, not the person]\nBuild step 1.']]);
    const self = await tool('send_to_channel', { channel: 1, text: 'x' }); assert.equal(self.error, true); assert.match(self.value, /your own channel/);
    const waiting = tool('wait_for_channel', { channel: 2, timeoutSeconds: 10 });
    setTimeout(() => tools.onSessionEvent({ type: 'answered', sessionId: 'builder', runId: 'r', at: '', finished: true }), 300);
    assert.equal((await waiting).value.outcome, 'turn-ended');
    on = false; const off = await tool('list_channels', {}); assert.equal(off.error, true); assert.match(off.value, /Channel tools are off/);
    console.log('PASS: channel-tools MCP server: list, read, send (marked as from the asking channel), wait for a turn to end, refusing the own channel, and stopping once turned off');
  } finally { child.kill(); tools.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
