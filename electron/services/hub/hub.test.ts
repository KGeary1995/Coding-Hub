import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeProjectKey, ConfigService, readConfig, updateConfig } from './config';
import { MemoryService } from './memory';
import { COMPARED_FILE, DriveMirror } from './drive';
import { decisions, decisionTitle, itemTitle, openItems, resolvedTitle, retiredTitle } from '../../../shared/memory-items';
import { memoryContext } from './auto-memory';
import { DEFAULT_PREFERENCES, localDay, type UsageRecord } from '../../../shared/hub';
import { parseUsage, repriced, TelemetryService, totalTokens, usageCost } from './telemetry';
import { hubRequestSchema } from './service';
import { backupFolder } from './file-backups';
import { canSymlink } from './symlink.fixture';
const roots: string[] = [];
function setup() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-integrations-')); roots.push(root); const project = path.join(root, 'project'); fs.mkdirSync(project); return { root, project }; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('native configuration management', () => {
  it('redacts environment/header credentials, preserves unknown TOML fields, toggles and backs up', () => {
    const { root, project } = setup(); fs.mkdirSync(path.join(root, '.codex')); const file = path.join(root, '.codex', 'config.toml'); fs.writeFileSync(file, 'model="custom"\n[mcp_servers.private]\ncommand="server"\nargs=["--token", "credential-value"]\nenv={API_KEY="credential-value"}\nenv_vars=["OTHER_KEY"]\ncustom_field=42\n');
    const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); const server = inventory.servers[0]; expect(JSON.stringify(inventory)).not.toContain('credential-value'); expect(server.transport.type === 'stdio' && server.transport.envVariableNames).toEqual(['API_KEY', 'OTHER_KEY']);
    service.mutate({ action: 'toggle-server', id: server.id, enabled: false }); const data = readConfig(file).data; expect(data.model).toBe('custom'); expect(data.mcp_servers.private.custom_field).toBe(42); expect(data.mcp_servers.private.env.API_KEY).toBe('credential-value'); expect(data.mcp_servers.private.enabled).toBe(false); expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('backup'))).toBe(false); expect(fs.readdirSync(backupFolder(file)).length).toBeGreaterThan(1);
  });
  it('rejects stale inspection instead of overwriting CLI changes', () => {
    const { root, project } = setup(); const file = path.join(project, '.mcp.json'); fs.writeFileSync(file, '{"mcpServers":{"server":{"command":"old"}}}'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const server = service.inventory(project).servers[0]; fs.writeFileSync(file, '{"mcpServers":{"server":{"command":"new"}}}'); expect(() => service.mutate({ action: 'remove-server', id: server.id })).toThrow('changed'); expect(readConfig(file).data.mcpServers.server.command).toBe('new');
  });
  it('uses Claude project disable settings and user project-scoped disable lists', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, '.mcp.json'), '{"mcpServers":{"project-server":{"command":"x"}}}'); fs.writeFileSync(path.join(root, '.claude.json'), '{"mcpServers":{"user-server":{"command":"y"}},"unknown":true}'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project);
    service.mutate({ action: 'toggle-server', id: inventory.servers.find((s) => s.name === 'project-server')!.id, enabled: false }); expect(readConfig(path.join(project, '.claude', 'settings.local.json')).data.disabledMcpjsonServers).toEqual(['project-server']);
    service.mutate({ action: 'toggle-server', id: service.inventory(project).servers.find((s) => s.name === 'user-server')!.id, enabled: false }); const data = readConfig(path.join(root, '.claude.json')).data;
    // Under the key Claude Code reads: forward slashes on Windows (C:/…), the path as it is elsewhere.
    const key = process.platform === 'win32' ? project.replace(/\\/g, '/') : project; expect(Object.keys(data.projects)).toEqual([key]); expect(data.projects[key].disabledMcpServers).toEqual(['user-server']); expect(data.unknown).toBe(true); expect(service.inventory(project).servers.every((s) => !s.enabled)).toBe(true);
  });
  it('removes the selected local Claude server when a same-name user server exists', () => {
    const { root, project } = setup(); const file = path.join(root, '.claude.json'); fs.writeFileSync(file, JSON.stringify({ mcpServers: { duplicate: { command: 'user' } }, projects: { [project]: { mcpServers: { duplicate: { command: 'local' } } } } }));
    const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); const server = inventory.servers.find((s) => s.transport.type === 'stdio' && s.transport.command === 'local')!; service.mutate({ action: 'remove-server', id: server.id }); const cfg = readConfig(file).data; expect(cfg.mcpServers.duplicate.command).toBe('user'); expect(cfg.projects[project].mcpServers.duplicate).toBeUndefined();
  });
  it('keeps malformed config untouched', () => {
    const { project } = setup(); const file = path.join(project, '.mcp.json'); fs.writeFileSync(file, '{broken'); expect(() => updateConfig(file, null, () => {})).toThrow('preserved'); expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
  it.skipIf(!canSymlink)('rejects config files reached through symbolic links', () => {
    const { root, project } = setup(); const file = path.join(project, '.mcp.json'); fs.symlinkSync(path.join(root, 'outside.json'), file); expect(() => readConfig(file)).toThrow('symbolic');
  });
  it('discovers instruction/skill files and disables a Codex skill without disturbing other settings', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Project instructions'); const skill = path.join(root, '.codex', 'skills', 'review'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Review skill'); fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model="custom"\n'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); expect(inventory.extensions.some((s) => s.kind === 'memory' && s.preview === 'Project instructions')).toBe(true); const found = inventory.extensions.find((s) => s.kind === 'skill')!; service.mutate({ action: 'toggle-extension', id: found.id, enabled: false }); const cfg = readConfig(path.join(root, '.codex', 'config.toml')).data; expect(cfg.model).toBe('custom'); expect(cfg.skills.config).toEqual([{ path: skill, enabled: false }]);
  });
  it('validates IPC inputs, model rates, project keys, and protocol URLs', () => {
    expect(hubRequestSchema.safeParse({ action: 'memory-list', project: '../other' }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'inventory', directory: '/tmp', executable: 'arbitrary' }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'save-preferences', preferences: { ...DEFAULT_PREFERENCES, prices: [{ model: 'x', input: -1, output: 1, cacheRead: 1, cacheWrite: 1 }] } }).success).toBe(false);
  });
});
describe('shared handoff memory and Drive mirror', () => {
  it('syncs immutable notes in both directions and retries without duplication', async () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder); const local = new MemoryService(path.join(root, 'local')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); local.write('shared', 'Claude', 'Next task', 'claude'); remote.write('shared', 'Codex', 'Tests passed', 'codex'); const drive = new DriveMirror(local, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder })); expect(await drive.syncLater('shared')).toEqual({ uploaded: 1, downloaded: 1 }); expect(await drive.syncLater('shared')).toEqual({ uploaded: 0, downloaded: 0 }); expect(local.list('shared')).toHaveLength(2); expect(remote.list('shared')).toHaveLength(2);
  });
  it('preserves both conflicting versions and remains usable offline', async () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder); const local = new MemoryService(path.join(root, 'local')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); const note = local.write('shared', 'Local', 'Content', 'human'); remote.import({ ...note, content: 'Remote changed' }); const drive = new DriveMirror(local, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder })); await expect(drive.syncLater('shared')).rejects.toThrow('conflicting'); expect(local.list('shared')[0].content).toBe('Content'); expect(remote.list('shared')[0].content).toBe('Remote changed'); fs.rmSync(folder, { recursive: true }); await expect(drive.syncLater('shared')).rejects.toThrow('was not found. Start Google Drive for desktop'); expect(local.list('shared')).toHaveLength(1);
  });
  it('binds projects independently and refuses invalid paths or note overwrite', () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'memory')); memory.write('alpha', 'A', 'One', 'claude'); memory.write('beta', 'B', 'Two', 'codex'); expect(memory.list('alpha').map((n) => n.content)).toEqual(['One']); expect(() => memory.list('../alpha')).toThrow(); const note = memory.list('alpha')[0]; expect(() => memory.import({ ...note, content: 'Changed' })).toThrow('conflicts');
  });
  it('counts each project’s notes and reads a project again only when its folder changed', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'memory')); memory.write('alpha', 'A', 'One', 'claude'); memory.write('beta', 'B', 'Two', 'codex');
    const read = vi.spyOn(memory, 'listLater');
    expect((await memory.projectsLater()).map((item) => [item.key, item.notes])).toEqual(expect.arrayContaining([['alpha', 1], ['beta', 1]])); expect(read).toHaveBeenCalledTimes(2);
    read.mockClear(); expect(await memory.projectsLater()).toHaveLength(2); expect(read).not.toHaveBeenCalled();
    const added = memory.write('alpha', 'C', 'Three', 'human'); fs.utimesSync(path.join(memory.root, 'alpha'), new Date(), new Date(Date.now() + 5000));
    const counted = await memory.projectsLater(); expect(read.mock.calls.map(([project]) => project)).toEqual(['alpha']);
    expect(counted[0]).toEqual({ key: 'alpha', notes: 2, latest: added.createdAt });
  });
  it('installs both CLI MCP entries and appends instructions while preserving existing content', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Existing instructions\n'); const memory = new MemoryService(path.join(root, 'memory')); memory.install(project, 'shared', '/app/memory-server.js', '/app/electron'); expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain('# Existing instructions\n'); expect(readConfig(path.join(project, '.mcp.json')).data.mcpServers['coding-hub-memory'].args).toContain('shared'); expect(readConfig(path.join(project, '.codex', 'config.toml')).data.mcp_servers['coding-hub-memory'].env.ELECTRON_RUN_AS_NODE).toBe('1'); expect(() => memory.install(project, 'shared', '/app/server', '/app/electron')).toThrow('already configured');
  });
});
describe('memory installation rollback', () => {
  it('restores earlier configuration and instructions if a later replacement fails', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Original instructions');
    const memory = new MemoryService(path.join(root, 'memory')); const rename = fs.renameSync; let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(to).endsWith('CLAUDE.md') && !failed) { failed = true; throw new Error('Fixture file lock'); } return rename(from, to); });
    expect(() => memory.install(project, 'shared', '/app/memory-server.js', '/app/electron')).toThrow('restored');
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('Original instructions');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false); expect(fs.existsSync(path.join(project, '.codex', 'config.toml'))).toBe(false);
  });
});
describe('structured telemetry', () => {
  const run = { runId: randomUUID(), sessionId: 'session', engine: 'claude' as const, cwd: '/project', pid: 1 };
  it('parses actual engine formats without treating reasoning as additional output', () => {
    const event = parseUsage('codex', { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 40, reasoning_output_tokens: 20 }, last_token_usage: { input_tokens: 90, output_tokens: 30 }, model_context_window: 1000 } } }, 'model')!; expect(event.context).toEqual({ used: 120, limit: 1000 }); const record = { ...run, ...event, timestamp: new Date().toISOString(), engine: 'codex', cost: null } as UsageRecord; expect(totalTokens(record)).toBe(80); expect(usageCost(record, [{ model: 'model', input: 2, output: 10, cacheRead: 1, cacheWrite: 2 }])).toBeCloseTo(0.00054); expect(usageCost(record, [])).toBeNull();
    // Another computer's run follows this computer's rates, not the price it was given there.
    expect(repriced({ ...record, cost: 1 }, [{ model: 'model', input: 2, output: 10, cacheRead: 1, cacheWrite: 2 }])).toMatchObject({ costBasis: 'configured-model-rates' }); expect(repriced({ ...record, cost: 1 }, [{ model: 'model', input: 2, output: 10, cacheRead: 1, cacheWrite: 2 }]).cost).toBeCloseTo(0.00054); expect(repriced({ ...record, cost: 1 }, [])).toMatchObject({ cost: null, costBasis: 'unpriced' }); expect(parseUsage('claude', { type: 'user', message: {} }, '')).toBeNull();
  });
  it('counts the input Claude writes to its cache as new tokens, and still leaves out cache reads', () => {
    const record = { ...run, model: 'm', timestamp: new Date().toISOString(), input: 5, output: 761, cached: 900, cacheWrite: 40000, reasoning: null, context: null, cost: null } satisfies UsageRecord;
    expect(totalTokens(record)).toBe(40766);
    expect(totalTokens({ ...record, engine: 'codex', input: 100, cached: 60, cacheWrite: 0, output: 40 })).toBe(80);
  });
  it('prices a dated model ID with the rate entered for the model, preferring an exact rate', () => {
    const record = { ...run, model: 'claude-opus-5-5-20261101', timestamp: new Date().toISOString(), input: 1000000, output: 0, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null } satisfies UsageRecord;
    const base = { model: 'Claude-Opus-5-5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(usageCost(record, [base])).toBe(5);
    expect(usageCost(record, [base, { ...base, model: 'claude-opus-5-5-20261101', input: 7 }])).toBe(7);
    // Models with no entered rate get the published price ([1m] costs what the model does); an unknown one stays unpriced.
    expect(usageCost({ ...record, model: 'claude-opus-5-5[1m]' }, [base])).toBe(4);
    expect(usageCost({ ...record, model: 'claude-sonnet-5-5' }, [base])).toBe(2);
    expect(usageCost({ ...record, model: 'a-model-with-no-price' }, [base])).toBeNull();
  });
  it('reads the whole rest of a usage log when a run ends, however much is left', async () => {
    const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      const usage = (id: string, output: number) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: 1, output_tokens: output } } }) + '\n';
      // 6 MB of other events before the last usage entry: more than the old 8 × 512 KB finishing read reached.
      const filler = (JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n').repeat(6000);
      fs.writeFileSync(file, usage('first', 10) + filler + usage('last', 32));
      await telemetry.end(run.runId);
      expect(telemetry.list()[0]).toMatchObject({ output: 42 }); expect(telemetry.list()[0].incomplete).toBeUndefined();
    } finally { telemetry.close(); }
  });
  it.skipIf(process.platform === 'win32')('tells the window at once when a run ends with usage it could not read', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const published: UsageRecord[] = []; const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], (usage) => published.push(usage), () => {}, home, path.join(root, 'codex'));
    try {
      const usage = (id: string, output: number) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: 1, output_tokens: output } } }) + '\n';
      fs.writeFileSync(file, usage('first', 10));
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      vi.advanceTimersByTime(750); expect(published.at(-1)?.incomplete).toBeUndefined();
      // More usage is written, but the log can no longer be read (locked).
      fs.appendFileSync(file, usage('second', 20)); fs.chmodSync(file, 0);
      await telemetry.end(run.runId);
      expect(published.at(-1)).toMatchObject({ output: 10, incomplete: true });
    } finally { fs.chmodSync(file, 0o600); telemetry.close(); vi.useRealTimers(); }
  });
  it('follows a /clear or /resume inside the terminal to the conversation Claude Code writes now', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true });
    const followed = { ...run, runId: randomUUID() }; const resumed = randomUUID(); const cleared = randomUUID();
    const reply = (id: string, output: number) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: 1, output_tokens: output } } }) + '\n';
    const published: UsageRecord[] = []; const switched: string[] = [];
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], (usage) => published.push(usage), () => {}, home, path.join(root, 'codex'));
    telemetry.onConversation = (seen, id) => { expect(seen.runId).toBe(followed.runId); switched.push(id); };
    try {
      fs.writeFileSync(path.join(dir, followed.runId + '.jsonl'), reply('first', 10));
      // An existing conversation (/resume): what it and its subagents held before belongs to the runs that wrote it.
      fs.writeFileSync(path.join(dir, resumed + '.jsonl'), reply('old', 1000)); fs.mkdirSync(path.join(dir, resumed, 'subagents'), { recursive: true }); fs.writeFileSync(path.join(dir, resumed, 'subagents', 'agent-1.jsonl'), reply('old-sub', 500));
      telemetry.start(followed, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      fs.appendFileSync(path.join(dir, followed.runId + '.jsonl'), reply('before-switch', 5));
      telemetry.follow(followed.runId, followed.runId); expect(switched).toEqual([]);
      telemetry.follow(followed.runId, resumed); expect(switched).toEqual([resumed]);
      expect(telemetry.transcript(followed.runId)).toBe(path.join(dir, resumed + '.jsonl')); expect(telemetry.isConversationActive('claude', resumed)).toBe(true); expect(telemetry.isConversationActive('claude', followed.runId)).toBe(false);
      fs.appendFileSync(path.join(dir, resumed + '.jsonl'), reply('resumed-new', 20)); fs.appendFileSync(path.join(dir, resumed, 'subagents', 'agent-1.jsonl'), reply('sub-new', 3));
      vi.advanceTimersByTime(750);
      expect(published.at(-1)).toMatchObject({ output: 38, conversationId: resumed });
      // A new conversation (/clear) is reported once Claude Code has written it, and counts from its start.
      telemetry.follow(followed.runId, cleared); expect(switched).toEqual([resumed]); expect(telemetry.transcript(followed.runId)).toBeNull();
      vi.advanceTimersByTime(750); expect(switched).toEqual([resumed]);
      fs.writeFileSync(path.join(dir, cleared + '.jsonl'), reply('cleared-new', 100));
      vi.advanceTimersByTime(750);
      expect(switched).toEqual([resumed, cleared]); expect(published.at(-1)).toMatchObject({ output: 138, conversationId: cleared });
      await telemetry.end(followed.runId); telemetry.follow(followed.runId, randomUUID()); expect(switched).toHaveLength(2);
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('passes each new line of a run\'s own transcript to live coaching, not its subagents\' lines', async () => {
    const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(path.join(dir, run.runId, 'subagents'), { recursive: true });
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex')); const lines: unknown[] = [];
    telemetry.onLine = (_run, _config, raw) => lines.push(raw);
    try {
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Add a footer' } }) + '\n');
      fs.writeFileSync(path.join(dir, run.runId, 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'subagent task' } }) + '\n');
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      await telemetry.end(run.runId);
      expect(lines).toEqual([{ type: 'user', message: { content: 'Add a footer' } }]);
    } finally { telemetry.close(); }
  });
  it('finds a folder in .claude.json projects however Claude Code wrote its Windows path', () => {
    const projects = { 'C:/Users/me/App': { mcpServers: {} }, '/home/me/app': {} };
    // Claude Code writes C:/…; Trace's paths are C:\…, and on Windows the case may differ.
    expect(claudeProjectKey(projects, 'C:\\Users\\me\\App')).toBe('C:/Users/me/App');
    expect(claudeProjectKey(projects, 'c:\\users\\me\\app\\')).toBe('C:/Users/me/App');
    // A folder with no entry yet gets one the way Claude Code writes it.
    expect(claudeProjectKey(projects, 'D:\\Work\\New')).toBe('D:/Work/New');
    expect(claudeProjectKey(projects, '/home/me/app')).toBe('/home/me/app');
  });
  it('counts subagent (Task tool) usage from their own transcripts, without taking over the channel’s context', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const published: UsageRecord[] = []; const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], (usage) => published.push(usage), () => {}, home, path.join(root, 'codex'));
    try {
      const usage = (id: string, input: number, output: number) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: input, output_tokens: output } } }) + '\n';
      fs.writeFileSync(file, usage('main', 100, 10));
      const subagents = path.join(dir, run.runId, 'subagents'); fs.mkdirSync(subagents, { recursive: true });
      fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), usage('sub-1', 5000, 300)); fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'), '{}');
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      vi.advanceTimersByTime(750);
      expect(published.at(-1)).toMatchObject({ input: 5100, output: 310 }); expect(published.at(-1)?.context).toEqual({ used: 110, limit: 0 });
      // A second subagent, and more from the first, are picked up as they are written.
      fs.appendFileSync(path.join(subagents, 'agent-a1.jsonl'), usage('sub-2', 10, 20)); fs.writeFileSync(path.join(subagents, 'agent-b2.jsonl'), usage('sub-3', 1, 2));
      vi.advanceTimersByTime(750); expect(published.at(-1)).toMatchObject({ input: 5111, output: 332 });
      // The window size the running Claude reports (a chat reply, a terminal's status line) completes the context at once.
      const count = published.length; telemetry.setContextWindow(run.runId, 1_000_000);
      expect(published).toHaveLength(count + 1); expect(published.at(-1)?.context).toEqual({ used: 110, limit: 1_000_000 });
      telemetry.setContextWindow(run.runId, 1_000_000); telemetry.setContextWindow(run.runId, 12); expect(published).toHaveLength(count + 1);
      // Compacting the conversation: the context is what was kept, at once, with the run's tokens as they were. A subagent's own compaction is not the channel's.
      const boundary = (uuid: string, postTokens: number) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata: { trigger: 'manual', preTokens: 110, postTokens } }) + '\n';
      fs.appendFileSync(path.join(subagents, 'agent-a1.jsonl'), boundary('sub-compact', 7)); fs.appendFileSync(file, boundary('main-compact', 30));
      vi.advanceTimersByTime(750); expect(published.at(-1)?.context).toEqual({ used: 30, limit: 1_000_000 }); expect(published.at(-1)).toMatchObject({ input: 5111, output: 332 });
      // The next reply reports the context again.
      fs.appendFileSync(file, usage('after', 40, 5)); vi.advanceTimersByTime(750); expect(published.at(-1)?.context).toEqual({ used: 45, limit: 1_000_000 });
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('does not count a resumed conversation’s earlier subagent usage again, and counts a reply once across runs', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    const config = { engine: 'claude' as const, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } };
    try {
      const usage = (id: string, input: number, output: number) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: input, output_tokens: output } } }) + '\n';
      fs.writeFileSync(file, usage('main', 100, 10)); const subagents = path.join(dir, run.runId, 'subagents'); fs.mkdirSync(subagents, { recursive: true }); fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), usage('sub-1', 5000, 300));
      telemetry.start(run, config); vi.advanceTimersByTime(750); await telemetry.end(run.runId);
      expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 5100, output: 310 });
      // The channel restarts and resumes the conversation; it then replies once more and runs another subagent.
      const resumed = { ...run, runId: randomUUID() }; telemetry.setResumeSource(resumed.runId, file, 'claude', '');
      telemetry.start(resumed, { ...config, resumeId: run.runId } as never);
      fs.appendFileSync(file, usage('main-2', 7, 3)); fs.appendFileSync(path.join(subagents, 'agent-a1.jsonl'), usage('sub-2', 20, 2)); vi.advanceTimersByTime(750); await telemetry.end(resumed.runId);
      expect(telemetry.runUsage(resumed.runId)).toMatchObject({ input: 27, output: 5 });
      // A run that recorded an earlier run's reply again (as 1.14 and before did) counts it only for the first run.
      const third = { ...run, runId: randomUUID() }; fs.writeFileSync(path.join(dir, third.runId + '.jsonl'), usage('sub-1', 5000, 300) + usage('new', 1, 1));
      telemetry.start(third, config); vi.advanceTimersByTime(750); await telemetry.end(third.runId);
      expect(telemetry.runUsage(third.runId)).toMatchObject({ input: 1, output: 1 }); expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 5100, output: 310 });
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('dates older replies by the day Claude Code wrote them, once', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      // Recorded as an older Trace did: no timestamps in what it read, so no day per reply.
      const reply = (id: string, at?: string) => JSON.stringify({ type: 'assistant', ...(at ? { timestamp: at } : {}), message: { id, model: 'm', usage: { input_tokens: 10, output_tokens: 90 } } }) + '\n';
      fs.writeFileSync(file, reply('late') + reply('next'));
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }); vi.advanceTimersByTime(750); await telemetry.end(run.runId);
      const started = Object.keys(telemetry.runUsage(run.runId)!.days!); expect(started).toHaveLength(1);
      // Claude Code's transcript has the times: the second reply came the next day.
      const first = new Date(2026, 9, 26, 23, 50); const second = new Date(2026, 9, 27, 0, 10);
      fs.writeFileSync(file, reply('late', first.toISOString()) + reply('next', second.toISOString()));
      expect(telemetry.backfillDays([home])).toBe(2);
      expect(telemetry.runUsage(run.runId)!.days).toEqual({ '2026-10-26': { tokens: 100, cost: null }, '2026-10-27': { tokens: 100, cost: null } });
      expect(telemetry.backfillDays([home])).toBe(0);
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('hands over a short run’s transcript found only by the last read, for its memory summary', async () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      // The CLI wrote its transcript and exited before telemetry's next poll.
      fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'm', usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n');
      expect(telemetry.transcript(run.runId)).toBeNull();
      expect(await telemetry.end(run.runId)).toBe(file);
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('says so when a run’s usage log keeps failing to read, including that its token limit is not enforced', () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl');
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex')); const errors: string[] = []; telemetry.onError = (_run, message) => errors.push(message);
    try {
      fs.writeFileSync(file, '');
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: 1000 } });
      vi.advanceTimersByTime(750);
      // The log becomes unreadable (here: it disappears, which fails the same way on every platform).
      fs.rmSync(file);
      vi.advanceTimersByTime(750 * 5);
      expect(errors).toHaveLength(1); expect(errors[0]).toMatch(/usage may be incomplete and its session token limit is not being enforced/);
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('deduplicates Claude snapshots, persists totals, and triggers the reported session limit', () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, run.runId + '.jsonl'); const publish = vi.fn(); const stop = vi.fn(); const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], publish, stop, home, path.join(root, 'codex'));
    telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: 120 } }); const event = (output: number) => JSON.stringify({ type: 'assistant', message: { id: 'same-message', model: 'actual-model', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } }) + '\n'; fs.writeFileSync(file, event(10) + event(30)); vi.advanceTimersByTime(750); expect(telemetry.list()[0]).toMatchObject({ input: 100, output: 30, cached: 20, cacheWrite: 10, model: 'actual-model', reasoning: null }); expect(totalTokens(telemetry.list()[0])).toBe(140); expect(stop).toHaveBeenCalledTimes(1); fs.appendFileSync(file, event(20)); vi.advanceTimersByTime(750); expect(telemetry.list()[0].output).toBe(30); expect(stop).toHaveBeenCalledTimes(1); telemetry.close();
    const restored = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home); expect(restored.list()[0].output).toBe(30); restored.close();
  });
  it('counts each reply on the day it was used, so a run that spans midnight adds to today', () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [{ model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } });
      const today = new Date(); today.setHours(12, 0, 0, 0); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      const event = (id: string, at: Date, output: number) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { id, model: 'm', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 5000 } } }) + '\n';
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), event('a', yesterday, 10) + event('b', today, 30) + event('c', today, 20)); vi.advanceTimersByTime(750);
      expect(telemetry.list()[0].days).toEqual({ [localDay(yesterday)]: { tokens: 110, cost: 0.00011 }, [localDay(today)]: { tokens: 250, cost: 0.00025 } });
    } finally { telemetry.close(); vi.useRealTimers(); }
  });
  it('correlates Codex thread IDs and refuses ambiguous same-directory sessions', () => {
    vi.useFakeTimers(); const { root } = setup(); const codex = path.join(root, 'codex'); const now = new Date(); const dir = path.join(codex, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')); fs.mkdirSync(dir, { recursive: true }); const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, path.join(root, 'claude'), codex); const a = { ...run, runId: randomUUID(), engine: 'codex' as const }; const b = { ...a, runId: randomUUID(), sessionId: 'second' }; const config = { engine: 'codex' as const, model: '', reasoningEffort: null }; const thread = randomUUID(); fs.writeFileSync(path.join(dir, `rollout-${thread}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(), payload: { id: thread, cwd: a.cwd } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-actual' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 25 } } } }) + '\n');
    // Starts happen before the file becomes visible to avoid accidental sequential assignment.
    const file = path.join(dir, `rollout-${thread}.jsonl`); const contents = fs.readFileSync(file); fs.unlinkSync(file); telemetry.start(a, config); telemetry.start(b, config); fs.writeFileSync(file, contents); vi.advanceTimersByTime(750); expect(telemetry.list()).toEqual([]); const logDir = path.join(root, 'telemetry', a.runId); fs.mkdirSync(logDir); fs.writeFileSync(path.join(logDir, 'codex-tui.log'), `thread_id="${thread}"`); vi.advanceTimersByTime(750); expect(telemetry.list()[0]).toMatchObject({ runId: a.runId, model: 'gpt-actual', input: 100, output: 25 }); telemetry.close();
  });
});

