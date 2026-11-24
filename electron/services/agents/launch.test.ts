import { describe, expect, it } from 'vitest';
import { buildCustomLaunch, customLevel, takesTools } from './launch';
import type { AgentDefinition } from '../../../shared/agent-definition';
import type { CustomChannelConfig } from '../../../shared/types';

const aider: AgentDefinition = { schema: 1, id: 'aider', name: 'Aider', program: { command: 'aider', args: ['--no-auto-commits'] }, models: { arg: ['--model', '{model}'] }, permissions: { ask: [], edits: ['--yes-always'], full: ['--yes-always', '--no-git'] }, resume: { args: ['--chat', '{id}'] }, mcp: { format: 'claude-json', args: ['--mcp-config', '{file}'] }, instructions: { args: ['--append', '{text}'] }, env: { AIDER_CHECK_UPDATE: 'false' } };
const config = (change: Partial<CustomChannelConfig> = {}): CustomChannelConfig => ({ engine: 'custom', agentId: 'aider', model: '', ...change });
const memory = { command: 'C:\\Trace\\Trace.exe', args: ['C:\\Trace\\memory-server.js'], env: { ELECTRON_RUN_AS_NODE: '1', CODING_HUB_MEMORY_KEY: 'proj-1' } };

describe('custom agent launch', () => {
  it('builds the arguments in order: program, permission level, model, resume, instructions, MCP file', () => {
    const launch = buildCustomLaunch({ definition: aider, config: config({ model: 'sonnet', permissions: 'full', resumeId: 'chat-7' }), servers: { 'coding-hub-memory': memory }, instructions: 'Notes: a "quoted" thing && more', mcpFile: '/s/run.mcp.json' });
    expect(launch.args).toEqual(['--no-auto-commits', '--yes-always', '--no-git', '--model', 'sonnet', '--chat', 'chat-7', '--append', 'Notes: a "quoted" thing && more', '--mcp-config', '/s/run.mcp.json']);
    expect(JSON.parse(launch.mcpConfig!)).toEqual({ mcpServers: { 'coding-hub-memory': memory } });
    expect(launch.env).toEqual({ AIDER_CHECK_UPDATE: 'false' });
  });
  it('uses the default level (Allow edits) only when the definition maps levels', () => {
    expect(buildCustomLaunch({ definition: aider, config: config(), servers: {}, instructions: null, mcpFile: 'f' }).args).toEqual(['--no-auto-commits', '--yes-always']);
    const plain = { ...aider, permissions: undefined }; expect(customLevel(plain, config({ permissions: 'full' }))).toBe('ask');
    expect(buildCustomLaunch({ definition: plain, config: config({ permissions: 'full' }), servers: {}, instructions: null, mcpFile: 'f' }).args).toEqual(['--no-auto-commits']);
  });
  it('passes no MCP file without servers, and Codex-style arguments for codex-toml', () => {
    expect(buildCustomLaunch({ definition: aider, config: config(), servers: {}, instructions: null, mcpFile: 'f' }).mcpConfig).toBeNull();
    const codexLike = { ...aider, mcp: { format: 'codex-toml' as const }, instructions: { env: 'AGENT_SYSTEM' } };
    const launch = buildCustomLaunch({ definition: codexLike, config: config({ permissions: 'ask' }), servers: { 'coding-hub-memory': memory }, instructions: 'remember', mcpFile: 'f' });
    expect(launch.args).toEqual(['--no-auto-commits', '--config', 'mcp_servers.coding-hub-memory.command="C:\\\\Trace\\\\Trace.exe"', '--config', 'mcp_servers.coding-hub-memory.args=["C:\\\\Trace\\\\memory-server.js"]', '--config', 'mcp_servers.coding-hub-memory.env={ELECTRON_RUN_AS_NODE="1",CODING_HUB_MEMORY_KEY="proj-1"}']);
    expect(launch.env.AGENT_SYSTEM).toBe('remember');
    expect(takesTools(codexLike)).toBe(true); expect(takesTools({ ...aider, mcp: { format: 'none' } })).toBe(false); expect(takesTools({ ...aider, mcp: undefined })).toBe(false);
  });
  it('refuses a model or conversation the definition can’t take, or one that could read as a flag', () => {
    const bare = { ...aider, models: undefined, resume: undefined };
    expect(() => buildCustomLaunch({ definition: bare, config: config({ model: 'x' }), servers: {}, instructions: null, mcpFile: 'f' })).toThrow(/takes no model/);
    expect(() => buildCustomLaunch({ definition: bare, config: config({ resumeId: 'c' }), servers: {}, instructions: null, mcpFile: 'f' })).toThrow(/can’t continue/);
    expect(() => buildCustomLaunch({ definition: aider, config: config({ model: '--yes' }), servers: {}, instructions: null, mcpFile: 'f' })).toThrow(/can’t be used/);
  });
});
