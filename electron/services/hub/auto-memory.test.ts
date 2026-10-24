import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EngineInfo, RunningSession } from '../../../shared/ipc';
import { AutoMemory, lastAssistantMessage, memoryContext, normalizeRemote, projectMemoryKey } from './auto-memory';
import { MemoryService } from './memory';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-memory-'))); roots.push(root); return root; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repository(root: string, name: string, origin?: string) {
  const directory = path.join(root, name); fs.mkdirSync(directory); git(directory, 'init', '-b', 'main');
  fs.writeFileSync(path.join(directory, 'app.txt'), 'baseline\n'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'Baseline');
  if (origin) git(directory, 'remote', 'add', 'origin', origin);
  return directory;
}
const info = (engine: 'claude' | 'codex'): EngineInfo => ({ engine, available: true, executable: '/cli', version: '2.1.310', supportsModel: true, supportsConfig: true, supportsNoDaemon: false, supportsAppendSystemPrompt: true, supportsMcpConfig: true, error: null });
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
    const auto = new AutoMemory({ memory, enabled: () => true, server: '/app/memory-server.js', executable: '/app/electron', scratch: path.join(root, 'scratch') });
    const claude = { args: ['--session-id', 'x'] }; const claudeRun = run('claude', project); auto.prepare(claudeRun, '', info('claude'), claude);
    expect(claude.args[claude.args.indexOf('--append-system-prompt') + 1]).toContain('Use the existing router.');
    expect(claude.args.at(-2)).toBe('--mcp-config');
    expect(JSON.parse(fs.readFileSync(claude.args.at(-1)!, 'utf8')).mcpServers['coding-hub-memory']).toEqual({ command: '/app/electron', args: ['/app/memory-server.js', memory.root, key], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const codex = { args: ['resume', randomUUID()] }; auto.prepare(run('codex', project), '', info('codex'), codex);
    expect(codex.args.slice(0, 1)).toEqual(['resume']); expect(codex.args).toContain(`mcp_servers.coding-hub-memory.args=${JSON.stringify(['/app/memory-server.js', memory.root, key])}`);
    expect(codex.args.find((arg) => arg.startsWith('developer_instructions='))).toContain('Earlier decision');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });
  it('skips the server when the project installed it and does nothing when switched off', () => {
    const root = temp(); const project = repository(root, 'project'); fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'coding-hub-memory': { command: 'x' } } }));
    const memory = new MemoryService(path.join(root, 'memory')); let enabled = true;
    const auto = new AutoMemory({ memory, enabled: () => enabled, server: '/s', executable: '/e', scratch: path.join(root, 'scratch') });
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
    const auto = new AutoMemory({ memory, enabled: () => true, server: '/s', executable: '/e', scratch: path.join(root, 'scratch'), onWrite: (key) => written.push(key) });
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
});