describe('memory revisions and Drive conflict review', () => {
  it('carries decisions, open items, review records and resolutions between two computers through Drive, and into the next session', async () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
    const desk = new MemoryService(path.join(root, 'desk')); const laptop = new MemoryService(path.join(root, 'laptop'));
    const sync = (memory: MemoryService) => new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder })).syncLater('shared');
    const decision = desk.write('shared', decisionTitle('Predictions from Barrett only'), 'The person decided.', 'claude');
    const item = desk.write('shared', itemTitle('Delete the exported CSV'), 'It holds chart numbers.', 'codex');
    desk.write('shared', 'Round Table review record: 1 finding, 0 verified', '- F1 (high), open: bug', 'human');
    desk.import({ id: randomUUID(), project: 'shared', title: 'From a later version', content: 'Body', author: 'claude', createdAt: new Date().toISOString(), laterField: 1 });
    await sync(desk); await sync(laptop);
    expect(decisions(laptop.list('shared')).map((d) => d.text)).toEqual(['Predictions from Barrett only']); expect(openItems(laptop.list('shared')).map((i) => i.id)).toEqual([item.id]);
    expect(laptop.list('shared')).toHaveLength(4);
    // The next session on the laptop starts with them.
    const context = memoryContext('shared', laptop.list('shared')); expect(context).toContain(`${decision.id} · Predictions from Barrett only`); expect(context).toContain(`${item.id} · Delete the exported CSV`);
    // Resolved and retired on the laptop: gone on the desk after both sync, with every record kept.
    laptop.write('shared', resolvedTitle({ title: item.title }), 'Deleted.', 'claude', item.id); laptop.write('shared', retiredTitle(decisions(laptop.list('shared'))[0]), 'Changed.', 'claude', decision.id);
    await sync(laptop); await sync(desk);
    expect(openItems(desk.list('shared'))).toEqual([]); expect(decisions(desk.list('shared'))).toEqual([]); expect(desk.list('shared')).toHaveLength(6);
  });
  it('keeps notes with fields a later Trace adds, rather than skipping them, and passes those fields on', () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'memory')); const copy = new MemoryService(path.join(root, 'copy'));
    const later = { id: randomUUID(), project: 'shared', title: 'From a later version', content: 'Body', author: 'codex', createdAt: new Date().toISOString(), laterField: { kept: true } };
    expect(memory.import(later)).toBe(true); const listed = memory.list('shared'); expect(listed.map((note) => note.id)).toEqual([later.id]);
    copy.import(listed[0]); expect((copy.list('shared')[0] as unknown as Record<string, unknown>).laterField).toEqual({ kept: true });
  });
  it('preserves originals and rejects stale conflict resolution while retaining both reviewed versions', async () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
    const memory = new MemoryService(path.join(root, 'memory')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory'));
    const original = memory.write('shared', 'Decision', 'Local content', 'claude'); const revision = memory.write('shared', 'Decision updated', 'Revised content', 'human', original.id);
    expect(revision.supersedes).toBe(original.id); expect(memory.list('shared')).toHaveLength(2);
    // Another size than the local copy: a note of the same size on both sides is taken as the same without reading it.
    remote.import({ ...original, content: 'Drive content, edited' }); const mirror = new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder }));
    await expect(mirror.syncLater('shared')).rejects.toThrow('conflicting'); const conflict = (await mirror.conflicts('shared'))[0];
    await expect(mirror.resolve('shared', original.id, '0'.repeat(64), conflict.remoteHash)).rejects.toThrow('changed');
    await mirror.resolve('shared', original.id, conflict.localHash, conflict.remoteHash);
    expect(await mirror.conflicts('shared')).toHaveLength(0); await mirror.syncLater('shared');
    expect(memory.list('shared').map((note) => note.content).sort()).toEqual(['Drive content, edited', 'Local content', 'Revised content']);
    expect(remote.list('shared')).toHaveLength(3); expect(fs.readdirSync(remote.directory('shared')).some((name) => name.includes('conflict-backup'))).toBe(true);
  });
  it('leaves missing or invalid primary token counts unknown rather than displaying zero', () => {
    expect(parseUsage('claude', { type: 'assistant', message: { id: 'a', usage: { output_tokens: 20 } } }, 'm')).toBeNull();
    expect(parseUsage('codex', { type: 'token_count', info: { total_token_usage: { input_tokens: -1, output_tokens: 20 } } }, 'm')).toBeNull();
  });
});

