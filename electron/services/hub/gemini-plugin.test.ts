import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEMINI_RULE, GEMINI_TOOL_RULES, geminiConfigRoot, geminiPluginOff, installGeminiPlugin } from './gemini-plugin';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-plugin-')); roots.push(root); return root; };
const programs = { executable: '/app/Trace.exe', memoryServer: '/app/memory-server.js', channelServer: '/app/channel-server.js' };
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('Trace’s plugin for Gemini (agy)', () => {
  it('never points at the real ~/.gemini under tests', () => {
    expect(geminiConfigRoot()).toBe(path.join(process.env.CODING_HUB_GEMINI_HOME!, 'config')); expect(geminiConfigRoot()).not.toBe(path.join(os.homedir(), '.gemini', 'config'));
  });
  it('writes the plugin once, with both servers, its rule, and nothing in the person’s own mcp_config.json', () => {
    const root = temp(); fs.writeFileSync(path.join(root, 'mcp_config.json'), '{"mcpServers":{"mine":{"command":"x"}}}');
    expect(installGeminiPlugin(programs, root)).toBe(true);
    const folder = path.join(root, 'plugins', 'trace');
    expect(read(path.join(folder, 'plugin.json'))).toEqual({ name: 'trace' });
    expect(read(path.join(folder, 'mcp_config.json'))).toEqual({ mcpServers: {
      memory: { command: '/app/Trace.exe', args: ['/app/memory-server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      channels: { command: '/app/Trace.exe', args: ['/app/channel-server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    expect(fs.readFileSync(path.join(folder, 'rules', 'AGENTS.md'), 'utf8')).toBe(GEMINI_RULE); expect(GEMINI_RULE).toMatch(/^---\ntrigger: always_on\n---\n/);
    expect(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8')).toBe('{"mcpServers":{"mine":{"command":"x"}}}');
    // Already current: nothing is written again.
    const before = fs.statSync(path.join(folder, 'mcp_config.json')).mtimeMs; expect(installGeminiPlugin(programs, root)).toBe(false); expect(fs.statSync(path.join(folder, 'mcp_config.json')).mtimeMs).toBe(before);
  });
  it('points the servers at this Trace after a move, keeping whatever else the files hold', () => {
    const root = temp(); const folder = path.join(root, 'plugins', 'trace'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ name: 'trace', author: 'Trace' }));
    fs.writeFileSync(path.join(folder, 'mcp_config.json'), JSON.stringify({ mcpServers: { memory: { command: '/old/Trace.exe', args: ['/old/memory-server.js'], env: { ELECTRON_RUN_AS_NODE: '1', EXTRA: 'kept' } }, added: { command: 'y' } }, other: true }));
    expect(installGeminiPlugin(programs, root)).toBe(true);
    const config = read(path.join(folder, 'mcp_config.json'));
    expect(config.mcpServers.memory).toEqual({ command: '/app/Trace.exe', args: ['/app/memory-server.js'], env: { ELECTRON_RUN_AS_NODE: '1', EXTRA: 'kept' } });
    expect(config.mcpServers.channels.args).toEqual(['/app/channel-server.js']); expect(config.mcpServers.added).toEqual({ command: 'y' }); expect(config.other).toBe(true);
    expect(read(path.join(folder, 'plugin.json'))).toEqual({ name: 'trace', author: 'Trace' });
  });
  it('refuses a file it cannot read, saying which, and leaves it as it was', () => {
    const root = temp(); const folder = path.join(root, 'plugins', 'trace'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'mcp_config.json'), '{ broken');
    expect(() => installGeminiPlugin(programs, root)).toThrow(/Cannot parse .*mcp_config\.json/); expect(fs.readFileSync(path.join(folder, 'mcp_config.json'), 'utf8')).toBe('{ broken');
  });
  it('knows when the person turned it off in agy', () => {
    const root = temp(); expect(geminiPluginOff(root)).toBe(false);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ plugins: { swarm: { enabled: true }, trace: { enabled: true } } })); expect(geminiPluginOff(root)).toBe(false);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ plugins: { trace: { enabled: false } } })); expect(geminiPluginOff(root)).toBe(true);
  });
  it('allows Trace’s memory tools and the channel tools that only look, by agy’s server names', () => {
    expect(GEMINI_TOOL_RULES).toContain('mcp(trace_memory/memory_context)'); expect(GEMINI_TOOL_RULES).toContain('mcp(trace_memory/write_handoff)'); expect(GEMINI_TOOL_RULES).toContain('mcp(trace_channels/read_channel)');
    expect(GEMINI_TOOL_RULES.some((rule) => /send_to_channel|add_task|update_task|\*/.test(rule))).toBe(false);
  });
});
