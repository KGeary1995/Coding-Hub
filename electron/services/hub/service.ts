import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PREFERENCES, type HubPreferences, type HubRequest, type HubResponse, type MemoryNote } from '../../../shared/hub';
import { ConfigService, readConfig, updateConfig } from './config';
import { MemoryService, projectSchema } from './memory';
import { DriveMirror } from './drive';
import { commitStatus } from './commit-status';
import { memoryEntries, projectConfigRoot, projectMemoryKey, useAutomaticKey } from './auto-memory';
import { HubError } from '../cli/engine-adapter';
import { repriced, type TelemetryService } from './telemetry';
import { RulesService } from './rules';
import { preferencesSchema } from './preferences';
import { DeviceSync } from './device-sync';
import { timed } from '../storage/host-health';
const dir = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid directory.'); const id = z.uuid(); const name = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), 'Choose another server name.');
export const hubRequestSchema = z.discriminatedUnion('action', [
  // The registry holds up to 200 folders (100 projects plus prepared coaching folders) and the panel adds workspace folders.
  z.object({ action: z.literal('rules-read'), directories: z.array(dir).max(250) }).strict(),
  z.object({ action: z.literal('rules-forget'), directory: dir }).strict(),
  z.object({ action: z.literal('rules-save'), content: z.string().max(60000), revision: z.string().regex(/^[a-f0-9]{64}$/), targets: z.array(z.object({ directory: dir, claudeHash: z.string().regex(/^[a-f0-9]{64}$/), codexHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(250) }).strict(),
  z.object({ action: z.literal('inventory'), directory: dir.nullable() }).strict(),
  z.object({ action: z.literal('toggle-server'), id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove-server'), id }).strict(),
  z.object({ action: z.literal('toggle-extension'), id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('add-server'), directory: dir.nullable(), engine: z.enum(['claude', 'codex']), scope: z.enum(['user', 'project']), name, command: z.string().max(4096), args: z.array(z.string().max(4096)).max(100), envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100), url: z.url().refine((s) => ['http:', 'https:'].includes(new URL(s).protocol), 'Use an HTTP URL.').optional() }).strict().refine((r) => r.url || r.command.trim(), 'Provide a command or URL.'),
  z.object({ action: z.literal('drive-conflicts'), project: projectSchema }).strict(),
  z.object({ action: z.literal('drive-resolve'), project: projectSchema, id, localHash: z.string().regex(/^[a-f0-9]{64}$/), remoteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('memory-list'), project: projectSchema }).strict(),
  z.object({ action: z.literal('memory-key'), directory: dir }).strict(),
  z.object({ action: z.literal('memory-projects') }).strict(),
  z.object({ action: z.literal('memory-commits'), directory: dir, shas: z.array(z.string().regex(/^[0-9a-fA-F]{7,64}$/)).max(10) }).strict(),
  z.object({ action: z.literal('memory-entries'), directory: dir }).strict(),
  z.object({ action: z.literal('memory-use-auto-key'), directory: dir }).strict(),
  z.object({ action: z.literal('memory-write'), project: projectSchema, title: z.string().min(1).max(200), content: z.string().min(1).max(60000), author: z.enum(['claude', 'codex', 'human']), supersedes: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('memory-write-many'), notes: z.array(z.object({ project: projectSchema, title: z.string().min(1).max(200), content: z.string().min(1).max(60000), author: z.enum(['claude', 'codex', 'human']), supersedes: z.uuid().optional() }).strict()).min(1).max(100) }).strict(),
  z.object({ action: z.literal('memory-install'), project: projectSchema.optional(), directory: dir }).strict(),
  z.object({ action: z.literal('save-preferences'), preferences: preferencesSchema }).strict(),
  z.object({ action: z.literal('device-sync-resolve'), document: z.enum(['settings', 'rules']), keep: z.enum(['local', 'remote']) }).strict(),
  ...(['usage', 'preferences', 'drive-status', 'drive-connect', 'drive-disconnect', 'device-sync-status', 'device-sync-now'] as const).map((action) => z.object({ action: z.literal(action) }).strict()),
  z.object({ action: z.literal('drive-sync'), project: projectSchema }).strict(),
]);
export class HubService {
  readonly configs = new ConfigService();
  readonly rules: RulesService;
  readonly memory: MemoryService;
  readonly drive: DriveMirror;
  readonly devices: DeviceSync;
  readonly preferencesPath: string;
  private projects = new Set<string>();
  /** Keeps a project's notes in the 30-second Drive sync and starts syncing it now, without waiting for it. */
  trackProject(project: string) { void this.syncProject(project); }
  /** trackProject, finished: for a launch that should start with the notes other computers wrote. Never throws (offline folders retry later). */
  syncProject(project: string): Promise<void> {
    this.projects.add(project); const work = this.drive.syncLater(project).then(() => {}, () => { /* Retried by the interval. */ });
    this.pending.add(work); void work.finally(() => this.pending.delete(work)); return work;
  }
  /** Syncs started by trackProject or syncProject, so quitting can let a session's last summary reach Drive. */
  private pending = new Set<Promise<void>>();
  /** Waits up to `limit` milliseconds for those syncs: call after AutoMemory.drain, before close(). */
  async drain(limit: number) { await Promise.race([Promise.allSettled([...this.pending]), new Promise((resolve) => setTimeout(resolve, limit).unref?.())]); }
  private interval: ReturnType<typeof setInterval>;
  telemetry: TelemetryService | null = null;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.preferencesPath = path.join(root, 'preferences.json');
    this.rules = new RulesService(root);
    this.memory = new MemoryService(path.join(root, 'memory')); this.drive = new DriveMirror(this.memory, () => this.preferences());
    this.devices = new DeviceSync(root, () => this.preferences(), (preferences) => this.execute({ action: 'save-preferences', preferences }), this.rules, () => this.telemetry?.list() ?? []);
    this.interval = setInterval(() => void this.tick(), 30000);
  }
  /** One at a time: a slow Drive folder can take longer to list than the 30 seconds between ticks. */
  private ticking = false;
  private async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      for (const project of [...this.projects]) try { await this.drive.syncLater(project); } catch { /* Offline sync retries; originals remain local. */ }
      // Labelled for the stall record: device sync reads and writes the Drive folder synchronously.
      try { timed('hub-tick', () => this.devices.sync()); } catch { /* Reported in Settings; the next tick retries. */ }
    } finally { this.ticking = false; }
  }
  preferences(): HubPreferences {
    // The default Drive folder is a Windows drive letter; elsewhere the person chooses the folder (it differs per account).
    const cfg = readConfig(this.preferencesPath); if (!cfg.text) return { ...DEFAULT_PREFERENCES, driveDirectory: process.platform === 'win32' ? DEFAULT_PREFERENCES.driveDirectory : '', prices: [] };
    const result = preferencesSchema.safeParse(cfg.data); if (!result.success) throw new HubError('PREFERENCES_INVALID', 'Saved preferences are invalid. Existing file was preserved.'); return result.data;
  }
  /**
   * Requests that wait on other programs (Git) or read many notes (Google Drive answers each file in about half a
   * millisecond, and a project holds hundreds): answered without holding the process. Everything else is answered at
   * once by execute.
   */
  async executeAsync(input: unknown): Promise<HubResponse> {
    const parsed = hubRequestSchema.safeParse(input); if (!parsed.success) return this.execute(input); const request = parsed.data as HubRequest;
    switch (request.action) {
      case 'memory-commits': return commitStatus(request.directory, request.shas);
      // Only a project with notes here or on Drive joins the 30-second sync, not each partial key typed in the Memory panel.
      // While Drive cannot be read (not mounted yet), it joins, so its notes arrive when Drive does.
      case 'memory-list': { const notes = await this.memory.listLater(request.project); if (notes.length || await this.drive.hasProject(request.project) !== false) this.projects.add(request.project); return notes; }
      case 'memory-projects': return this.memory.projectsLater();
      case 'drive-conflicts': return this.drive.conflicts(request.project);
      case 'drive-resolve': await this.drive.resolve(request.project, request.id, request.localHash, request.remoteHash); return null;
      case 'drive-sync': this.projects.add(request.project); return this.drive.syncLater(request.project);
      default: return this.execute(request);
    }
  }
  execute(input: unknown): HubResponse {
    const parsed = hubRequestSchema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_HUB_REQUEST', parsed.error.issues.map((i) => i.message).join(' ')); const request = parsed.data as HubRequest;
    switch (request.action) {
      case 'rules-read': return this.rules.read(request.directories);
      case 'rules-save': return this.rules.save(request.content, request.revision, request.targets);
      case 'rules-forget': this.rules.forget(request.directory); return null;
      case 'inventory': return this.configs.inventory(request.directory);
      case 'toggle-server': case 'remove-server': case 'toggle-extension': this.configs.mutate(request); return null;
      case 'add-server': this.configs.add(request); return null;
      case 'memory-key': return projectMemoryKey(request.directory);
      // Git and the Drive folder are read asynchronously: the IPC handler awaits them (see executeAsync).
      case 'memory-commits': case 'memory-list': case 'memory-projects': case 'drive-conflicts': case 'drive-resolve': case 'drive-sync': throw new HubError('HUB_ASYNC', `${request.action} is answered by executeAsync.`);
      // The note is saved here at once; Drive gets it in the background (offline notes sync on the next retry).
      case 'memory-write': { const note = this.memory.write(request.project, request.title, request.content, request.author, request.supersedes); this.trackProject(request.project); return note; }
      // One Drive sync per project for the lot. Notes saved before a failure stay saved, and the message says how many.
      case 'memory-write-many': {
        const notes: MemoryNote[] = [];
        try { for (const each of request.notes) notes.push(this.memory.write(each.project, each.title, each.content, each.author, each.supersedes)); }
        catch (error) { if (!notes.length) throw error; throw new HubError('MEMORY_PARTIAL', `${notes.length} of ${request.notes.length} notes were saved; the rest were not: ${error instanceof Error ? error.message : 'the note could not be saved.'}`); }
        finally { for (const project of new Set(notes.map((note) => note.project))) this.trackProject(project); }
        return notes;
      }
      // Without a key, use the automatic one so sessions started in Trace and from other terminals share notes.
      case 'memory-entries': return memoryEntries(request.directory, this.memory.root);
      case 'memory-use-auto-key': return useAutomaticKey(request.directory, this.memory.root, path.join(__dirname, 'memory-server.js'), process.execPath);
      case 'memory-install': {
        // Sessions read a project's MCP files from the repository's top folder; an entry in a subfolder is never used.
        const root = projectConfigRoot(request.directory);
        if (path.resolve(request.directory) !== root) throw new HubError('MEMORY_ROOT', `Install memory in the repository's top folder, ${root}. CLIs read project MCP settings from there.`);
        this.memory.install(request.directory, request.project ?? projectMemoryKey(request.directory), path.join(__dirname, 'memory-server.js'), process.execPath); return null;
      }
      case 'preferences': return this.preferences();
      case 'save-preferences': updateConfig(this.preferencesPath, null, (data) => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, request.preferences); }); return null;
      case 'usage': {
        const local = this.telemetry?.list() ?? []; const runs = new Set(local.map((record) => record.runId)); const rates = this.preferences().prices;
        // Other computers' runs are priced with this computer's rates, like its own (by the run's last model).
        const others = this.devices.otherUsage().filter((record) => !runs.has(record.runId)).map((record) => repriced(record, rates));
        return [...local, ...others];
      }
      case 'device-sync-status': return this.devices.status();
      // Sync now publishes this computer's usage at once; the 30-second tick does so at most every few minutes.
      case 'device-sync-now': return this.devices.sync(true);
      case 'device-sync-resolve': return this.devices.resolve(request.document, request.keep);
      case 'drive-status': return this.drive.status();
      case 'drive-connect': return this.drive.status();
      case 'drive-disconnect': { const preferences = this.preferences(); preferences.driveDirectory = ''; this.execute({ action: 'save-preferences', preferences }); return this.drive.status(); }
    }
  }
  /** Publishes the usage recorded since the last publish first, so other computers do not wait for the next start for it. */
  close() { clearInterval(this.interval); try { this.devices.sync(true); } catch { /* The next start publishes it. */ } this.telemetry?.close(); }
}