it('records a short Codex run whose rollout appears only immediately before exit', () => {
 vi.useFakeTimers(); const {root,project}=setup(); const codex=path.join(root,'codex'); const now=new Date();
 const folder=path.join(codex,'sessions',String(now.getUTCFullYear()),String(now.getUTCMonth()+1).padStart(2,'0'),String(now.getUTCDate()).padStart(2,'0'));
 fs.mkdirSync(folder,{recursive:true}); const telemetry=new TelemetryService(path.join(root,'telemetry'),()=>[],()=>{},()=>{},path.join(root,'claude'),codex);
 const run={runId:randomUUID(),sessionId:'short',engine:'codex' as const,cwd:project,pid:1}; const id=randomUUID();
 try {
  telemetry.start(run,{engine:'codex',model:'',reasoningEffort:null});
  fs.writeFileSync(path.join(folder,`rollout-${id}.jsonl`),JSON.stringify({type:'session_meta',timestamp:now.toISOString(),payload:{id,cwd:project}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:123,output_tokens:45}}}})+'\n');
  telemetry.end(run.runId); expect(telemetry.list()).toEqual([expect.objectContaining({runId:run.runId,input:123,output:45,conversationId:id})]);
 } finally {telemetry.close();}
});

it('keeps a valid handoff readable when JSON encoding expands its content', () => {
 const {root}=setup(); const memory=new MemoryService(path.join(root,'memory')); const content='\x01'.repeat(60000);
 const note=memory.write('shared','Escaped content',content,'human'); expect(memory.list('shared')).toEqual([note]); expect(memory.import(note)).toBe(false);
});

