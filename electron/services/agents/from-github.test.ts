import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentFetched } from '../../../shared/agents';
import type { PluginBrowseItem } from '../../../shared/plugins';
import { setBackupRoot } from '../hub/file-backups';
import { CustomAgents } from './agents';

/** Many real Git commands in each test: a busy Windows runner can take longer than the 5 s default (1.44.0's release failed on it twice). */
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(() => { setBackupRoot(null); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-gh-')); roots.push(dir); return dir; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();
const shared = { schema: 1, id: 'shared-agent', name: 'Shared agent', program: { command: 'shared-agent', args: ['--plain'] }, status: { quietSeconds: 4 } };

/** A local repository standing in for github.com/owner/agent; `files` are written and committed. */
function repository(files: Record<string, string>) {
  const repo = temp(); git(repo, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'agent'); return { repo, commit: git(repo, 'rev-parse', 'HEAD') };
}
/** A store whose dialogs record that they were asked (they must not be), fetching "GitHub" from `repo`. */
function store(repo: string, fetcher?: typeof fetch) {
  const root = temp(); setBackupRoot(root); const asked: string[] = [];
  const agents = new CustomAgents(root, { confirmSave: async (agent) => { asked.push(agent.name); return true; }, confirmRun: async (run) => { asked.push(run.title); return true; } }, { environment: async () => ({ ...process.env as Record<string, string> }), github: { url: () => repo, ...(fetcher ? { fetcher } : {}) } });
  return { root, agents, asked };
}

describe('custom agents from a list', () => {
  it('fetch a repository’s trace-agent.json into a checked draft, without saving it, asking, or running anything', async () => {
    const { repo, commit } = repository({ 'trace-agent.json': JSON.stringify(shared), 'README.md': 'hi' });
    const { root, agents, asked } = store(repo);
    const fetched = await agents.execute({ action: 'agent-fetch', repo: 'https://github.com/owner/agent' }) as AgentFetched;
    expect(fetched).toEqual({ definition: shared, problems: [], source: { repo: 'owner/agent', commit } });
    expect(asked).toEqual([]); expect(fs.existsSync(path.join(root, 'agents'))).toBe(false);
    expect((await agents.list()).agents).toEqual([]);
  });

  it('say what is wrong with a shared definition rather than refuse it, so the form can show it', async () => {
    const { repo } = repository({ 'tools/trace-agent.json': JSON.stringify({ ...shared, program: { command: 'bash' }, extra: true }) });
    const fetched = await store(repo).agents.execute({ action: 'agent-fetch', repo: 'owner/agent/tools' }) as AgentFetched;
    expect(fetched.problems.length).toBeGreaterThan(0); expect(fetched.problems.join(' ')).toMatch(/shell/i);
  });

  it('refuse a repository without the file, one that is not JSON, and a name that is not owner/repo', async () => {
    await expect(store(repository({ 'README.md': 'hi' }).repo).agents.execute({ action: 'agent-fetch', repo: 'owner/agent' })).rejects.toMatchObject({ code: 'AGENT_SOURCE', message: expect.stringContaining('has no trace-agent.json') });
    await expect(store(repository({ 'trace-agent.json': '[1,2]' }).repo).agents.execute({ action: 'agent-fetch', repo: 'owner/agent' })).rejects.toMatchObject({ code: 'AGENT_SOURCE', message: expect.stringContaining('not a JSON object') });
    for (const bad of ['agent', 'owner/../x', 'owner/agent; rm -rf /']) await expect(store(temp()).agents.execute({ action: 'agent-fetch', repo: bad })).rejects.toMatchObject({ code: 'AGENT_SOURCE' });
  });

  it('list repositories with the topic trace-agent, kept for an hour', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ items: [{ full_name: 'acme/aider-agent', description: 'Aider', stargazers_count: 2, pushed_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/acme/aider-agent' }] }), { status: 200 }); }) as typeof fetch;
    const { agents } = store(temp(), fetcher);
    const items = await agents.execute({ action: 'agent-browse' }) as PluginBrowseItem[];
    expect(items).toEqual([{ repo: 'acme/aider-agent', description: 'Aider', stars: 2, pushedAt: '2026-11-01T00:00:00Z', url: 'https://github.com/acme/aider-agent' }]);
    await agents.execute({ action: 'agent-browse' });
    expect(asked).toHaveLength(1); expect(asked[0]).toContain('q=topic:trace-agent');
  });
});
