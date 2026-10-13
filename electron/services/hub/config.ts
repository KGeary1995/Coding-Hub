import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { HubError } from '../cli/engine-adapter';
import type { ConfigInventory, HubRequest } from '../../../shared/hub';
import type { CLIEngine, MCPConfig } from '../../../shared/types';

type ObjectMap = Record<string, any>;
interface Source { file: string; engine: CLIEngine; scope: 'user' | 'project'; directory: string | null; slot: string; hash: string; kind: 'server' | 'skill' | 'plugin'; local?: boolean }
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): ObjectMap => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectMap : {};
function checkFile(file: string) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new HubError('CONFIG_SYMLINK', 'Configuration paths containing symbolic links cannot be edited.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
export function readConfig(file: string): { data: ObjectMap; hash: string; text: string } {
  checkFile(file);
  let text = '';
  try { if (fs.statSync(file).size > 2 * 1024 * 1024) throw new HubError('CONFIG_SIZE', 'Configuration exceeds the 2 MiB inspection limit.'); text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  try { const data = text.trim() ? (file.endsWith('.toml') ? TOML.parse(text) : JSON.parse(text)) : {}; if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return { data, hash: digest(text), text }; }
  catch { throw new HubError('CONFIG_PARSE', `Cannot parse ${file}. Existing configuration was preserved.`); }
}
/** Compare before replacement; keep private backups and unknown settings. TOML comments normalize. */
export function updateConfig(file: string, expectedHash: string | null, edit: (data: ObjectMap) => void) {
  const before = readConfig(file);
  if (expectedHash !== null && before.hash !== expectedHash) throw new HubError('CONFIG_CHANGED', 'Configuration changed since inspection. Refresh before editing.');
  edit(before.data);
  const next = file.endsWith('.toml') ? TOML.stringify(before.data as TOML.JsonMap) : JSON.stringify(before.data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); checkFile(file);
  if (before.text) fs.writeFileSync(file + '.coding-hub-backup-' + randomUUID(), before.text, { mode: 0o600, flag: 'wx' });
  const temp = file + '.coding-hub-' + randomUUID();
  try { fs.writeFileSync(temp, next, { flag: 'wx', mode: 0o600 }); if (readConfig(file).hash !== before.hash) throw new HubError('CONFIG_CHANGED', 'Configuration changed during save. Refresh and retry.'); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch { /* Renamed or absent. */ } }
}
function publicURL(raw: string) { try { const url = new URL(raw); url.username = ''; url.password = ''; for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]'); return url.href; } catch { return '[invalid URL]'; } }
function publicArgs(args: unknown): string[] { if (!Array.isArray(args)) return []; let hidden = false; return args.map((a) => { const s = String(a); if (hidden) { hidden = false; return '[redacted]'; } if (/token|password|secret|api[_-]?key|authorization/i.test(s)) { hidden = !s.includes('='); return s.split('=')[0] + (s.includes('=') ? '=[redacted]' : ''); } return s; }).slice(0, 100); }

export class ConfigService {
  private handles = new Map<string, Source>();
  constructor(readonly home = homedir(), readonly claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), readonly codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex')) {}
  private directory(directory: string | null) { if (directory !== null && (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory())) throw new HubError('PROJECT_PATH', 'Select an accessible absolute project directory.'); return directory === null ? null : fs.realpathSync(directory); }
  private file(engine: CLIEngine, scope: 'user' | 'project', directory: string | null) {
    if (scope === 'project' && !directory) throw new HubError('PROJECT_REQUIRED', 'Select a project first.');
    const claudeUser = process.env.CLAUDE_CONFIG_DIR && this.home === homedir() ? this.claudeHome : this.home;
    return engine === 'claude' ? scope === 'project' ? path.join(directory!, '.mcp.json') : fs.existsSync(path.join(this.claudeHome, '.config.json')) ? path.join(this.claudeHome, '.config.json') : path.join(claudeUser, '.claude.json') : scope === 'project' ? path.join(directory!, '.codex', 'config.toml') : path.join(this.codexHome, 'config.toml');
  }
  inventory(input: string | null): ConfigInventory {
    const directory = this.directory(input); const result: ConfigInventory = { servers: [], extensions: [], warnings: [] }; this.handles.clear();
    for (const engine of ['claude', 'codex'] as const) for (const scope of ['user', 'project'] as const) {
      if (scope === 'project' && !directory) continue;
      const file = this.file(engine, scope, directory);
      try {
        const { data, hash } = readConfig(file); const servers = object(engine === 'claude' ? data.mcpServers : data.mcp_servers);
        let disabled: string[] = [];
        if (engine === 'claude' && directory) {
          const user = readConfig(this.file('claude', 'user', directory)).data;
          disabled = scope === 'user' ? object(object(user.projects)[directory]).disabledMcpServers ?? [] : readConfig(path.join(directory, '.claude', 'settings.local.json')).data.disabledMcpjsonServers ?? [];
        }
        for (const [name, value] of Object.entries(servers)) {
          const raw = object(value); const id = randomUUID(); this.handles.set(id, { file, engine, scope, directory, slot: name, hash, kind: 'server' });
          const transport: MCPConfig['transport'] = raw.url ? { type: raw.type === 'sse' ? 'sse' : 'http', url: publicURL(String(raw.url)), headerSecretNames: Object.keys(object(raw.headers ?? raw.http_headers)).concat(Object.keys(object(raw.env_http_headers))) } : { type: 'stdio', command: String(raw.command ?? ''), args: publicArgs(raw.args), envVariableNames: [...new Set([...Object.keys(object(raw.env)), ...(Array.isArray(raw.env_vars) ? raw.env_vars.filter((s: unknown) => typeof s === 'string') : [])])] };
          result.servers.push({ id, name, engine, enabled: engine === 'codex' ? raw.enabled !== false : !disabled.includes(name), transport, source: { path: file, scope, format: engine === 'codex' ? 'toml' : 'json' }, status: 'unknown' });
        }
        if (engine === 'claude' && scope === 'user' && directory) {
          for (const [name, rawValue] of Object.entries(object(object(object(data.projects)[directory]).mcpServers))) {
            const raw = object(rawValue); const id = randomUUID(); this.handles.set(id, { file, engine, scope, directory, slot: name, hash, kind: 'server', local: true });
            result.servers.push({ id, name, engine, enabled: !disabled.includes(name), transport: raw.url ? { type: 'http', url: publicURL(String(raw.url)), headerSecretNames: Object.keys(object(raw.headers)) } : { type: 'stdio', command: String(raw.command ?? ''), args: publicArgs(raw.args), envVariableNames: Object.keys(object(raw.env)) }, source: { path: file, scope: 'project', format: 'json' }, status: 'unknown' });
          }
        }
        this.configExtensions(data, file, engine, scope, directory, hash, result);
      } catch (error) { result.warnings.push(error instanceof HubError ? error.message : `Cannot inspect ${file}.`); }
    }
    const roots: { root: string; engine: CLIEngine; scope: 'user' | 'project' }[] = [ { root: this.claudeHome, engine: 'claude', scope: 'user' }, { root: this.codexHome, engine: 'codex', scope: 'user' }, { root: path.join(this.home, '.agents'), engine: 'codex', scope: 'user' } ];
    if (directory) roots.push({ root: path.join(directory, '.claude'), engine: 'claude', scope: 'project' }, { root: path.join(directory, '.codex'), engine: 'codex', scope: 'project' }, { root: path.join(directory, '.agents'), engine: 'codex', scope: 'project' });
    const inspect = (file: string, engine: CLIEngine, scope: 'user' | 'project', kind: 'memory' | 'skill' | 'plugin', name?: string) => {
      try { checkFile(file); if (!fs.statSync(file).isFile()) return; const size = fs.statSync(file).size; if (size > 256 * 1024) { result.warnings.push(`Inspection limit: ${file}`); return; } const preview = fs.readFileSync(file, 'utf8').slice(0, 32000); const id = randomUUID();
        let enabled: boolean | null = null;
        if (kind === 'skill' && engine === 'codex') { const target = this.file(engine, 'user', directory); const cfg = readConfig(target); const skillPath = path.dirname(file); const entry = (Array.isArray(cfg.data.skills?.config) ? cfg.data.skills.config : []).find((s: ObjectMap) => s.path === skillPath); enabled = entry?.enabled !== false; this.handles.set(id, { file: target, engine, scope: 'user', directory, hash: cfg.hash, slot: skillPath, kind: 'skill' }); }
        result.extensions.push({ id, engine, scope, kind, name: name ?? path.basename(path.dirname(file)), path: file, preview, enabled });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.warnings.push(`Cannot inspect ${file}.`); }
    };
    for (const root of roots) {
      inspect(path.join(root.root, root.engine === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), root.engine, root.scope, 'memory');
      try { for (const entry of fs.readdirSync(path.join(root.root, 'skills'), { withFileTypes: true }).slice(0, 200)) if (entry.isDirectory()) {
        inspect(path.join(root.root, 'skills', entry.name, 'SKILL.md'), root.engine, root.scope, 'skill', entry.name);
        if (entry.name === '.system') for (const child of fs.readdirSync(path.join(root.root, 'skills', entry.name), { withFileTypes: true }).slice(0, 100)) if (child.isDirectory()) inspect(path.join(root.root, 'skills', entry.name, child.name, 'SKILL.md'), root.engine, root.scope, 'skill', child.name);
      } } catch { /* No skills directory. */ }
      let inspected = 0;
      const plugins = (folder: string, depth: number) => { if (depth > 4 || inspected++ > 300) return; try { for (const child of fs.readdirSync(folder, { withFileTypes: true }).slice(0, 100)) if (child.isDirectory()) { if (['.claude-plugin', '.codex-plugin'].includes(child.name)) inspect(path.join(folder, child.name, 'plugin.json'), root.engine, root.scope, 'plugin', path.basename(folder)); else plugins(path.join(folder, child.name), depth + 1); } } catch { /* Optional cache. */ } };
      plugins(path.join(root.root, 'plugins', 'cache'), 0);
      if (root.engine === 'claude') {
        for (const settings of ['settings.json', 'settings.local.json']) try { const file = path.join(root.root, settings); const cfg = readConfig(file); this.configExtensions(cfg.data, file, root.engine, root.scope, directory, cfg.hash, result); } catch { result.warnings.push(`Cannot inspect ${path.join(root.root, settings)}.`); }
        try { const plugins = readConfig(path.join(root.root, 'plugins', 'installed_plugins.json')).data; for (const [name, records] of Object.entries(object(plugins.plugins))) for (const entry of (Array.isArray(records) ? records : []).slice(0, 10)) if (typeof entry.installPath === 'string') inspect(path.join(entry.installPath, '.claude-plugin', 'plugin.json'), 'claude', root.scope, 'plugin', name); } catch { /* Optional plugin registry. */ }
      }
    }
    if (directory) { inspect(path.join(directory, 'CLAUDE.md'), 'claude', 'project', 'memory', 'CLAUDE.md'); inspect(path.join(directory, 'CLAUDE.local.md'), 'claude', 'project', 'memory', 'CLAUDE.local.md'); inspect(path.join(directory, 'AGENTS.md'), 'codex', 'project', 'memory', 'AGENTS.md'); }
    if (fs.existsSync(path.join(this.claudeHome, 'mcp.json'))) result.warnings.push('A legacy ~/.claude/mcp.json was found. Current Claude Code uses .claude.json / project .mcp.json; the legacy file is not automatically activated.');
    return result;
  }
  private configExtensions(data: ObjectMap, file: string, engine: CLIEngine, scope: 'user' | 'project', directory: string | null, hash: string, result: ConfigInventory) {
    const plugins = object(engine === 'claude' ? data.enabledPlugins : data.plugins);
    for (const [name, setting] of Object.entries(plugins)) { if (name === '_default') continue; const id = randomUUID(); this.handles.set(id, { file, engine, scope, directory, hash, slot: name, kind: 'plugin' }); result.extensions.push({ id, engine, scope, kind: 'plugin', name, path: file, enabled: engine === 'claude' ? setting === true : object(setting).enabled !== false, preview: `Configured plugin: ${name}\nActivation is read from ${file}.` }); }
    for (const name of Object.keys(object(data.hooks))) result.extensions.push({ id: randomUUID(), engine, scope, kind: 'hook', name, path: file, enabled: null, preview: `Hook event: ${name}\nCommands are kept private and are never executed by discovery. Inspect the source file in your editor.` });
  }
  mutate(request: Extract<HubRequest, { action: 'toggle-server' | 'remove-server' | 'toggle-extension' }>) {
    const source = this.handles.get(request.id); if (!source) throw new HubError('CONFIG_REFERENCE', 'Refresh configuration before editing.');
    if (request.action === 'toggle-extension') {
      if (source.kind === 'server') throw new HubError('CONFIG_REFERENCE', 'Invalid extension reference.');
      updateConfig(source.file, source.hash, (data) => {
        if (source.kind === 'skill') { data.skills ??= {}; data.skills.config ??= []; const match = data.skills.config.find((s: ObjectMap) => s.path === source.slot); if (match) match.enabled = request.enabled; else data.skills.config.push({ path: source.slot, enabled: request.enabled }); }
        else if (source.engine === 'claude') { data.enabledPlugins ??= {}; data.enabledPlugins[source.slot] = request.enabled; }
        else { data.plugins ??= {}; data.plugins[source.slot] ??= {}; data.plugins[source.slot].enabled = request.enabled; }
      }); return;
    }
    if (source.kind !== 'server') throw new HubError('CONFIG_REFERENCE', 'Invalid server reference.');
    // Verify the inspected server file even when Claude stores the toggle elsewhere.
    if (readConfig(source.file).hash !== source.hash) throw new HubError('CONFIG_CHANGED', 'Configuration changed. Refresh before editing.');
    if (request.action === 'toggle-server' && source.engine === 'claude') {
      if (!source.directory) throw new HubError('PROJECT_REQUIRED', 'Claude server enablement is scoped to a project. Select a project first.');
      const target = source.scope === 'project' ? path.join(source.directory, '.claude', 'settings.local.json') : this.file('claude', 'user', source.directory);
      updateConfig(target, target === source.file ? source.hash : null, (data) => { let config = data; let key = 'disabledMcpjsonServers'; if (source.scope === 'user') { data.projects ??= {}; data.projects[source.directory!] ??= {}; config = data.projects[source.directory!]; key = 'disabledMcpServers'; } const names = new Set<string>(config[key] ?? []); request.enabled ? names.delete(source.slot) : names.add(source.slot); config[key] = [...names]; });
    } else updateConfig(source.file, source.hash, (data) => { const key = source.engine === 'claude' ? 'mcpServers' : 'mcp_servers'; const servers = source.local && source.directory ? object(object(object(data.projects)[source.directory]).mcpServers) : object(data[key]); if (request.action === 'remove-server') delete servers[source.slot]; else servers[source.slot].enabled = request.enabled; });
    this.handles.delete(request.id);
  }
  add(request: Extract<HubRequest, { action: 'add-server' }>) {
    const directory = this.directory(request.directory); const file = this.file(request.engine, request.scope, directory);
    updateConfig(file, null, (data) => { const key = request.engine === 'claude' ? 'mcpServers' : 'mcp_servers'; data[key] ??= {}; if (Object.hasOwn(data[key], request.name)) throw new HubError('SERVER_EXISTS', 'A server with this name already exists. Remove it explicitly before replacing it.');
      data[key][request.name] = request.url ? { ...(request.engine === 'claude' ? { type: 'http' } : {}), url: request.url } : { command: request.command, args: request.args, ...(request.engine === 'claude' ? { env: Object.fromEntries(request.envNames.map((name) => [name, '${' + name + '}'])) } : { env_vars: request.envNames }) };
    });
  }
}