it('refuses symlinked memory roots instead of writing into another directory', () => {
 if(process.platform==='win32')return; const {root}=setup();const outside=path.join(root,'outside');fs.mkdirSync(outside);const link=path.join(root,'memory');fs.symlinkSync(outside,link);
 expect(()=>new MemoryService(link)).toThrow('link'); expect(fs.readdirSync(outside)).toEqual([]);
});

it('refuses the next handoff before exceeding the readable project limit', () => {
 const {root}=setup();const memory=new MemoryService(path.join(root,'memory'));const dir=memory.directory('full');fs.mkdirSync(dir);
 for(let i=0;i<5000;i++)fs.writeFileSync(path.join(dir,randomUUID()+'.json'),'{}');
 expect(()=>memory.write('full','One too many','Preserve existing records','human')).toThrow('5,000');
 expect(fs.readdirSync(dir)).toHaveLength(5000);expect(()=>memory.list('full')).not.toThrow();
// 5,000 real files: Windows runners with on-access scanning take 6-10 s, past the 5 s default.
}, 30_000);

it('reads no note at all when both sides already hold the same notes', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));
 for(let i=0;i<20;i++)local.write('shared',`Note ${i}`,'Ready for the next session','human');
 const drive=new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder}));await drive.syncLater('shared');
 const scans=vi.spyOn(MemoryService.prototype,'list');const reads=vi.spyOn(MemoryService.prototype,'notesLater');
 expect(await drive.syncLater('shared')).toEqual({uploaded:0,downloaded:0});expect(scans).not.toHaveBeenCalled();expect(reads).not.toHaveBeenCalled();
});

