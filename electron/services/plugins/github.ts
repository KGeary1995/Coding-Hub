import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HubError } from '../cli/engine-adapter';

/**
 * Plugins from GitHub (docs/plugins.md, sections 6 and 8): fetched with the computer's own `git`, so a private repository
 * works with the sign-in Git already has (Git Credential Manager, `gh auth setup-git`) and Trace never sees a token.
 */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._ -]{1,100}){0,5}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;

/** `owner/repo` or `owner/repo/folder…`, and an optional branch, tag or commit: checked before any of it reaches git. */
export function parseSource(repo: string, ref?: string) {
  const value = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO.test(value) || value.split('/').some((part) => part === '.' || part === '..')) throw new HubError('PLUGIN_SOURCE', 'Enter a GitHub repository as owner/repo, or owner/repo/folder for a plugin inside it.');
  const wanted = ref?.trim() || undefined;
  if (wanted && (!REF.test(wanted) || wanted.includes('..'))) throw new HubError('PLUGIN_SOURCE', 'A branch, tag or commit is letters, digits, dot, slash, underscore and hyphen.');
  const [owner, name, ...folder] = value.split('/');
  return { repo: value, owner, name, folder: folder.join('/'), ref: wanted };
}

export type Git = (args: string[], cwd?: string) => Promise<string>;
/** The computer's git, never through a shell, never asking in a terminal (there is none), with a time limit. */
export const systemGit: Git = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    reject(new HubError('PLUGIN_GIT', missing ? 'Git is not installed on this computer. Install it from git-scm.com, then try again.' : `Git could not fetch it: ${String(stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)} (a private repository needs Git signed in to GitHub on this computer).`));
  });
});

/** Where a repository is fetched from: GitHub, or a folder in tests. */
export type RepoUrl = (owner: string, name: string) => string;
export const githubUrl: RepoUrl = (owner, name) => `https://github.com/${owner}/${name}.git`;

/** A shallow copy of the branch, tag or commit in `into`; returns its exact commit. */
export async function fetchRepo(source: ReturnType<typeof parseSource>, into: string, git: Git = systemGit, url: RepoUrl = githubUrl) {
  const remote = url(source.owner, source.name);
  fs.mkdirSync(into, { recursive: true });
  if (source.ref && SHA.test(source.ref)) {
    await git(['init', '-q', into]); await git(['fetch', '-q', '--depth', '1', '--', remote, source.ref], into); await git(['checkout', '-q', 'FETCH_HEAD'], into);
  } else await git(['clone', '-q', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', remote, into]);
  const commit = (await git(['rev-parse', 'HEAD'], into)).trim();
  if (!SHA.test(commit)) throw new HubError('PLUGIN_GIT', 'Git did not say which commit it fetched.');
  return commit;
}

/** The commit a branch or tag (or the default branch) is at now, without fetching it. */
export async function latestCommit(source: ReturnType<typeof parseSource>, git: Git = systemGit, url: RepoUrl = githubUrl) {
  if (source.ref && SHA.test(source.ref)) return source.ref;
  const out = await git(['ls-remote', '--', url(source.owner, source.name), source.ref ?? 'HEAD']);
  const lines = out.split('\n').map((line) => line.split('\t')); const wanted = source.ref;
  // A tag's own commit (the ^{} line) comes before the tag object, so a tag reports the commit it names.
  const line = (wanted ? lines.find((item) => item[1] === `refs/tags/${wanted}^{}`) ?? lines.find((item) => item[1] === `refs/heads/${wanted}` || item[1] === `refs/tags/${wanted}`) : lines[0]);
  return line && SHA.test(line[0]) ? line[0] : null;
}

/** The files a plugin's folder holds, for the preview (at most `limit`, `.git` left out). */
export function listFiles(folder: string, limit = 300) {
  const files: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (files.length >= limit) return; if (entry.name === '.git') continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(path.relative(folder, full).split(path.sep).join('/')); } };
  walk(folder); return files;
}

export interface BrowseItem { repo: string; description: string; stars: number; pushedAt: string; url: string }
/** Repositories with a topic (`trace-plugin`, or `trace-agent` for custom agents), from GitHub's public search (unsigned: ten a minute). */
export async function browse(fetcher: typeof fetch = fetch, topic: 'trace-plugin' | 'trace-agent' = 'trace-plugin'): Promise<BrowseItem[]> {
  const response = await fetcher(`https://api.github.com/search/repositories?q=topic:${topic}&sort=stars&order=desc&per_page=50`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trace' } });
  if (response.status === 403 || response.status === 429) throw new HubError('PLUGIN_BROWSE', 'GitHub asks to wait before searching again. Try again in a minute.');
  if (!response.ok) throw new HubError('PLUGIN_BROWSE', `GitHub's search did not answer (${response.status}).`);
  const body = await response.json() as { items?: { full_name?: unknown; description?: unknown; stargazers_count?: unknown; pushed_at?: unknown; html_url?: unknown }[] };
  return (body.items ?? []).flatMap((item) => typeof item.full_name === 'string' && REPO.test(item.full_name) ? [{ repo: item.full_name, description: typeof item.description === 'string' ? item.description.slice(0, 300) : '', stars: Number(item.stargazers_count) || 0, pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : '', url: typeof item.html_url === 'string' && item.html_url.startsWith('https://github.com/') ? item.html_url : `https://github.com/${item.full_name}` }] : []);
}

/** A topic's list, kept for an hour, so opening the list again does not use up the unsigned search limit. */
export function topicList(topic: 'trace-plugin' | 'trace-agent', fetcher?: typeof fetch, keepMs = 60 * 60_000) {
  let kept: { at: number; items: BrowseItem[] } | null = null;
  return async () => { if (!kept || Date.now() - kept.at > keepMs) kept = { at: Date.now(), items: await browse(fetcher, topic) }; return kept.items; };
}
