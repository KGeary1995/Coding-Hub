import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService, readConfig, updateConfig } from './config';
import { MemoryService } from './memory';
import { DriveMirror } from './drive';
import { DEFAULT_PREFERENCES, localDay, type UsageRecord } from '../../../shared/hub';
import { parseUsage, TelemetryService, totalTokens, usageCost } from './telemetry';
import { hubRequestSchema } from './service';
const roots: string[] = [];
function setup() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-integrations-')); roots.push(root); const project = path.join(root, 'project'); fs.mkdirSync(project); return { root, project }; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('native configuration management', () => {
  it('redacts environment/header credentials, preserves unknown TOML fields, toggles and backs up', () => {
    const { root, project } = setup(); fs.mkdirSync(path.join(root, '.codex')); const file = path.join(root, '.codex', 'config.toml'); fs.writeFileSync(file, 'model="custom"\n[mcp_servers.private]\ncommand="server"\nargs=["--token", "credential-value"]\nenv={API_KEY="credential-value"}\nenv_vars=["OTHER_KEY"]\ncustom_field=42\n');
    const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); const server = inventory.servers[0]; expect(JSON.stringify(inventory)).not.toContain('credential-value'); expect(server.transport.type === 'stdio' && server.transport.envVariableNames).toEqual(['API_KEY', 'OTHER_KEY']);
    service.mutate({ action: 'toggle-server', id: server.id, enabled: false }); const data = readConfig(file).data; expect(data.model).toBe('custom'); expect(data.mcp_servers.private.custom_field).toBe(42); expect(data.mcp_servers.private.env.API_KEY).toBe('credential-value'); expect(data.mcp_servers.private.enabled).toBe(false); expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('backup'))).toBe(true);
  });
  it('rejects stale inspection instead of overwriting CLI changes', () => {
    const { root, project } = setup(); const file = path.join(project, '.mcp.json'); fs.writeFileSync(file, '{"mcpServers":{"server":{"command":"old"}}}'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const server = service.inventory(project).servers[0]; fs.writeFileSync(file, '{"mcpServers":{"server":{"command":"new"}}}'); expect(() => service.mutate({ action: 'remove-server', id: server.id })).toThrow('changed'); expect(readConfig(file).data.mcpServers.server.command).toBe('new');
  });
  it('uses Claude project disable settings and user project-scoped disable lists', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, '.mcp.json'), '{"mcpServers":{"project-server":{"command":"x"}}}'); fs.writeFileSync(path.join(root, '.claude.json'), '{"mcpServers":{"user-server":{"command":"y"}},"unknown":true}'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project);
    service.mutate({ action: 'toggle-server', id: inventory.servers.find((s) => s.name === 'project-server')!.id, enabled: false }); expect(readConfig(path.join(project, '.claude', 'settings.local.json')).data.disabledMcpjsonServers).toEqual(['project-server']);
    service.mutate({ action: 'toggle-server', id: service.inventory(project).servers.find((s) => s.name === 'user-server')!.id, enabled: false }); const data = readConfig(path.join(root, '.claude.json')).data; expect(data.projects[project].disabledMcpServers).toEqual(['user-server']); expect(data.unknown).toBe(true); expect(service.inventory(project).servers.every((s) => !s.enabled)).toBe(true);
  });
  it('removes the selected local Claude server when a same-name user server exists', () => {
    const { root, project } = setup(); const file = path.join(root, '.claude.json'); fs.writeFileSync(file, JSON.stringify({ mcpServers: { duplicate: { command: 'user' } }, projects: { [project]: { mcpServers: { duplicate: { command: 'local' } } } } }));
    const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); const server = inventory.servers.find((s) => s.transport.type === 'stdio' && s.transport.command === 'local')!; service.mutate({ action: 'remove-server', id: server.id }); const cfg = readConfig(file).data; expect(cfg.mcpServers.duplicate.command).toBe('user'); expect(cfg.projects[project].mcpServers.duplicate).toBeUndefined();
  });
  it('keeps malformed config untouched and rejects symbolic links', () => {
    const { root, project } = setup(); const file = path.join(project, '.mcp.json'); fs.writeFileSync(file, '{broken'); expect(() => updateConfig(file, null, () => {})).toThrow('preserved'); expect(fs.readFileSync(file, 'utf8')).toBe('{broken'); fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'outside.json'), file); expect(() => readConfig(file)).toThrow('symbolic');
  });
  it('discovers instruction/skill files and disables a Codex skill without disturbing other settings', () => {
    const { root, project } = setup(); fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Project instructions'); const skill = path.join(root, '.codex', 'skills', 'review'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Review skill'); fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model="custom"\n'); const service = new ConfigService(root, path.join(root, '.claude'), path.join(root, '.codex')); const inventory = service.inventory(project); expect(inventory.extensions.some((s) => s.kind === 'memory' && s.preview === 'Project instructions')).toBe(true); const found = inventory.extensions.find((s) => s.kind === 'skill')!; service.mutate({ action: 'toggle-extension', id: found.id, enabled: false }); const cfg = readConfig(path.join(root, '.codex', 'config.toml')).data; expect(cfg.model).toBe('custom'); expect(cfg.skills.config).toEqual([{ path: skill, enabled: false }]);
  });
  it('validates IPC inputs, model rates, project keys, and protocol URLs', () => {
    expect(hubRequestSchema.safeParse({ action: 'memory-list', project: '../other' }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'inventory', directory: '/tmp', executable: 'arbitrary' }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'save-preferences', preferences: { ...DEFAULT_PREFERENCES, prices: [{ model: 'x', input: -1, output: 1, cacheRead: 1, cacheWrite: 1 }] } }).success).toBe(false);
  });
});
describe('shared handoff memory and Drive mirror', () => {
  it('syncs immutable notes in both directions and retries without duplication', () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder); const local = new MemoryService(path.join(root, 'local')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); local.write('shared', 'Claude', 'Next task', 'claude'); remote.write('shared', 'Codex', 'Tests passed', 'codex'); const drive = new DriveMirror(local, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder })); expect(drive.sync('shared')).toEqual({ uploaded: 1, downloaded: 1 }); expect(drive.sync('shared')).toEqual({ uploaded: 0, downloaded: 0 }); expect(local.list('shared')).toHaveLength(2); expect(remote.list('shared')).toHaveLength(2);
  });
  it('preserves both conflicting versions and remains usable offline', () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder); const local = new MemoryService(path.join(root, 'local')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); const note = local.write('shared', 'Local', 'Content', 'human'); remote.import({ ...note, content: 'Remote changed' }); const drive = new DriveMirror(local, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder })); expect(() => drive.sync('shared')).toThrow('conflicting'); expect(local.list('shared')[0].content).toBe('Content'); expect(remote.list('shared')[0].content).toBe('Remote changed'); fs.rmSync(folder, { recursive: true }); expect(() => drive.sync('shared')).toThrow('unavailable'); expect(local.list('shared')).toHaveLength(1);
  });
  it('binds projects independently and refuses invalid paths or note overwrite', () => {
    const { root } = setup(); const memory = new MemoryService(path.join(root, 'memory')); memory.write('alpha', 'A', 'One', 'claude'); memory.write('beta', 'B', 'Two', 'codex'); expect(memory.list('alpha').map((n) => n.content)).toEqual(['One']); expect(() => memory.list('../alpha')).toThrow(); const note = memory.list('alpha')[0]; expect(() => memory.import({ ...note, content: 'Changed' })).toThrow('conflicts');
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
    const event = parseUsage('codex', { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 40, reasoning_output_tokens: 20 }, last_token_usage: { input_tokens: 90, output_tokens: 30 }, model_context_window: 1000 } } }, 'model')!; expect(event.context).toEqual({ used: 120, limit: 1000 }); const record = { ...run, ...event, timestamp: new Date().toISOString(), engine: 'codex', cost: null } as UsageRecord; expect(totalTokens(record)).toBe(80); expect(usageCost(record, [{ model: 'model', input: 2, output: 10, cacheRead: 1, cacheWrite: 2 }])).toBeCloseTo(0.00054); expect(usageCost(record, [])).toBeNull(); expect(parseUsage('claude', { type: 'user', message: {} }, '')).toBeNull();
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
    telemetry.start(run, { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: 120 } }); const event = (output: number) => JSON.stringify({ type: 'assistant', message: { id: 'same-message', model: 'actual-model', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } }) + '\n'; fs.writeFileSync(file, event(10) + event(30)); vi.advanceTimersByTime(750); expect(telemetry.list()[0]).toMatchObject({ input: 100, output: 30, cached: 20, cacheWrite: 10, model: 'actual-model', reasoning: null }); expect(totalTokens(telemetry.list()[0])).toBe(130); expect(stop).toHaveBeenCalledTimes(1); fs.appendFileSync(file, event(20)); vi.advanceTimersByTime(750); expect(telemetry.list()[0].output).toBe(30); expect(stop).toHaveBeenCalledTimes(1); telemetry.close();
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
  it('preserves originals and rejects stale conflict resolution while retaining both reviewed versions', () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
    const memory = new MemoryService(path.join(root, 'memory')); const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory'));
    const original = memory.write('shared', 'Decision', 'Local content', 'claude'); const revision = memory.write('shared', 'Decision updated', 'Revised content', 'human', original.id);
    expect(revision.supersedes).toBe(original.id); expect(memory.list('shared')).toHaveLength(2);
    remote.import({ ...original, content: 'Drive content' }); const mirror = new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder }));
    expect(() => mirror.sync('shared')).toThrow('conflicting'); const conflict = mirror.conflicts('shared')[0];
    expect(() => mirror.resolve('shared', original.id, '0'.repeat(64), conflict.remoteHash)).toThrow('changed');
    mirror.resolve('shared', original.id, conflict.localHash, conflict.remoteHash);
    expect(mirror.conflicts('shared')).toHaveLength(0); mirror.sync('shared');
    expect(memory.list('shared').map((note) => note.content).sort()).toEqual(['Drive content', 'Local content', 'Revised content']);
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
});