it('after a start, reads only the notes that are new or differ in size, never a pair of the same size', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));const remote=new MemoryService(path.join(folder,'AI-Coding-Hub-Memory'));
 for(let i=0;i<20;i++)local.write('shared',`Note ${i}`,'Ready for the next session','human');
 await new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared');
 // A new note on each side: the folders no longer match, which used to read all 20 pairs on the first sync after a start.
 const added=local.write('shared','Added here','Body','human');const arrived=remote.write('shared','Added on Drive','Body','codex');
 const reads=vi.spyOn(MemoryService.prototype,'notesLater');
 expect(await new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared')).toEqual({uploaded:1,downloaded:1});
 expect(reads.mock.calls.flatMap(([,ids])=>ids).sort()).toEqual([added.id,arrived.id].sort());
});

it('reads a note with the same content in different bytes on Drive once, remembered across restarts, and still copies new notes', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));const remote=new MemoryService(path.join(folder,'AI-Coding-Hub-Memory'));
 const notes=Array.from({length:5},(_,i)=>local.write('shared',`Note ${i}`,'Ready for the next session','human'));
 const start=()=>new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder}));const drive=start();await drive.syncLater('shared');
 // Another program rewrote the Drive copy with other line endings: the same note, a different size.
 const copy=path.join(remote.directory('shared'),notes[0].id+'.json');fs.writeFileSync(copy,fs.readFileSync(copy,'utf8').replace(/\n/g,'\r\n'));
 const reads=vi.spyOn(MemoryService.prototype,'notesLater');const scans=vi.spyOn(MemoryService.prototype,'list');
 expect(await drive.syncLater('shared')).toEqual({uploaded:0,downloaded:0});expect(reads.mock.calls.flatMap(([,ids])=>ids)).toEqual([notes[0].id,notes[0].id]);
 reads.mockClear();expect(await drive.syncLater('shared')).toEqual({uploaded:0,downloaded:0});
 // Trace restarts: the pair compared before is not read again.
 expect(await start().syncLater('shared')).toEqual({uploaded:0,downloaded:0});expect(reads).not.toHaveBeenCalled();expect(scans).not.toHaveBeenCalled();
 // A new note on each side is the only one read, and both arrive.
 const added=local.write('shared','Added here','Body','human');const arrived=remote.write('shared','Added on Drive','Body','codex');
 expect(await drive.syncLater('shared')).toEqual({uploaded:1,downloaded:1});expect(reads.mock.calls.flatMap(([,ids])=>ids).sort()).toEqual([added.id,arrived.id].sort());
 expect(local.list('shared')).toHaveLength(7);expect(remote.list('shared')).toHaveLength(7);
 // A copy that really differs is still caught, and neither copy is overwritten.
 const changed=fs.readFileSync(copy,'utf8').replace('Ready for the next session','Changed on Drive');fs.writeFileSync(copy,changed);
 await expect(start().syncLater('shared')).rejects.toThrow('conflicting');expect(fs.readFileSync(copy,'utf8')).toBe(changed);expect(local.note('shared',notes[0].id)?.content).toBe('Ready for the next session');
});

