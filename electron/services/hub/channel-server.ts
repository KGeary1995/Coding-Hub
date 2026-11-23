// Standalone local MCP process launched by the user's CLI (1.33.0): the channel tools. Unlike the memory server it talks
// to Trace, over the loopback address Trace gave this run (CODING_HUB_CHANNEL_TOOLS_URL), which says which run asks.
import readline from 'node:readline';

const base = process.env.CODING_HUB_CHANNEL_TOOLS_URL ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+\/channels\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(base)) { process.stderr.write('channel-server needs CODING_HUB_CHANNEL_TOOLS_URL from Trace.\n'); process.exit(2); }
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const channel = { type: 'integer', minimum: 1, maximum: 64, description: 'The channel number, as CH1, CH2… in Trace (list_channels).' };
const TOOLS = [
  { name: 'list_channels', description: 'List the channels open in Trace on this computer: number, name, CLI, whether it runs, what it waits for, its folder, and which one is yours.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_channel', description: 'Read the last replies of another channel\'s agent (Claude Code or Codex; a terminal or Gemini CLI has none to read).', inputSchema: { type: 'object', properties: { channel, replies: { type: 'integer', minimum: 1, maximum: 20, description: 'How many of its last replies. Default 3.' } }, required: ['channel'], additionalProperties: false } },
  { name: 'send_to_channel', description: 'Send another channel\'s agent a message, typed in as the person would, marked as coming from your channel. Refused for your own channel, a stopped one, or one waiting for the person to answer an approval.', inputSchema: { type: 'object', properties: { channel, text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['channel', 'text'], additionalProperties: false } },
  { name: 'wait_for_channel', description: 'Wait until another channel\'s agent ends its turn, asks the person for an approval, or stops, or until the time given. Says which. Read it afterwards with read_channel.', inputSchema: { type: 'object', properties: { channel, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Default 600.' } }, required: ['channel'], additionalProperties: false } },
] as const;
const ROUTES: Record<string, string> = { list_channels: 'list', read_channel: 'read', send_to_channel: 'send', wait_for_channel: 'wait' };

async function call(route: string, args: unknown) {
  const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args ?? {}) });
  const value = await response.json().catch(() => ({ error: 'Trace gave no answer.' })) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Trace refused the request.');
  return value;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line) => {
  if (Buffer.byteLength(line) > 512000) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large (over 512 KB).' } }); return; }
  let message: { id?: string | number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
  try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
  if (message.id === undefined) return;
  try {
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion ?? '') ? message.params!.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trace-channels', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: TOOLS };
    else if (message.method === 'tools/call') {
      const route = ROUTES[String(message.params?.name)];
      if (!route) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${String(message.params?.name).slice(0, 100)}` } }); return; }
      result = { content: [{ type: 'text', text: JSON.stringify(await call(route, message.params?.arguments)) }] };
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'The channel tool failed.' }] } }); }
});
