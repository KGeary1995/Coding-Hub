import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginBrowseItem, PluginData, PluginPreview } from '../../../shared/plugins';
import { browse, parseSource } from './github';
import { Plugins, type PluginHost } from './plugins';
/** Many real Git commands in each test: a busy Windows runner can take longer than the 5 s default. */
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-gh-')); roots.push(dir); return dir; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

/** A local repository standing in for github.com/owner/plugin, holding a plugin whose build step writes built.txt. */
function repository() {
  const repo = temp(); git(repo, 'init', '-q', '-b', 'main');
  const write = (manifest: Record<string, unknown>) => {
    fs.writeFileSync(path.join(repo, 'trace-plugin.json'), JSON.stringify({ id: 'gh.sample', name: 'GitHub sample', version: '1.0.0', minTrace: '1.35.0', build: [{ command: ['./build.js'] }], ...manifest }));
    fs.writeFileSync(path.join(repo, 'build.js'), "require('fs').writeFileSync(require('path').join(__dirname, 'built.txt'), 'yes')");
    fs.writeFileSync(path.join(repo, 'go.js'), '');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'change'); return git(repo, 'rev-parse', 'HEAD');
  };
  return { repo, write };
}
function setup(repo: string, confirm = true) {
  const root = temp(); const asked: unknown[] = [];
  const host: PluginHost = { version: '1.36.0', confirm: async (preview) => { asked.push(preview); return confirm; }, environment: () => ({ ...process.env } as Record<string, string>), api: () => ({ url: 'http://127.0.0.1:1/x', cli: 'trace' }), context: () => ({}), failed: () => {} };
  return { plugins: new Plugins(root, host, { url: () => repo }), asked, root };
}

describe('plugins from GitHub', () => {
  it('take only owner/repo, an optional folder and a plain branch, tag or commit', () => {
    expect(parseSource('https://github.com/acme/tools/plugins/board.git', 'v1.2')).toMatchObject({ owner: 'acme', name: 'tools', folder: 'plugins/board', ref: 'v1.2' });
    for (const bad of ['acme', 'acme/../x', '-x/y', 'acme/tools; rm -rf /', 'acme/tools/../../etc']) expect(() => parseSource(bad)).toThrow();
    expect(() => parseSource('acme/tools', '--upload-pack=evil')).toThrow(); expect(() => parseSource('acme/tools', 'a..b')).toThrow();
  });

  it('are previewed before anything runs, then installed after the dialog, built, and kept by commit', async () => {
    const { repo, write } = repository(); const first = write({ actions: [{ id: 'go', title: 'Go', command: ['./go.js'] }] });
    const { plugins, asked } = setup(repo);
    const preview = await plugins.execute({ action: 'plugin-fetch', repo: 'owner/plugin' }) as PluginPreview;
    expect(preview).toMatchObject({ repo: 'owner/plugin', commit: first, id: 'gh.sample', update: null });
    expect(preview.commands.map((item) => item.what)).toEqual(expect.arrayContaining(['Action: Go'])); expect(preview.files).toEqual(expect.arrayContaining(['trace-plugin.json', 'build.js', 'go.js']));
    expect(asked).toHaveLength(0);
    const data = await plugins.execute({ action: 'plugin-install', fetchId: preview.fetchId }) as PluginData;
    expect(asked).toHaveLength(1);
    const installed = data.plugins[0]; expect(installed).toMatchObject({ id: 'gh.sample', enabled: true, source: { kind: 'github', repo: 'owner/plugin', commit: first } });
    expect(path.basename(installed.folder)).toBe(first); expect(fs.readFileSync(path.join(installed.folder, 'built.txt'), 'utf8')).toBe('yes');
    await expect(plugins.execute({ action: 'plugin-install', fetchId: preview.fetchId })).rejects.toMatchObject({ code: 'PLUGIN_FETCH' });
  });

  it('say when their branch moved, show what an update changes, keep the version before, and remove their versions', async () => {
    const { repo, write } = repository(); const first = write({ actions: [{ id: 'go', title: 'Go', command: ['./go.js'] }] });
    const { plugins } = setup(repo);
    await plugins.execute({ action: 'plugin-install', fetchId: (await plugins.execute({ action: 'plugin-fetch', repo: 'owner/plugin' }) as PluginPreview).fetchId });
    expect(((await plugins.execute({ action: 'plugin-check' })) as PluginData).plugins[0].update).toBeNull();
    const second = write({ actions: [{ id: 'go', title: 'Go', command: ['./go.js'] }, { id: 'more', title: 'More', command: ['./go.js', 'more'] }], permissions: ['notify'] });
    expect(((await plugins.execute({ action: 'plugin-check' })) as PluginData).plugins[0].update).toBe(second);
    const update = await plugins.execute({ action: 'plugin-fetch', repo: 'owner/plugin' }) as PluginPreview;
    expect(update.update).toMatchObject({ from: first, same: false, newPermissions: ['notify'] }); expect(update.update!.added.map((item) => item.what)).toEqual(['Action: More']);
    const data = await plugins.execute({ action: 'plugin-install', fetchId: update.fetchId }) as PluginData;
    expect(data.plugins[0].source).toMatchObject({ commit: second }); expect(data.plugins[0].update).toBeNull();
    const versions = path.dirname(data.plugins[0].folder);
    expect(fs.readdirSync(versions).sort()).toEqual([first, second, 'data'].sort());
    await plugins.execute({ action: 'plugin-remove', id: 'gh.sample' }); expect(fs.readdirSync(versions)).toEqual(['data']);
  });

  it('are not installed when the person says no, or when a build step fails', async () => {
    const { repo, write } = repository(); write({});
    const refused = setup(repo, false);
    await expect(refused.plugins.execute({ action: 'plugin-install', fetchId: (await refused.plugins.execute({ action: 'plugin-fetch', repo: 'owner/plugin' }) as PluginPreview).fetchId })).rejects.toMatchObject({ code: 'PLUGIN_DECLINED' });
    expect(((await refused.plugins.execute({ action: 'plugin-list' })) as PluginData).plugins).toHaveLength(0);
    fs.writeFileSync(path.join(repo, 'build.js'), 'process.exit(3)'); git(repo, 'commit', '-qam', 'broken');
    const broken = setup(repo);
    await expect(broken.plugins.execute({ action: 'plugin-install', fetchId: (await broken.plugins.execute({ action: 'plugin-fetch', repo: 'owner/plugin' }) as PluginPreview).fetchId })).rejects.toMatchObject({ code: 'PLUGIN_BUILD' });
    expect(((await broken.plugins.execute({ action: 'plugin-list' })) as PluginData).plugins).toHaveLength(0);
  });

  it('browse GitHub’s topic list, keeping only repository names of the right shape', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ items: [{ full_name: 'acme/board', description: 'A board', stargazers_count: 5, pushed_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/acme/board' }, { full_name: '../evil' }] }), { status: 200 })) as typeof fetch;
    const items: PluginBrowseItem[] = await browse(fetcher);
    expect(items).toEqual([{ repo: 'acme/board', description: 'A board', stars: 5, pushedAt: '2026-11-01T00:00:00Z', url: 'https://github.com/acme/board' }]);
    await expect(browse((async () => new Response('', { status: 403 })) as typeof fetch)).rejects.toMatchObject({ code: 'PLUGIN_BROWSE' });
  });
});