it('compares every pair again when the file of compared pairs is unreadable', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));const remote=new MemoryService(path.join(folder,'AI-Coding-Hub-Memory'));
 const note=local.write('shared','Note','Ready for the next session','human');await new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared');
 const copy=path.join(remote.directory('shared'),note.id+'.json');fs.writeFileSync(copy,fs.readFileSync(copy,'utf8').replace(/\n/g,'\r\n'));
 fs.writeFileSync(path.join(local.root,COMPARED_FILE),'{"broken');
 const reads=vi.spyOn(MemoryService.prototype,'notesLater');
 expect(await new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared')).toEqual({uploaded:0,downloaded:0});expect(reads).toHaveBeenCalledTimes(2);
 expect(Object.keys(JSON.parse(fs.readFileSync(path.join(local.root,COMPARED_FILE),'utf8')))).toHaveLength(1);
});

it('copies the other notes when one note conflicts, then reports the conflict', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));const remote=new MemoryService(path.join(folder,'AI-Coding-Hub-Memory'));
 const note=local.write('shared','Local','Content','human');remote.import({...note,content:'Remote changed'});
 const added=local.write('shared','Added here','Body','human');const arrived=remote.write('shared','Added on Drive','Body','codex');
 await expect(new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared')).rejects.toThrow('conflicting');
 expect(remote.note('shared',added.id)).not.toBeNull();expect(local.note('shared',arrived.id)).not.toBeNull();
 expect(local.note('shared',note.id)?.content).toBe('Content');expect(remote.note('shared',note.id)?.content).toBe('Remote changed');
});