it('does not rescan every handoff for every unchanged note during Drive sync', () => {
 const {root}=setup();const folder=path.join(root,'drive');fs.mkdirSync(folder);const local=new MemoryService(path.join(root,'local'));
 for(let i=0;i<20;i++)local.write('shared',`Note ${i}`,'Ready for the next session','human');
 const drive=new DriveMirror(local,()=>({...DEFAULT_PREFERENCES,driveDirectory:folder}));drive.sync('shared');
 const scans=vi.spyOn(MemoryService.prototype,'list');expect(drive.sync('shared')).toEqual({uploaded:0,downloaded:0});expect(scans).toHaveBeenCalledTimes(2);
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
  it('keeps syncing other notes when one Drive file is truncated', () => {
    const { root } = setup(); const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
    const memory = new MemoryService(path.join(root, 'memory')); const older = memory.write('shared', 'Older', 'First', 'human'); const newer = memory.write('shared', 'Newer', 'Second', 'human');
    const remote = new MemoryService(path.join(folder, 'AI-Coding-Hub-Memory')); fs.mkdirSync(remote.directory('shared'), { recursive: true }); fs.writeFileSync(path.join(remote.directory('shared'), newer.id + '.json'), '{"id":');
    const mirror = new DriveMirror(memory, () => ({ ...DEFAULT_PREFERENCES, driveDirectory: folder }));
    expect(() => mirror.sync('shared')).toThrow(); expect(remote.list('shared').map((note) => note.id)).toEqual([older.id]);
  });
});
