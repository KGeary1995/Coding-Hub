import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionFile, EditorBridge, type EditorChannel } from './editor-bridge';
import { EXTENSION_SOURCE, extensionManifest, vsix } from './vscode-extension';

const homes: string[] = []; const bridges: EditorBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

async function bridge(channels: EditorChannel[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-editor-')); homes.push(home); const sent: [string, string][] = [];
  const value = new EditorBridge({ home, channels: () => channels, send: async (sessionId, text) => { sent.push([sessionId, text]); } }); bridges.push(value);
  await value.start(); const link = JSON.parse(fs.readFileSync(connectionFile(home), 'utf8')) as { port: number; token: string };
  return { home, link, sent };
}
function request(port: number, route: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: { error?: string } & Record<string, unknown> }>((resolve, reject) => {
    const data = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const call = http.request({ host: '127.0.0.1', port, path: route, method: options.method ?? 'GET', headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    call.on('error', reject); if (data) call.write(data); call.end();
  });
}
const claude: EditorChannel = { channel: 1, sessionId: 's1', name: 'app', engine: 'Claude Code', waiting: false };

describe('the editor bridge', () => {
  it('writes its address and key for the extension, readable by this user only', async () => {
    const { home, link } = await bridge([]);
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(fs.statSync(connectionFile(home)).mode & 0o077).toBe(0);
  });
  it('lists the running agent channels and sends one the code', async () => {
    const { link, sent } = await bridge([claude]);
    expect((await request(link.port, `/editor/${link.token}/channels`)).body).toEqual([claude]);
    const reply = await request(link.port, `/editor/${link.token}/send`, { method: 'POST', body: { sessionId: 's1', text: 'Explain this.' } });
    expect(reply.status).toBe(200); expect(sent).toEqual([['s1', 'Explain this.']]);
  });
  it('refuses a wrong key, a web page and another host name', async () => {
    const { link, sent } = await bridge([claude]);
    expect((await request(link.port, `/editor/${'0'.repeat(64)}/channels`)).status).toBe(403);
    expect((await request(link.port, `/editor/${link.token}/channels`, { headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await request(link.port, `/editor/${link.token}/channels`, { headers: { host: `evil.example:${link.port}` } })).status).toBe(403);
    expect(sent).toEqual([]);
  });
  it('does not send to a channel waiting for the person, or one no longer running', async () => {
    const { link, sent } = await bridge([{ ...claude, waiting: true }]);
    const waiting = await request(link.port, `/editor/${link.token}/send`, { method: 'POST', body: { sessionId: 's1', text: 'x' } });
    expect(waiting.status).toBe(409); expect(waiting.body.error).toMatch(/waiting for you to answer/);
    expect((await request(link.port, `/editor/${link.token}/send`, { method: 'POST', body: { sessionId: 'gone', text: 'x' } })).status).toBe(409);
    expect(sent).toEqual([]);
  });
});

describe('the VS Code extension', () => {
  it('is a valid script that registers its command', () => {
    const registered: string[] = [];
    const vscode = { commands: { registerCommand: (name: string) => { registered.push(name); return { dispose() {} }; } }, window: {} };
    const module = { exports: {} as { activate?: (context: { subscriptions: unknown[] }) => void } };
    vm.runInNewContext(EXTENSION_SOURCE, { require: (name: string) => name === 'vscode' ? vscode : require(name), module, exports: module.exports });
    module.exports.activate!({ subscriptions: [] });
    expect(registered).toEqual(['trace.sendSelection']);
    expect(extensionManifest('1.38.0').contributes.commands[0].command).toBe('trace.sendSelection');
  });
  it('packs a .vsix with its manifest and files', () => {
    const file = vsix('1.38.0'); expect(file.readUInt32LE(0)).toBe(0x04034b50);
    const text = file.toString('latin1');
    for (const name of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/extension.js']) expect(text).toContain(name);
    expect(text).toContain('Version="1.38.0" Publisher="trace-local"');
  });
});
