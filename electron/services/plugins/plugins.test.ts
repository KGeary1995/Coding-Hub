import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, commandsOf } from './manifest';
import { resolveCommand } from './run';
import { Plugins, type PluginHost } from './plugins';
import { PluginApi, type PluginApiHost } from './plugin-api';
import type { PluginSummary } from '../../../shared/plugins';

const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-plugins-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
/** A plugin folder: its manifest, and a Node script `write.js` that appends what it was told to `out`. */
function plugin(manifest: Record<string, unknown>) {
  const folder = fixture(); const out = path.join(folder, 'out.txt');
  fs.writeFileSync(path.join(folder, 'trace-plugin.json'), JSON.stringify({ id: 'test.plugin', name: 'Test plugin', version: '0.1.0', minTrace: '1.35.0', ...manifest }));
  fs.writeFileSync(path.join(folder, 'write.js'), `require('fs').appendFileSync(${JSON.stringify(out)}, [process.argv[2], process.env.TRACE_EVENT, process.env.TRACE_CHANNEL, process.env.TRACE_MESSAGE, Boolean(process.env.TRACE_API_URL)].join('|') + '\\n')`);
  return { folder, out };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50)); };

describe('plugin manifests', () => {
  it('are read whole or refused with why, and leave out items for another system', () => {
    const { folder } = plugin({ actions: [{ id: 'a', title: 'Everywhere', command: ['node', 'write.js'] }, { id: 'b', title: 'Mac only', command: ['x'], platforms: ['mac'] }] });
    const manifest = readManifest(folder, '1.35.0', 'win32');
    expect(manifest.actions.map((item) => item.id)).toEqual(['a']); expect(manifest.permissions).toEqual([]);
    expect(commandsOf(manifest)).toEqual([{ what: 'Action: Everywhere', command: ['node', 'write.js'] }]);
    expect(() => readManifest(folder, '1.34.9')).toThrow(/needs Trace 1.35.0/);
    const bad = plugin({ actions: [{ id: 'a', title: 'x', command: [] }] }); expect(() => readManifest(bad.folder, '1.35.0')).toThrow(/not valid: actions\.0\.command/);
    const twice = plugin({ tiles: [{ id: 't', title: 'x', command: ['a'] }, { id: 't', title: 'y', command: ['b'] }] }); expect(() => readManifest(twice.folder, '1.35.0')).toThrow(/two tiles with the id t/);
    const extra = plugin({ shell: true }); expect(() => readManifest(extra.folder, '1.35.0')).toThrow(/not valid/);
  });
  it('find a command\'s program in the plugin\'s folder or on PATH, never outside it or through a batch file', () => {
    const { folder } = plugin({});
    expect(resolveCommand(folder, ['./write.js', 'x'], { PATH: '' }).args.at(-1)).toBe('x');
    expect(() => resolveCommand(folder, ['../escape.js'], { PATH: '' })).toThrow(/outside the plugin's folder/);
    expect(() => resolveCommand(folder, ['./missing.js'], { PATH: '' })).toThrow(/not in the plugin's folder/);
    fs.writeFileSync(path.join(folder, 'tool.cmd'), '@echo hi'); expect(() => resolveCommand(folder, ['./tool.cmd'], { PATH: '' }, 'win32')).toThrow(/batch file/);
    expect(() => resolveCommand(folder, ['no-such-program-anywhere'], { PATH: folder })).toThrow(/not found on this computer's PATH/);
    const node = resolveCommand(folder, ['node', '-v'], { PATH: path.dirname(process.execPath) }); expect(node.args).toEqual(['-v']);
  });
});

function setup(confirm = true) {
  const root = fixture(); const failed: string[] = []; const asked: unknown[] = [];
  const host: PluginHost = { version: '1.35.0', confirm: async (preview) => { asked.push(preview); return confirm; }, environment: () => ({ ...process.env } as Record<string, string>), api: () => ({ url: 'http://127.0.0.1:1/plugin/x/y', cli: 'trace' }), context: () => ({ channel: 2, channelName: 'Builder' }), failed: (name, what, why) => failed.push(`${name}|${what}|${why}`) };
  return { plugins: new Plugins(root, host), failed, asked };
}

describe('the plugins service', () => {
  it('links a folder only after the person saw what it runs, once per plugin id', async () => {
    const { folder } = plugin({ actions: [{ id: 'go', title: 'Go', command: ['./write.js', 'action'] }] });
    const refused = setup(false); await expect(refused.plugins.execute({ action: 'plugin-link', folder })).rejects.toMatchObject({ code: 'PLUGIN_DECLINED' });
    expect((await refused.plugins.execute({ action: 'plugin-list' }) as { plugins: unknown[] }).plugins).toHaveLength(0);
    const { plugins, asked } = setup();
    await plugins.execute({ action: 'plugin-link', folder }); expect(asked).toHaveLength(1); expect((asked[0] as { commands: unknown[] }).commands).toEqual([{ what: 'Action: Go', command: ['./write.js', 'action'] }]);
    await expect(plugins.execute({ action: 'plugin-link', folder })).rejects.toMatchObject({ code: 'PLUGIN_EXISTS' });
  });
  it('gives a plugin tile its program from the installed manifest, and refuses one turned off or gone', async () => {
    const { folder } = plugin({ tiles: [{ id: 'board', title: 'Board', command: ['./write.js', 'tile'] }] });
    const { plugins } = setup(); await plugins.execute({ action: 'plugin-link', folder });
    const tile = plugins.tile('test.plugin', 'board');
    expect(tile.title).toBe('Board'); expect(tile.args.at(-2)).toBe(path.join(folder, 'write.js')); expect(tile.args.at(-1)).toBe('tile'); expect(tile.env.TRACE_PLUGIN_ID).toBe('test.plugin'); expect(tile.env.TRACE_API_URL).toBeTruthy();
    expect(() => plugins.tile('test.plugin', 'other')).toThrow(/no tile other/);
    await plugins.execute({ action: 'plugin-enable', id: 'test.plugin', enabled: false }); expect(() => plugins.tile('test.plugin', 'board')).toThrow(/turned off/);
    await plugins.execute({ action: 'plugin-remove', id: 'test.plugin' }); expect(() => plugins.tile('test.plugin', 'board')).toThrow(/not installed/);
  });
  it('runs an action and event commands with what happened, and records each run', async () => {
    const { folder, out } = plugin({ actions: [{ id: 'go', title: 'Go', command: ['./write.js', 'action'] }], events: [{ on: 'channel.needs-you', command: ['./write.js', 'event'] }] });
    const { plugins } = setup(); await plugins.execute({ action: 'plugin-link', folder });
    await plugins.execute({ action: 'plugin-run', id: 'test.plugin', actionId: 'go' });
    plugins.fire('channel.needs-you', 's1', { channel: 3, message: 'Allow rm?' }); plugins.fire('channel.needs-you', 's1', { channel: 3, message: 'Again' });
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').split('\n').length >= 3);
    expect(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['action||2||true', 'event|channel.needs-you|3|Allow rm?|true']);
    // A run is recorded once its program has exited, which can be a moment after it wrote its last line.
    let runs: { ok: boolean }[] = []; for (let i = 0; i < 100 && runs.length < 2; i++) { runs = await plugins.execute({ action: 'plugin-log', id: 'test.plugin' }) as { ok: boolean }[]; if (runs.length < 2) await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(runs).toHaveLength(2); expect(runs.every((run) => run.ok)).toBe(true);
  });
  it('stops running a plugin that is turned off, and says why a run failed', async () => {
    const { folder, out } = plugin({ actions: [{ id: 'go', title: 'Go', command: ['./write.js', 'action'] }, { id: 'bad', title: 'Bad', command: ['./missing.js'] }] });
    const { plugins, failed } = setup(); await plugins.execute({ action: 'plugin-link', folder });
    await plugins.execute({ action: 'plugin-run', id: 'test.plugin', actionId: 'bad' }); await until(() => failed.length > 0);
    expect(failed[0]).toMatch(/^Test plugin\|Action: Bad\|\.\/missing\.js is not in the plugin's folder/);
    await plugins.execute({ action: 'plugin-enable', id: 'test.plugin', enabled: false });
    await expect(plugins.execute({ action: 'plugin-run', id: 'test.plugin', actionId: 'go' })).rejects.toMatchObject({ code: 'PLUGIN_OFF' });
    plugins.fire('channel.needs-you', 's1', {}); await new Promise((resolve) => setTimeout(resolve, 300)); expect(fs.existsSync(out)).toBe(false);
  });
});

describe('the plugin API', () => {
  const summary = (permissions: PluginSummary['permissions']): PluginSummary => ({ id: 'p', name: 'Board', version: '1', description: '', folder: '/p', source: { kind: 'folder', path: '/p' }, enabled: true, problem: null, permissions, actions: [], events: [], tiles: [], failures: 0, lastRun: null });
  function api(permissions: PluginSummary['permissions']) {
    const calls: string[] = [];
    const host: PluginApiHost = { plugin: () => summary(permissions), channels: () => [{ channel: 1, sessionId: 's1', name: 'Builder', engine: 'claude', running: true, waiting: null, folder: '/p' }, { channel: 2, sessionId: 's2', name: 'Asking', engine: 'codex', running: true, waiting: 'Allow rm?', folder: '/p' }], replies: () => ['done'], waiting: () => null, wait: async () => 'turn-ended',
      send: async (sessionId, text) => { calls.push(`send ${sessionId} ${text}`); }, control: async (sessionId, control) => { calls.push(`${control} ${sessionId}`); }, add: async (engine, chat) => { calls.push(`add ${engine} ${chat}`); }, tasks: () => [], addTask: async (title) => { calls.push(`task ${title}`); return { id: 't1' }; }, notify: (title) => { calls.push(`notify ${title}`); } };
    return { api: new PluginApi(host), calls, plugin: summary(permissions) };
  }
  it('allows only the calls a plugin declared, marks its messages, and leaves a waiting channel alone', async () => {
    const reader = api(['channels.read']);
    expect(await reader.api.run(reader.plugin, 'channels.list', {})).toEqual({ channels: [{ channel: 1, name: 'Builder', engine: 'claude', running: true, waiting: null, folder: '/p' }, { channel: 2, name: 'Asking', engine: 'codex', running: true, waiting: 'Allow rm?', folder: '/p' }] });
    await expect(reader.api.run(reader.plugin, 'channels.send', { channel: 1, text: 'x' })).rejects.toMatchObject({ code: 'PLUGIN_API_PERMISSION' });
    await expect(reader.api.run(reader.plugin, 'channels.stop', { channel: 1 })).rejects.toMatchObject({ code: 'PLUGIN_API_PERMISSION' });
    const full = api(['channels.read', 'channels.send', 'channels.control', 'tasks', 'notify']);
    expect(await full.api.run(full.plugin, 'channels.send', { channel: 1, text: 'Build it' })).toEqual({ sent: true, channel: 1 });
    await expect(full.api.run(full.plugin, 'channels.send', { channel: 2, text: 'x' })).rejects.toMatchObject({ code: 'PLUGIN_API_WAITING' });
    await full.api.run(full.plugin, 'channels.stop', { channel: 1 }); await full.api.run(full.plugin, 'channels.add', { engine: 'codex' }); await full.api.run(full.plugin, 'tasks.add', { title: 'Fix it', channel: 1 }); await full.api.run(full.plugin, 'notify', { title: 'Hi' });
    expect(full.calls).toEqual(['send s1 [Message from the plugin Board: not the person]\nBuild it', 'stop s1', 'add codex false', 'task Fix it', 'notify Board: Hi']);
    await expect(full.api.run(full.plugin, 'files.delete', {})).rejects.toMatchObject({ code: 'PLUGIN_API_OP' });
  });
  it('answers only a plugin\'s own secret address', async () => {
    const calls: string[] = []; const server = new PluginApi({ ...({} as PluginApiHost), plugin: (id, token) => id === 'p' && token === 'a'.repeat(64) ? summary(['notify']) : null, channels: () => [], waiting: () => null, notify: (title) => { calls.push(title); } });
    await server.start(); try {
      const url = server.url('p', 'a'.repeat(64))!;
      expect((await fetch(`${url}/notify`, { method: 'POST', body: JSON.stringify({ title: 'Hi' }) })).status).toBe(200); expect(calls).toEqual(['Board: Hi']);
      expect((await fetch(`${server.url('p', 'b'.repeat(64))}/notify`, { method: 'POST', body: '{}' })).status).toBe(401);
    } finally { server.close(); }
  });
});
