import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PluginBrowseItem, PluginData, PluginEventName, PluginPreview, PluginRun, PluginSummary } from '../../../shared/plugins';
import { load, save } from '../workbench/local-store';
import { HubError } from '../cli/engine-adapter';
import { commandsOf, PLUGIN_EVENTS, readManifest, type PluginManifest } from './manifest';
import { resolveCommand, runLaunch } from './run';
import { sameToken } from './plugin-api';
import { browse, fetchRepo, latestCommit, listFiles, parseSource, systemGit, githubUrl, type Git, type RepoUrl } from './github';

/**
 * Trace plugins (docs/plugins.md). This file keeps which plugins are installed and whether each is on, links a folder
 * after the person has seen what it runs (`confirm`), and runs plugin actions and event commands, recording each run.
 * Only the main process names a command: the window asks for a plugin's action by its ids, and this looks it up.
 */
const source = z.discriminatedUnion('kind', [z.object({ kind: z.literal('folder'), path: z.string().max(4096) }).strict(), z.object({ kind: z.literal('github'), repo: z.string().max(200), ref: z.string().max(200).optional(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict()]);
const entry = z.object({ id: z.string().max(100), folder: z.string().max(4096), source, enabled: z.boolean(), installedAt: z.iso.datetime() }).strict();
const stateSchema = z.object({ plugins: z.array(entry).max(100) }).strict();
type Entry = z.infer<typeof entry>;
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plugin-list') }).strict(),
  z.object({ action: z.literal('plugin-link'), folder: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('plugin-enable'), id: z.string().max(100), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('plugin-remove'), id: z.string().max(100), removeData: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('plugin-run'), id: z.string().max(100), actionId: z.string().max(64), sessionId: z.string().max(100).optional(), repository: z.string().max(4096).optional() }).strict(),
  z.object({ action: z.literal('plugin-log'), id: z.string().max(100) }).strict(),
  z.object({ action: z.literal('plugin-fetch'), repo: z.string().min(1).max(300), ref: z.string().max(100).optional() }).strict(),
  z.object({ action: z.literal('plugin-install'), fetchId: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  z.object({ action: z.literal('plugin-check') }).strict(),
  z.object({ action: z.literal('plugin-browse') }).strict(),
]);
/** What a plugin's program is told about where it runs, besides the API address. */
export interface PluginContext { project?: string | null; channel?: number | null; channelName?: string | null; folder?: string | null; branch?: string | null; message?: string | null; event?: string | null }
export interface PluginHost {
  version: string;
  /** Shows the preview and asks the person; true when they chose to go on. */
  confirm(preview: { title: string; folder: string; manifest: PluginManifest; commands: { what: string; command: string[] }[] }): Promise<boolean>;
  environment(): Record<string, string>;
  /** The plugin API's address for a plugin, and the `trace` helper's path. */
  api(pluginId: string, token: string): { url: string; cli: string };
  /** What an action is about, from the channel it was asked on (the window's id for it). */
  context(sessionId?: string, repository?: string): PluginContext;
  /** A notice in Trace that a plugin's run failed. */
  failed(name: string, what: string, why: string): void;
}
const ACTION_MS = 5 * 60_000; const EVENT_MS = 30_000; const GAP_MS = 10_000; const KEEP_RUNS = 50;
/** A build step's limit, a fetched preview's life, and how long the browse list is kept. */
const BUILD_MS = 10 * 60_000; const FETCH_MS = 30 * 60_000; const BROWSE_MS = 60 * 60_000;

export class Plugins {
  private runs = new Map<string, PluginRun[]>();
  private children = new Map<string, Set<ChildProcess>>();
  private tokens = new Map<string, string>();
  private last = new Map<string, number>();
  private failures = new Map<string, number>();
  /** Fetched repositories waiting for Install in their preview, by id. */
  private fetched = new Map<string, { dir: string; folder: string; repo: string; ref?: string; commit: string; at: number }>();
  /** The commit each GitHub plugin's branch or tag is at now, from the last check. */
  private latest = new Map<string, string>(); private browsed: { at: number; items: PluginBrowseItem[] } | null = null;
  constructor(private root: string, private host: PluginHost, private github: { git?: Git; url?: RepoUrl; fetcher?: typeof fetch } = {}) {}
  get folder() { return path.join(this.root, 'plugins'); }
  private state() { return load(this.folder, 'installed.json', stateSchema, { plugins: [] }).plugins; }
  private store(plugins: Entry[]) { save(this.folder, 'installed.json', { plugins }); }
  /** The plugin's own data folder, kept across updates. */
  dataFolder(id: string) { return path.join(this.folder, id.replace(/[^A-Za-z0-9._-]/g, '_'), 'data'); }
  /** A plugin's API secret: made when it first runs in this session, gone when it is turned off or removed. */
  tokenOf(id: string) { let token = this.tokens.get(id); if (!token) { token = randomBytes(32).toString('hex'); this.tokens.set(id, token); } return token; }
  /** The plugin a secret belongs to, if it is still installed and on. */
  pluginOfToken(id: string, token: string): PluginSummary | null {
    const own = this.tokens.get(id); if (!own || !sameToken(own, token)) return null;
    const found = this.data().plugins.find((item) => item.id === id); return found?.enabled && !found.problem ? found : null;
  }

  data(): PluginData {
    return { plugins: this.state().map((item): PluginSummary => {
      let manifest: PluginManifest | null = null; let problem: string | null = null;
      try { manifest = readManifest(item.folder, this.host.version); } catch (error) { problem = error instanceof Error ? error.message : 'Its manifest could not be read.'; }
      return { id: item.id, name: manifest?.name ?? item.id, version: manifest?.version ?? '', description: manifest?.description ?? '', folder: item.folder, source: item.source, enabled: item.enabled, problem,
        permissions: manifest?.permissions ?? [], actions: manifest?.actions.map(({ id, title, context }) => ({ id, title, context })) ?? [], events: manifest?.events.map((event) => event.on) ?? [], tiles: manifest?.tiles.map(({ id, title }) => ({ id, title })) ?? [],
        update: item.source.kind === 'github' && this.latest.has(item.id) && this.latest.get(item.id) !== item.source.commit ? this.latest.get(item.id)! : null,
        failures: this.failures.get(item.id) ?? 0, lastRun: this.runs.get(item.id)?.[0] ? { ...this.runs.get(item.id)![0], output: '' } : null };
    }) };
  }

  async execute(input: unknown): Promise<PluginData | PluginRun[] | PluginPreview | PluginBrowseItem[] | null> {
    const request = requestSchema.parse(input);
    if (request.action === 'plugin-list') return this.data();
    if (request.action === 'plugin-log') return this.runs.get(request.id) ?? [];
    if (request.action === 'plugin-browse') { if (!this.browsed || Date.now() - this.browsed.at > BROWSE_MS) this.browsed = { at: Date.now(), items: await browse(this.github.fetcher) }; return this.browsed.items; }
    if (request.action === 'plugin-check') { await this.checkUpdates(); return this.data(); }
    if (request.action === 'plugin-fetch') return this.fetchPreview(request.repo, request.ref);
    if (request.action === 'plugin-install') return this.install(request.fetchId);
    const plugins = this.state();
    if (request.action === 'plugin-link') {
      const folder = path.resolve(request.folder);
      if (!path.isAbsolute(request.folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new HubError('PLUGIN_FOLDER', 'Choose the plugin\'s folder, the one holding trace-plugin.json.');
      const manifest = readManifest(folder, this.host.version);
      if (plugins.some((item) => item.id === manifest.id)) throw new HubError('PLUGIN_EXISTS', `${manifest.name} (${manifest.id}) is already installed. Remove it first.`);
      if (!await this.host.confirm({ title: `Link ${manifest.name}`, folder, manifest, commands: commandsOf(manifest) })) throw new HubError('PLUGIN_DECLINED', 'The plugin was not added.');
      this.store([...plugins, { id: manifest.id, folder, source: { kind: 'folder', path: folder }, enabled: true, installedAt: new Date().toISOString() }]);
      fs.mkdirSync(this.dataFolder(manifest.id), { recursive: true, mode: 0o700 });
      return this.data();
    }
    const found = plugins.find((item) => item.id === request.id); if (!found) throw new HubError('PLUGIN_MISSING', 'That plugin is not installed.');
    if (request.action === 'plugin-enable') {
      this.store(plugins.map((item) => item.id === found.id ? { ...item, enabled: request.enabled } : item));
      if (!request.enabled) this.stop(found.id); else this.failures.delete(found.id);
      return this.data();
    }
    if (request.action === 'plugin-remove') {
      this.stop(found.id); this.store(plugins.filter((item) => item.id !== found.id)); this.runs.delete(found.id); this.failures.delete(found.id); this.latest.delete(found.id);
      if (request.removeData) fs.rmSync(path.dirname(this.dataFolder(found.id)), { recursive: true, force: true });
      // A plugin from GitHub: its versions go too (a linked folder stays where it is).
      else if (found.source.kind === 'github') this.removeVersions(found.id, []);
      return this.data();
    }
    // plugin-run: an action the person chose in the command menu.
    if (!found.enabled) throw new HubError('PLUGIN_OFF', 'That plugin is turned off.');
    const manifest = readManifest(found.folder, this.host.version); const action = manifest.actions.find((item) => item.id === request.actionId);
    if (!action) throw new HubError('PLUGIN_ACTION', 'That plugin has no such action now.');
    void this.run(found, manifest.name, `Action: ${action.title}`, action.command, this.host.context(request.sessionId, request.repository), ACTION_MS);
    return null;
  }

  /** Where a GitHub plugin's versions are kept: `plugins/<id>/<commit>/`, beside its `data/`. */
  private versions(id: string) { return path.dirname(this.dataFolder(id)); }
  /** Removes a plugin's versions but those in `keep` (the new one, and the one before, which a program may still run). */
  private removeVersions(id: string, keep: string[]) {
    let names: string[]; try { names = fs.readdirSync(this.versions(id)); } catch { return; }
    const kept = new Set(keep.map((folder) => path.resolve(folder)));
    for (const name of names) { const folder = path.join(this.versions(id), name); if (name !== 'data' && /^[0-9a-f]{40}$/.test(name) && !kept.has(path.resolve(folder))) try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* In use: next time. */ } }
  }

  /** Fetches a repository and says what installing it would add (docs/plugins.md, section 6); nothing runs yet. */
  private async fetchPreview(repo: string, ref?: string): Promise<PluginPreview> {
    const source = parseSource(repo, ref); const fetchId = randomBytes(8).toString('hex');
    for (const [id, item] of this.fetched) if (Date.now() - item.at > FETCH_MS) { this.fetched.delete(id); fs.rm(item.dir, { recursive: true, force: true }, () => {}); }
    const dir = path.join(this.folder, '.fetch', fetchId);
    try {
      const commit = await fetchRepo(source, dir, this.github.git ?? systemGit, this.github.url ?? githubUrl);
      const folder = source.folder ? path.join(dir, ...source.folder.split('/')) : dir;
      if (path.relative(dir, folder).startsWith('..') || !fs.existsSync(folder)) throw new HubError('PLUGIN_SOURCE', `${source.repo} has no folder ${source.folder}.`);
      const manifest = readManifest(folder, this.host.version);
      const existing = this.state().find((item) => item.id === manifest.id);
      if (existing?.source.kind === 'folder') throw new HubError('PLUGIN_EXISTS', `${manifest.name} (${manifest.id}) is linked from a folder here. Remove it first to install it from GitHub.`);
      let before: PluginManifest | null = null; if (existing) try { before = readManifest(existing.folder, this.host.version); } catch { /* Shown as all new. */ }
      const commands = commandsOf(manifest); const key = (item: { what: string; command: string[] }) => `${item.what}|${item.command.join(' ')}`;
      const old = new Set(before ? commandsOf(before).map(key) : []); const now = new Set(commands.map(key));
      this.fetched.set(fetchId, { dir, folder, repo: source.repo, ...(source.ref ? { ref: source.ref } : {}), commit, at: Date.now() });
      return { fetchId, repo: source.repo, ...(source.ref ? { ref: source.ref } : {}), commit, id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description ?? '', permissions: manifest.permissions, commands, files: listFiles(folder),
        update: existing?.source.kind === 'github' ? { from: existing.source.commit, same: existing.source.commit === commit, added: commands.filter((item) => !old.has(key(item))), removed: before ? commandsOf(before).filter((item) => !now.has(key(item))) : [], newPermissions: manifest.permissions.filter((item) => !before?.permissions.includes(item)) } : null };
    } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  }

  /** Installs (or updates to) a fetched preview, after the system dialog shows what it runs: build steps, then into place. */
  private async install(fetchId: string): Promise<PluginData> {
    const fetched = this.fetched.get(fetchId); if (!fetched) throw new HubError('PLUGIN_FETCH', 'That preview has expired. Fetch the plugin again.');
    const manifest = readManifest(fetched.folder, this.host.version); const existing = this.state().find((item) => item.id === manifest.id);
    if (!await this.host.confirm({ title: `${existing ? 'Update' : 'Install'} ${manifest.name} from ${fetched.repo}`, folder: `${fetched.repo} at ${fetched.commit.slice(0, 12)}`, manifest, commands: commandsOf(manifest) })) throw new HubError('PLUGIN_DECLINED', 'The plugin was not installed.');
    this.fetched.delete(fetchId);
    try {
      const data = this.dataFolder(manifest.id); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      const entry: Entry = { id: manifest.id, folder: fetched.folder, source: { kind: 'github', repo: fetched.repo, ...(fetched.ref ? { ref: fetched.ref } : {}), commit: fetched.commit }, enabled: true, installedAt: new Date().toISOString() };
      // Its build steps, in the fetched folder, each shown in its runs (stopped after 10 minutes).
      for (const step of manifest.build) {
        const before = this.runs.get(manifest.id)?.[0];
        await this.run(entry, manifest.name, `Build: ${step.command.join(' ')}`, step.command, {}, BUILD_MS);
        const result = this.runs.get(manifest.id)?.[0]; if (!result || result === before || !result.ok) throw new HubError('PLUGIN_BUILD', `${manifest.name}'s build step ${step.command.join(' ')} failed: ${result?.note ?? 'it did not run'}. See its runs.`);
      }
      const target = path.join(this.versions(manifest.id), fetched.commit);
      if (path.resolve(target) !== path.resolve(existing?.folder ?? '')) { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(fetched.folder, target); }
      // Git's own copy is not needed to run the plugin. Windows refuses to delete its read-only object files for a
      // moment after git exits (EPERM), so it is retried, and left if it still cannot be removed.
      try { fs.rmSync(path.join(target, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Takes some space; harmless. */ }
      const plugins = this.state(); const kept = { ...entry, folder: target, enabled: existing?.enabled ?? true, installedAt: existing?.installedAt ?? entry.installedAt };
      this.store(existing ? plugins.map((item) => item.id === manifest.id ? kept : item) : [...plugins, kept]);
      // Programs already running keep the version they started with (herdr's install lease): the one before stays.
      this.removeVersions(manifest.id, [target, ...(existing ? [existing.folder] : [])]);
      this.latest.delete(manifest.id); this.failures.delete(manifest.id);
      return this.data();
    } catch (error) {
      // A file that could not be moved or removed says why, rather than Trace's general message.
      if (error instanceof HubError) throw error;
      throw new HubError('PLUGIN_INSTALL', `The plugin could not be put in place: ${error instanceof Error ? error.message : String(error)}`);
    } finally { fs.rm(fetched.dir, { recursive: true, force: true }, () => {}); }
  }

  /** Asks GitHub where each GitHub plugin's branch or tag is now (never installs anything). */
  async checkUpdates() {
    for (const item of this.state()) if (item.source.kind === 'github') try {
      const commit = await latestCommit(parseSource(item.source.repo, item.source.ref), this.github.git ?? systemGit, this.github.url ?? githubUrl); if (commit) this.latest.set(item.id, commit);
    } catch { /* Offline, or the repository is gone: shown again at the next check. */ }
  }

  /**
   * A plugin tile's program, from the installed manifest (never from the window), with the plugin's API in its
   * environment as for its actions. Refused when the plugin is gone, off or broken, or has no such tile here.
   */
  tile(id: string, tileId: string) {
    const found = this.state().find((item) => item.id === id); if (!found) throw new HubError('PLUGIN_MISSING', `The plugin ${id} is not installed any more. Install it again, or close this tile.`);
    if (!found.enabled) throw new HubError('PLUGIN_OFF', `The plugin ${id} is turned off. Turn it on in Skills & plugins to start this tile.`);
    const manifest = readManifest(found.folder, this.host.version); const tile = manifest.tiles.find((item) => item.id === tileId);
    if (!tile) throw new HubError('PLUGIN_TILE', `${manifest.name} has no tile ${tileId} on this computer now.`);
    const { url, cli } = this.host.api(found.id, this.tokenOf(found.id)); const data = this.dataFolder(found.id); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    const env = { ...this.host.environment(), TRACE_PLUGIN_ID: found.id, TRACE_PLUGIN_DATA: data, TRACE_API_URL: url, TRACE_CLI: cli };
    return { ...resolveCommand(found.folder, tile.command, env), title: tile.title };
  }

  /** Runs every plugin's commands for an event, without waiting; one per plugin and channel every 10 seconds. */
  fire(event: PluginEventName, key: string, context: PluginContext) {
    if (!PLUGIN_EVENTS.includes(event)) return;
    let plugins: Entry[]; try { plugins = this.state(); } catch { return; }
    for (const item of plugins) {
      if (!item.enabled) continue;
      let manifest: PluginManifest; try { manifest = readManifest(item.folder, this.host.version); } catch { continue; }
      for (const [index, hook] of manifest.events.entries()) {
        if (hook.on !== event) continue;
        const gate = `${item.id}:${index}:${key}`; if (Date.now() - (this.last.get(gate) ?? 0) < GAP_MS) continue; this.last.set(gate, Date.now());
        void this.run(item, manifest.name, `On ${event}`, hook.command, { ...context, event }, EVENT_MS);
      }
    }
  }

  private async run(item: Entry, name: string, what: string, command: string[], context: PluginContext, timeoutMs: number) {
    const startedAt = new Date().toISOString(); const record = (result: Omit<PluginRun, 'what' | 'startedAt' | 'endedAt' | 'command'>) => {
      const run: PluginRun = { what, command, startedAt, endedAt: new Date().toISOString(), ...result };
      this.runs.set(item.id, [run, ...(this.runs.get(item.id) ?? [])].slice(0, KEEP_RUNS));
      if (run.ok) this.failures.delete(item.id); else { this.failures.set(item.id, (this.failures.get(item.id) ?? 0) + 1); this.host.failed(name, what, run.note); }
    };
    let launch; try {
      const { url, cli } = this.host.api(item.id, this.tokenOf(item.id)); const data = this.dataFolder(item.id); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      const env = { ...this.host.environment(), TRACE_PLUGIN_ID: item.id, TRACE_PLUGIN_DATA: data, TRACE_API_URL: url, TRACE_CLI: cli, TRACE_EVENT: context.event ?? '', TRACE_PROJECT: context.project ?? '', TRACE_CHANNEL: context.channel ? String(context.channel) : '', TRACE_CHANNEL_NAME: context.channelName ?? '', TRACE_FOLDER: context.folder ?? '', TRACE_BRANCH: context.branch ?? '', TRACE_MESSAGE: (context.message ?? '').slice(0, 2000) };
      launch = resolveCommand(item.folder, command, env);
    } catch (error) { record({ ok: false, code: null, note: error instanceof Error ? error.message : 'It could not start.', output: '' }); return; }
    const set = this.children.get(item.id) ?? new Set(); this.children.set(item.id, set);
    let child: ChildProcess | undefined;
    const result = await runLaunch(launch, item.folder, timeoutMs, (started) => { child = started; set.add(started); });
    if (child) set.delete(child);
    record({ ok: result.code === 0 && !result.timedOut, code: result.code, output: result.output, note: result.error ?? (result.timedOut ? `Stopped after ${Math.round(timeoutMs / 1000)} seconds` : result.code === 0 ? 'Ran' : `Exited with code ${result.code ?? result.signal}`) });
  }

  /** Stops a plugin's running programs, and its API secret stops working. */
  stop(id: string) { for (const child of this.children.get(id) ?? []) child.kill(); this.children.delete(id); this.tokens.delete(id); }
  close() { for (const id of [...this.children.keys()]) this.stop(id); this.tokens.clear(); }
}
