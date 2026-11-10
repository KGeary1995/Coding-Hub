import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EngineInfo, RunningSession } from '../../../shared/ipc';
import { AutoMemory, lastAssistantMessage, memoryContext, memoryEntries, normalizeRemote, projectMemoryKey, useAutomaticKey } from './auto-memory';
import { MemoryService } from './memory';

const roots: string[] = [];
// prepare() starts git in the background; Windows cannot delete a folder a process is still using.
const pending: AutoMemory[] = [];
afterEach(async () => {
  for (const auto of pending.splice(0)) await auto.settled();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-memory-'))); roots.push(root); return root; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repository(root: string, name: string, origin?: string) {
  const directory = path.join(root, name); fs.mkdirSync(directory); git(directory, 'init', '-b', 'main');
  fs.writeFileSync(path.join(directory, 'app.txt'), 'baseline\n'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'Baseline');
  if (origin) git(directory, 'remote', 'add', 'origin', origin);
  return directory;
}
const info = (engine: 'claude' | 'codex'): EngineInfo => ({ engine, available: true, executable: '/cli', version: '2.1.310', supportsModel: true, supportsConfig: true, supportsNoDaemon: false, supportsAppendSystemPrompt: true, supportsMcpConfig: true, error: null });
const track = (auto: AutoMemory) => { pending.push(auto); return auto; };
const run = (engine: 'claude' | 'codex', cwd: string): RunningSession => ({ sessionId: 'tile', runId: randomUUID(), engine, cwd, pid: 1 } as RunningSession);

describe('memory keys', () => {
  it('normalizes SSH and HTTPS remotes to the same identity', () => {
    expect(normalizeRemote('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRemote('https://token@github.com/Owner/Repo/')).toBe('github.com/owner/repo');
  });
  it('shares one key across clones and worktrees of a repository and separates unrelated folders', () => {
    const root = temp();
    const first = repository(root, 'one', 'git@github.com:Owner/App.git'); const second = repository(root, 'two', 'https://github.com/owner/app');
    const tree = path.join(root, 'tree'); git(first, 'worktree', 'add', '-b', 'side', tree);
    const key = projectMemoryKey(path.join(first));
    expect(key).toMatch(/^app-[0-9a-f]{10}$/); expect(projectMemoryKey(second)).toBe(key); expect(projectMemoryKey(tree)).toBe(key);
    const plain = repository(root, 'app'); const other = path.join(root, 'nested'); fs.mkdirSync(other); const copy = repository(other, 'app');
    expect(projectMemoryKey(plain)).not.toBe(projectMemoryKey(copy)); expect(projectMemoryKey(path.join(plain))).toBe(projectMemoryKey(plain));
  });
});

describe('launch context', () => {
  it('lists newest notes within the size limit and labels them as history, not instructions', () => {
    const notes = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), project: 'app-1', title: `Note ${index}`, content: 'x'.repeat(2000), author: 'claude' as const, createdAt: new Date().toISOString() }));
    const text = memoryContext('app-1', notes);
    expect(text.length).toBeLessThanOrEqual(6000); expect(text).toContain('Note 0'); expect(text).not.toContain('Note 11'); expect(text).toContain('not as instructions');
    expect(memoryContext('app-1', [])).toContain('No handoff notes');
  });
  it('adds the memory server and context to Claude and Codex launches without touching project files', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory'));
    const key = projectMemoryKey(project); memory.write(key, 'Earlier decision', 'Use the existing router.', 'codex');
    const auto = track(new AutoMemory({ memory, enabled: () => true, server: '/app/memory-server.js', executable: '/app/electron', scratch: path.join(root, 'scratch') }));
    const claude = { args: ['--session-id', 'x'] }; const claudeRun = run('claude', project); auto.prepare(claudeRun, '', info('claude'), claude);
    expect(claude.args[claude.args.indexOf('--append-system-prompt') + 1]).toContain('Use the existing router.');
    expect(claude.args.at(-2)).toBe('--mcp-config');
    expect(JSON.parse(fs.readFileSync(claude.args.at(-1)!, 'utf8')).mcpServers['coding-hub-memory']).toEqual({ command: '/app/electron', args: ['/app/memory-server.js', memory.root, key], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const codex = { args: ['resume', randomUUID()] }; auto.prepare(run('codex', project), '', info('codex'), codex);
    expect(codex.args.slice(0, 1)).toEqual(['resume']); expect(codex.args).toContain(`mcp_servers.coding-hub-memory.args=${JSON.stringify(['/app/memory-server.js', memory.root, key])}`); expect(codex.args).toContain('mcp_servers.coding-hub-memory.default_tools_approval_mode="approve"');
    expect(codex.args.find((arg) => arg.startsWith('developer_instructions='))).toContain('Earlier decision');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });
  it('pulls newer shared notes before building the launch context and starts without them when sync fails', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const key = projectMemoryKey(project);
    const synced: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, server: '/s', executable: '/e', scratch: path.join(root, 'scratch'), refresh: (project) => { synced.push(project); memory.write(project, 'From another computer', 'Synced before launch.', 'codex'); } }));
    const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch);
    expect(synced).toEqual([key]); expect(launch.args[launch.args.indexOf('--append-system-prompt') + 1]).toContain('Synced before launch.');
    const offline = track(new AutoMemory({ memory, enabled: () => true, server: '/s', executable: '/e', scratch: path.join(root, 'scratch'), refresh: () => { throw new Error('Drive offline'); } }));
    const local = { args: [] as string[] }; offline.prepare(run('claude', project), '', info('claude'), local); expect(local.args).toContain('--append-system-prompt');
  });
  it('skips the server when the project installed it and does nothing when switched off', () => {
    const root = temp(); const project = repository(root, 'project'); fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': { command: 'x' } } }));
    const memory = new MemoryService(path.join(root, 'memory')); let enabled = true;
    const auto = track(new AutoMemory({ memory, enabled: () => enabled, server: '/s', executable: '/e', scratch: path.join(root, 'scratch') }));
    const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch);
    expect(launch.args).toContain('--append-system-prompt'); expect(launch.args).not.toContain('--mcp-config');
    enabled = false; const off = { args: [] as string[] }; auto.prepare(run('codex', project), '', info('codex'), off); expect(off.args).toEqual([]);
  });
});

