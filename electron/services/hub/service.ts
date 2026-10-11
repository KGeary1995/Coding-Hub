import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PREFERENCES, type HubPreferences, type HubRequest, type HubResponse } from '../../../shared/hub';
import { ConfigService, readConfig, updateConfig } from './config';
import { MemoryService, projectSchema } from './memory';
import { DriveMirror } from './drive';
import { HubError } from '../cli/engine-adapter';
import type { TelemetryService } from './telemetry';
import { RulesService } from './rules';
const dir = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid directory.'); const id = z.uuid(); const name = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), 'Choose another server name.');
export const preferencesSchema = z.object({ folderId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), driveDirectory: z.string().max(4096), terminalFontSize: z.number().int().min(10).max(22), prices: z.array(z.object({ model: z.string().min(1).max(120), input: z.number().finite().min(0).max(10000), output: z.number().finite().min(0).max(10000), cacheRead: z.number().finite().min(0).max(10000), cacheWrite: z.number().finite().min(0).max(10000) }).strict()).max(100) }).strict();
export const hubRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rules-read'), directories: z.array(dir).max(100) }).strict(),
  z.object({ action: z.literal('rules-save'), content: z.string().max(60000), revision: z.string().regex(/^[a-f0-9]{64}$/), targets: z.array(z.object({ directory: dir, claudeHash: z.string().regex(/^[a-f0-9]{64}$/), codexHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100) }).strict(),
  z.object({ action: z.literal('inventory'), directory: dir.nullable() }).strict(),
  z.object({ action: z.literal('toggle-server'), id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove-server'), id }).strict(),
  z.object({ action: z.literal('toggle-extension'), id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('add-server'), directory: dir.nullable(), engine: z.enum(['claude', 'codex']), scope: z.enum(['user', 'project']), name, command: z.string().max(4096), args: z.array(z.string().max(4096)).max(100), envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100), url: z.url().refine((s) => ['http:', 'https:'].includes(new URL(s).protocol), 'Use an HTTP URL.').optional() }).strict().refine((r) => r.url || r.command.trim(), 'Provide a command or URL.'),
  z.object({ action: z.literal('drive-conflicts'), project: projectSchema }).strict(),
  z.object({ action: z.literal('drive-resolve'), project: projectSchema, id, localHash: z.string().regex(/^[a-f0-9]{64}$/), remoteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('memory-list'), project: projectSchema }).strict(),
  z.object({ action: z.literal('memory-write'), project: projectSchema, title: z.string().min(1).max(200), content: z.string().min(1).max(60000), author: z.enum(['claude', 'codex', 'human']), supersedes: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('memory-install'), project: projectSchema, directory: dir }).strict(),
  z.object({ action: z.literal('save-preferences'), preferences: preferencesSchema }).strict(),
  ...(['usage', 'preferences', 'drive-status', 'drive-connect', 'drive-disconnect'] as const).map((action) => z.object({ action: z.literal(action) }).strict()),
  z.object({ action: z.literal('drive-sync'), project: projectSchema }).strict(),
]);
export class HubService {
  readonly configs = new ConfigService();
  readonly rules: RulesService;
  readonly memory: MemoryService;
  readonly drive: DriveMirror;
  readonly preferencesPath: string;
  private projects = new Set<string>();
  private interval: ReturnType<typeof setInterval>;
  telemetry: TelemetryService | null = null;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.preferencesPath = path.join(root, 'preferences.json');
    this.rules = new RulesService(root);
    this.memory = new MemoryService(path.join(root, 'memory')); this.drive = new DriveMirror(this.memory, () => this.preferences());
    this.interval = setInterval(() => { for (const project of this.projects) try { this.drive.sync(project); } catch { /* Offline sync retries; originals remain local. */ } }, 30000);
  }
  preferences(): HubPreferences {
    const cfg = readConfig(this.preferencesPath); if (!cfg.text) return { ...DEFAULT_PREFERENCES, prices: [] };
    const result = preferencesSchema.safeParse(cfg.data); if (!result.success) throw new HubError('PREFERENCES_INVALID', 'Saved preferences are invalid. Existing file was preserved.'); return result.data;
  }
  execute(input: unknown): HubResponse {
    const parsed = hubRequestSchema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_HUB_REQUEST', parsed.error.issues.map((i) => i.message).join(' ')); const request = parsed.data as HubRequest;
    switch (request.action) {
      case 'rules-read': return this.rules.read(request.directories);
      case 'rules-save': return this.rules.save(request.content, request.revision, request.targets);
      case 'inventory': return this.configs.inventory(request.directory);
      case 'toggle-server': case 'remove-server': case 'toggle-extension': this.configs.mutate(request); return null;
      case 'add-server': this.configs.add(request); return null;
      case 'memory-list': this.projects.add(request.project); return this.memory.list(request.project);
      case 'memory-write': { this.projects.add(request.project); const note = this.memory.write(request.project, request.title, request.content, request.author, request.supersedes); try { this.drive.sync(request.project); } catch { /* Offline notes sync on next retry. */ } return note; }
      case 'memory-install': this.memory.install(request.directory, request.project, path.join(__dirname, 'memory-server.js'), process.execPath); return null;
      case 'preferences': return this.preferences();
      case 'save-preferences': updateConfig(this.preferencesPath, null, (data) => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, request.preferences); }); return null;
      case 'usage': return this.telemetry?.list() ?? [];
      case 'drive-status': return this.drive.status();
      case 'drive-conflicts': return this.drive.conflicts(request.project);
      case 'drive-resolve': this.drive.resolve(request.project, request.id, request.localHash, request.remoteHash); return null;
      case 'drive-sync': this.projects.add(request.project); return this.drive.sync(request.project);
      case 'drive-connect': return this.drive.status();
      case 'drive-disconnect': { const preferences = this.preferences(); preferences.driveDirectory = ''; this.execute({ action: 'save-preferences', preferences }); return this.drive.status(); }
    }
  }
  close() { clearInterval(this.interval); this.telemetry?.close(); }
}