it('lists the Drive folder once for a batch of copied notes, not once per note', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));
 for(let i=0;i<12;i++)local.write('shared',`Note ${i}`,'Body','human');
 // The spelling DriveMirror lists (fs.promises.realpath is the native resolver, which expands 8.3 short names such as RUNNER~1).
 const target=path.join(fs.realpathSync.native(folder),'AI-Coding-Hub-Memory','shared');const readdir=fs.promises.readdir;let listed=0;
 vi.spyOn(fs.promises,'readdir').mockImplementation(((dir: fs.PathLike, options?: unknown)=>{if(path.resolve(String(dir))===target)listed++;return (readdir as (d: fs.PathLike, o?: unknown)=>Promise<unknown>)(dir,options);}) as typeof fs.promises.readdir);
 expect(await new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder})).syncLater('shared')).toEqual({uploaded:12,downloaded:0});
 // Once to list both sides, once to count the notes before copying.
 expect(listed).toBe(2);
});

it('runs one sync of a project at a time and joins requests made meanwhile, rather than refusing them', async () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));
 local.write('shared','First','Body','human');const drive=new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder}));
 // Requests made before a sync has started join it.
 const first=drive.syncLater('shared');expect(drive.syncLater('shared')).toBe(first);await new Promise((resolve)=>setImmediate(resolve));
 // Requests made while it runs wait for it, then run once together.
 const written=local.write('shared','Written meanwhile','Body','human');const second=drive.syncLater('shared');const third=drive.syncLater('shared');
 expect(second).not.toBe(first);expect(third).toBe(second);
 const results=[await first,await second];expect(results[0].uploaded+results[1].uploaded).toBe(2);
 expect(new MemoryService(path.join(folder,'AI-Coding-Hub-Memory')).note('shared',written.id)).not.toBeNull();
});

it('never guesses a rollout after overlapping same-directory Codex runs exit', () => {
 vi.useFakeTimers();const {root,project}=setup();const codex=path.join(root,'codex');const now=new Date();
 const folder=path.join(codex,'sessions',String(now.getUTCFullYear()),String(now.getUTCMonth()+1).padStart(2,'0'),String(now.getUTCDate()).padStart(2,'0'));fs.mkdirSync(folder,{recursive:true});
 const telemetry=new TelemetryService(path.join(root,'telemetry'),()=>[],()=>{},()=>{},path.join(root,'claude'),codex);
 const a={runId:randomUUID(),sessionId:'a',engine:'codex' as const,cwd:project,pid:1};const b={...a,runId:randomUUID(),sessionId:'b'};const id=randomUUID();
 try {telemetry.start(a,{engine:'codex',model:'',reasoningEffort:null});telemetry.start(b,{engine:'codex',model:'',reasoningEffort:null});
 fs.writeFileSync(path.join(folder,`rollout-${id}.jsonl`),JSON.stringify({type:'session_meta',timestamp:now.toISOString(),payload:{id,cwd:project}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:500,output_tokens:200}}}})+'\n');
 telemetry.end(a.runId);telemetry.end(b.runId);expect(telemetry.list()).toEqual([]);
 }finally{telemetry.close();}
});
describe('telemetry regressions', () => {
  const run = { runId: randomUUID(), sessionId: 'session', engine: 'claude' as const, cwd: '/project', pid: 1 };
  it('enforces the session limit and ignores zero-usage synthetic entries even when prices cannot be read', () => {
    vi.useFakeTimers(); const { root } = setup(); const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true }); const stop = vi.fn();
    let broken = true; const rates = () => { if (broken) throw new Error('preferences.json failed validation'); return [{ model: 'actual-model', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]; };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), rates, () => {}, stop, home, path.join(root, 'codex'));
    telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: 100 } });
    const line = (id: string, model: string, input: number, output: number) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: output } } }) + '\n';
    fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), line('real', 'actual-model', 100, 50) + line('synthetic', '<synthetic>', 0, 0)); vi.advanceTimersByTime(750);
    expect(stop).toHaveBeenCalledTimes(1);
    broken = false; expect(telemetry.list()[0]).toMatchObject({ model: 'actual-model', costBasis: 'configured-model-rates' }); expect(telemetry.list()[0].cost).toBeCloseTo(0.00015);
    telemetry.close();
  });
});
describe('memory install regressions', () => {
  it('installs into a project whose .mcp.json starts with a UTF-8 byte-order mark', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, '.mcp.json'), '﻿{"mcpServers":{}}');
    const memory = new MemoryService(path.join(root, 'memory')); memory.install(project, 'shared', '/app/memory-server.js', '/app/electron');
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['coding-hub-memory']).toBeDefined();
  });
});
describe('Drive sync regressions', () => {
  it('keeps syncing other notes when one Drive file is truncated', async () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
    const memory = new MemoryService(path.join(root, 'memory')); const older = memory.write('shared', 'Older', 'First', 'human'); const newer = memory.write('shared', 'Newer', 'Second', 'human');
    const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); fs.mkdirSync(remote.directory('shared'), { recursive: true }); fs.writeFileSync(path.join(remote.directory('shared'), newer.id + '.json'), '{"id":');
    const mirror = new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder }));
    await expect(mirror.syncLater('shared')).rejects.toThrow(); expect(remote.list('shared').map((note) => note.id)).toEqual([older.id]);
  });
});