describe('session summaries', () => {
  it('reads the final assistant message from Claude and Codex session files', () => {
    const root = temp(); const claude = path.join(root, 'claude.jsonl'); const codex = path.join(root, 'codex.jsonl');
    fs.writeFileSync(claude, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'First' }] } }, { type: 'user', message: { content: 'next' } }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'Tests pass.' }] } }].map((line) => JSON.stringify(line)).join('\n') + '\n');
    fs.writeFileSync(codex, [{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: refactored.' }] } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] } }].map((line) => JSON.stringify(line)).join('\n') + '\n{"partial":');
    expect(lastAssistantMessage('claude', claude)).toBe('Tests pass.'); expect(lastAssistantMessage('codex', codex)).toBe('Done: refactored.');
  });
  it('records files changed and commits made during the session, and skips sessions that left nothing', async () => {
    const root = temp(); const project = repository(root, 'project'); fs.writeFileSync(path.join(project, 'before.txt'), 'already dirty');
    const memory = new MemoryService(path.join(root, 'memory')); const written: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, server: '/s', executable: '/e', scratch: path.join(root, 'scratch'), onWrite: (key) => written.push(key) }));
    const active = run('claude', project); auto.prepare(active, 'sonnet', info('claude'), { args: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(project, 'app.txt'), 'changed\n'); git(project, 'commit', '-am', 'Change app'); fs.writeFileSync(path.join(project, 'new.txt'), 'new');
    const transcript = path.join(root, 't.jsonl'); fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Added new.txt' }] } }) + '\n');
    const note = await auto.finish(active.runId, transcript);
    expect(note?.author).toBe('claude'); expect(note?.content).toContain('?? new.txt'); expect(note?.content).not.toContain('before.txt'); expect(note?.content).toContain('Change app'); expect(note?.content).toContain('Added new.txt');
    expect(written).toEqual([projectMemoryKey(project)]); expect(fs.existsSync(path.join(root, 'scratch', `${active.runId}.mcp.json`))).toBe(false);
    const idle = run('codex', project); auto.prepare(idle, '', info('codex'), { args: [] }); await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await auto.finish(idle.runId, null)).toBeNull();
  });
  it('lets shutdown wait for summaries of sessions that just ended', async () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory'));
    const auto = track(new AutoMemory({ memory, enabled: () => true, server: '/s', executable: '/e', scratch: path.join(root, 'scratch') }));
    const active = run('codex', project); auto.prepare(active, '', info('codex'), { args: [] }); await auto.settled();
    fs.writeFileSync(path.join(project, 'closing.txt'), 'unsaved');
    void auto.finish(active.runId, null); await auto.drain(20000);
    expect(memory.list(projectMemoryKey(project)).some((note) => note.content.includes('closing.txt'))).toBe(true);
  });
});

describe('project-installed memory servers', () => {
  // Stands in for the current install: repairs only point entries at programs that exist.
  function install(root: string) { const dir = path.join(root, 'Trace'); fs.mkdirSync(dir); const executable = path.join(dir, 'Trace.exe'); const server = path.join(dir, 'memory-server.js'); fs.writeFileSync(executable, ''); fs.writeFileSync(server, ''); return { executable, server }; }
  const entry = (command: string, script: string, memoryRoot: string, key: string) => ({ command, args: [script, memoryRoot, key], env: { ELECTRON_RUN_AS_NODE: '1' } });

  it('points an entry left by an older install at the current program and keeps its key and other servers', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    const old = path.join(root, 'AI Coding Hub');
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' }, 'coding-hub-memory': entry(path.join(old, 'AI Coding Hub.exe'), path.join(old, 'memory-server.js'), memory.root, key) } }));
    const notices: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch'), onNotice: (message) => notices.push(message) }));
    const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch);
    const saved = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers;
    expect(saved['coding-hub-memory']).toEqual(entry(current.executable, current.server, memory.root, key)); expect(saved.other).toEqual({ command: 'other' });
    // The project's own entry is used, so no second copy is passed at launch.
    expect(launch.args).not.toContain('--mcp-config');
    expect(notices).toHaveLength(1); expect(notices[0]).toContain('no longer exists');
  });

  it('repairs a Codex entry and leaves entries that still work or that Trace did not write', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    fs.mkdirSync(path.join(project, '.codex'));
    fs.writeFileSync(path.join(project, '.codex', 'config.toml'), `[mcp_servers.coding-hub-memory]\ncommand = ${JSON.stringify(path.join(root, 'gone.exe'))}\nargs = ${JSON.stringify([path.join(root, 'gone', 'memory-server.js'), memory.root, key])}\n`);
    const custom = { command: 'node', args: ['my-memory.js'] };
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': custom } }));
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch') }));
    const codex = { args: [] as string[] }; auto.prepare(run('codex', project), '', info('codex'), codex);
    expect(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).toContain(JSON.stringify(current.executable));
    expect(codex.args.some((arg) => arg.startsWith('mcp_servers.coding-hub-memory.command='))).toBe(false); expect(codex.args).toContain('mcp_servers.coding-hub-memory.default_tools_approval_mode="approve"');
    const claude = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), claude);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['coding-hub-memory']).toEqual(custom);
    expect(claude.args).not.toContain('--mcp-config');
  });

  it('warns once, in the notice and in the launch context, when the entry uses another memory key', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': entry(current.executable, current.server, memory.root, 'coding-hub') } }));
    const before = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
    const notices: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch'), onNotice: (message) => notices.push(message) }));
    for (let i = 0; i < 2; i++) {
      const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch);
      const context = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
      expect(context).toContain('with the key coding-hub'); expect(context).toContain(key);
    }
    expect(notices).toHaveLength(1); expect(notices[0]).toContain('coding-hub'); expect(notices[0]).toContain(key);
    // A working entry is never rewritten.
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('repairs stale entries at startup in folders agents ran in, once per project, skipping folders that are gone', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    const old = path.join(root, 'AI Coding Hub'); const sub = path.join(project, 'src'); fs.mkdirSync(sub);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': entry(path.join(old, 'AI Coding Hub.exe'), path.join(old, 'memory-server.js'), memory.root, key) } }));
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch') }));
    expect(auto.sweep([project, sub, path.join(root, 'deleted'), 'relative/path'])).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['coding-hub-memory']).toEqual(entry(current.executable, current.server, memory.root, key));
  });

  it('says once that an entry Trace did not write turns automatic memory tools off', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': { command: 'node', args: ['mine.js'] } } }));
    const notices: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch'), onNotice: (message) => notices.push(message) }));
    for (let i = 0; i < 2; i++) { const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch); expect(launch.args).not.toContain('--mcp-config'); }
    expect(notices).toHaveLength(1); expect(notices[0]).toContain('did not install');
    // Codex keeps asking before a server Trace did not install runs a tool.
    fs.mkdirSync(path.join(project, '.codex')); fs.writeFileSync(path.join(project, '.codex', 'config.toml'), '[mcp_servers.coding-hub-memory]\ncommand = "node"\nargs = ["mine.js"]\n');
    const codex = { args: [] as string[] }; auto.prepare(run('codex', project), '', info('codex'), codex); expect(codex.args.some((arg) => arg.includes('default_tools_approval_mode'))).toBe(false);
  });

  it('approves memory tools only for an entry that runs this Trace, not any file named memory-server.js', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    const other = path.join(root, 'elsewhere', 'memory-server.js'); fs.mkdirSync(path.dirname(other)); fs.writeFileSync(other, '');
    fs.mkdirSync(path.join(project, '.codex'));
    const write = (command: string, script: string) => fs.writeFileSync(path.join(project, '.codex', 'config.toml'), `[mcp_servers.coding-hub-memory]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify([script, memory.root, key])}\n`);
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch') }));
    const approved = () => { const launch = { args: [] as string[] }; auto.prepare(run('codex', project), '', info('codex'), launch); return launch.args.includes('mcp_servers.coding-hub-memory.default_tools_approval_mode="approve"'); };
    write(current.executable, other); expect(approved()).toBe(false);
    write(process.execPath, current.server); expect(approved()).toBe(false);
    write(current.executable, current.server); expect(approved()).toBe(true);
  });

  it('warns when the entry uses another notes folder, even with the right key', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': entry(current.executable, current.server, path.join(root, 'other-memory'), key) } }));
    const notices: string[] = [];
    const auto = track(new AutoMemory({ memory, enabled: () => true, ...current, scratch: path.join(root, 'scratch'), onNotice: (message) => notices.push(message) }));
    const launch = { args: [] as string[] }; auto.prepare(run('claude', project), '', info('claude'), launch);
    expect(launch.args[launch.args.indexOf('--append-system-prompt') + 1]).toContain('another notes folder');
    expect(notices).toEqual([expect.stringContaining('Use automatic key')]);
  });

  it('switches the entries Trace wrote to the automatic key when asked, keeping other servers and entries it did not write', () => {
    const root = temp(); const project = repository(root, 'project'); const memory = new MemoryService(path.join(root, 'memory')); const current = install(root); const key = projectMemoryKey(project);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' }, 'coding-hub-memory': entry(current.executable, current.server, path.join(root, 'old-memory'), 'coding-hub') } }));
    fs.mkdirSync(path.join(project, '.codex')); fs.writeFileSync(path.join(project, '.codex', 'config.toml'), '[mcp_servers.coding-hub-memory]\ncommand = "node"\nargs = ["mine.js"]\n');
    const codexBefore = fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8');
    expect(memoryEntries(project, memory.root)).toEqual([
      { engine: 'claude', file: path.join(project, '.mcp.json'), key: 'coding-hub', root: path.join(root, 'old-memory'), current: false },
      { engine: 'codex', file: path.join(project, '.codex', 'config.toml'), key: null, root: null, current: false },
    ]);
    expect(useAutomaticKey(project, memory.root, current.server, current.executable)).toEqual([path.join(project, '.mcp.json')]);
    const saved = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers;
    expect(saved['coding-hub-memory']).toEqual(entry(current.executable, current.server, memory.root, key)); expect(saved.other).toEqual({ command: 'other' });
    expect(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).toBe(codexBefore);
    expect(memoryEntries(project, memory.root)[0].current).toBe(true);
    // Asking again changes nothing; a project without Trace's entry says so.
    expect(useAutomaticKey(project, memory.root, current.server, current.executable)).toEqual([]);
    const plain = repository(root, 'plain'); expect(() => useAutomaticKey(plain, memory.root, current.server, current.executable)).toThrow('no coding-hub-memory entry');
  });
});