describe('Claude context in use', () => {
  it('takes what a compaction kept as the context, not the last reply before it', () => {
    const kept = parseUsage('claude', { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: new Date().toISOString(), compactMetadata: { trigger: 'manual', preTokens: 836587, postTokens: 34597 } }, 'm')!;
    expect(kept).toMatchObject({ key: 'compact:c1', compacted: true, input: 0, output: 0, context: { used: 34597, limit: 0 } });
    // An older Claude Code does not say how much was kept: the context is unknown until the next reply, not the old size.
    expect(parseUsage('claude', { type: 'system', subtype: 'compact_boundary', uuid: 'c2', compactMetadata: { trigger: 'auto', preTokens: 627114 } }, 'm')).toMatchObject({ compacted: true, context: null });
    expect(parseUsage('claude', { type: 'system', subtype: 'turn_duration', uuid: 'x' }, 'm')).toBeNull();
  });

  it('counts the whole prompt and the reply, without inventing a window size', () => {
    const event = parseUsage('claude', { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 200000, cache_creation_input_tokens: 40000, output_tokens: 761 } } }, 'fallback')!;
    expect(event.context).toEqual({ used: 240766, limit: 0 });
    expect(parseUsage('claude', { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 0, output_tokens: 0 } } }, 'm')!.context).toBeNull();
  });
});

describe('a project full of notes', () => {
  const note = (title: string, minute: number) => ({ id: randomUUID(), project: 'full', title, content: 'Body', author: 'human' as const, createdAt: `2026-11-12T00:${String(minute).padStart(2, '0')}:00.000Z` });
  it('moves its oldest handoff to the archive to take a new note, never an open item, and Drive sync does not bring it back', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'), 3);
    const oldest = note('Oldest handoff', 1); const item = note('Open item: still to do', 0); const middle = note('Middle handoff', 2);
    for (const each of [oldest, item, middle]) memory.import(each);
    const newest = note('Automatic summary', 3); expect(memory.import(newest)).toBe(true);
    expect(memory.list('full').map((n) => n.title).sort()).toEqual(['Automatic summary', 'Middle handoff', 'Open item: still to do']);
    expect([...(await memory.listing('full')).archived]).toEqual([oldest.id]); expect((await memory.listing('full')).sizes.has(oldest.id)).toBe(true);
    // The Drive copy still holds the archived note: it is not downloaded into the full project again.
    const folder = path.join(root, 'drive'); new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')).import(oldest);
    const drive = new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder }));
    expect((await drive.syncLater('full')).downloaded).toBe(0); expect((await memory.listing('full')).archived.has(oldest.id)).toBe(true);
  });
  it('counts again before writing when a note lands while Drive notes are copied into a nearly full project', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'), 3);
    memory.import(note('Oldest handoff', 1)); memory.import(note('Second handoff', 2));
    // A session summary is saved here after the folder was counted for the download, before its note is written.
    const readdir = fs.promises.readdir; let calls = 0;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: Parameters<typeof readdir>) => { const out = await (readdir as (...a: unknown[]) => Promise<unknown>)(...args); if (++calls === 1) memory.import(note('Session summary', 3)); return out; }) as typeof readdir);
    expect(await memory.importLater('full', [note('From Drive', 4)])).toEqual({ imported: 1, failure: null }); vi.restoreAllMocks();
    // Before: 4 notes in a project of 3, and from then on every read and write of it failed.
    expect(fs.readdirSync(memory.directory('full')).filter((name) => name.endsWith('.json'))).toHaveLength(3);
    expect(memory.list('full').map((n) => n.title).sort()).toEqual(['From Drive', 'Second handoff', 'Session summary']);
  });
  it('brings a project past its limit back under it with the next note, instead of refusing every read and write', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'), 3); const dir = memory.directory('full'); fs.mkdirSync(dir, { recursive: true });
    for (const [title, minute] of [['One', 1], ['Two', 2], ['Open item: three', 0], ['Four', 3]] as const) { const each = note(title, minute); fs.writeFileSync(path.join(dir, each.id + '.json'), JSON.stringify(each)); }
    expect(() => memory.list('full')).toThrow('exceeds');
    memory.write('full', 'Five', 'Body', 'human');
    expect(memory.list('full').map((n) => n.title).sort()).toEqual(['Five', 'Four', 'Open item: three']);
    // The asynchronous path too.
    const other = new MemoryService(path.join(root, 'other'), 3); const there = other.directory('full'); fs.mkdirSync(there, { recursive: true });
    for (const [title, minute] of [['One', 1], ['Two', 2], ['Three', 3], ['Four', 4]] as const) { const each = note(title, minute); fs.writeFileSync(path.join(there, each.id + '.json'), JSON.stringify(each)); }
    expect(await other.importLater('full', [note('Five', 5)])).toEqual({ imported: 1, failure: null });
    expect((await other.listLater('full')).map((n) => n.title).sort()).toEqual(['Five', 'Four', 'Three']);
  });
  it('lists the other notes when one note file cannot be read', () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local')); const kept = memory.write('full', 'Kept', 'Body', 'human'); const locked = memory.write('full', 'Locked', 'Body', 'human');
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => { if (String(file).endsWith(locked.id + '.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return (read as (f: unknown, o?: unknown) => unknown)(file, options); }) as typeof fs.readFileSync);
    expect(memory.list('full').map((n) => n.id)).toEqual([kept.id]);
  });
  it('checks notes copied from Drive as a local import does, and writes them normalised', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'));
    const padded = { ...note('Padded title  ', 1), project: 'full' }; const invalid = { ...note('No content', 2), content: '' };
    const result = await memory.importLater('full', [padded, invalid]); expect(result.imported).toBe(1); expect(String(result.failure)).toMatch(/not a valid note/);
    expect(JSON.parse(fs.readFileSync(path.join(memory.directory('full'), padded.id + '.json'), 'utf8')).title).toBe('Padded title');
  });
  it('makes room once for a batch of notes copied from Drive, moving only handoffs to the archive', async () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'), 3);
    const oldest = note('Oldest handoff', 1); const item = note('Open item: still to do', 0); const second = note('Second handoff', 2);
    for (const each of [oldest, item, second]) memory.import(each);
    expect(await memory.importLater('full', [note('New one', 3), note('New two', 4)])).toEqual({ imported: 2, failure: null });
    expect([...(await memory.listing('full')).archived].sort()).toEqual([oldest.id, second.id].sort()); expect(memory.list('full').map((n) => n.title).sort()).toEqual(['New one', 'New two', 'Open item: still to do']);
    // Only open items and decisions: nothing more is written, and the person is told why.
    const kept = new MemoryService(path.join(root, 'kept'), 2); kept.import(note('Open item: one', 1)); kept.import(note('Decision: two', 2));
    const result = await kept.importLater('full', [note('One more', 5)]); expect(result.imported).toBe(0); expect(String(result.failure)).toMatch(/Resolve or retire/); expect(kept.list('full')).toHaveLength(2);
  });
  it('says what to do when every note is an open item or decision', () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'local'), 2);
    memory.import(note('Open item: one', 1)); memory.import(note('Decision: two', 2));
    expect(() => memory.import(note('A handoff', 3))).toThrow(/Resolve or retire/);
  });
});
