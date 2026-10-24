import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DeviceSyncStatus, HubPreferences, SyncedComputer, SyncedDocument, UsageRecord } from '../../../shared/hub';
import type { ProjectTemplate } from '../../../shared/productivity';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import { templateSchema } from '../workbench/workflows';
import { preferencesSchema } from './preferences';
import type { RulesService } from './rules';

/**
 * Carries settings, shared rules, project templates and usage between computers through the same Drive folder that
 * syncs memory notes. Settings and rules are merged three ways against what was last synced: a change on one side is
 * taken, and a change on both sides is held as a conflict for the person to settle. Templates never change after they
 * are saved, so they merge as a set (deletions included). Each computer writes only its own usage file.
 */
export const SYNC_FOLDER = 'AI-Coding-Hub-Sync';
const LINEAGE = 50;
const PORTABLE = ['prices', 'terminalFontSize', 'terminalWebGL', 'automaticMemory'] as const;
const settingsSchema = preferencesSchema.pick({ prices: true, terminalFontSize: true, terminalWebGL: true, automaticMemory: true });
const rulesSchema = z.object({ content: z.string().max(60000) }).strict();
const machineSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(100) }).strict();
const usageSchema = z.object({
  conversationId: z.string().max(200).optional(), source: z.enum(['claude-session-jsonl', 'codex-rollout-jsonl']).optional(), confidence: z.literal('reported').optional(),
  costBasis: z.enum(['configured-model-rates', 'unpriced']).optional(), eventCount: z.number().int().min(0).optional(), runId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100),
  engine: z.enum(['claude', 'codex']), model: z.string().max(200), cwd: z.string().max(4096), timestamp: z.iso.datetime(), input: z.number().min(0), output: z.number().min(0), cached: z.number().min(0),
  cacheWrite: z.number().min(0), reasoning: z.number().min(0).nullable(), context: z.object({ used: z.number().min(0), limit: z.number().min(0) }).strict().nullable(), cost: z.number().min(0).nullable(),
}).strict();
const hashes = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(LINEAGE);
const documentSchema = <T extends z.ZodType>(value: T) => z.object({ version: z.literal(1), machine: machineSchema, updatedAt: z.iso.datetime(), value }).strict();
/**
 * Settings and rules carry their lineage: the hashes of the versions they were built on, oldest first, ending with their
 * own. A version from another computer is only taken without asking when it descends from what this computer last
 * synced; two computers that each published while Drive was offline therefore show as a conflict, not a silent overwrite.
 */
const versionedSchema = <T extends z.ZodType>(value: T) => documentSchema(value).extend({ history: hashes.default([]) });
const settingsDocument = versionedSchema(settingsSchema); const rulesDocument = versionedSchema(rulesSchema); const usageDocument = documentSchema(z.array(usageSchema).max(2000));
type Machine = z.infer<typeof machineSchema>;
type SyncedValue = { settings: z.infer<typeof settingsSchema>; rules: z.infer<typeof rulesSchema> };
type Held = z.infer<typeof settingsDocument> | z.infer<typeof rulesDocument>;
const stateSchema = z.object({
  base: z.object({ settings: z.string().nullable(), rules: z.string().nullable() }).strict(),
  lineage: z.object({ settings: hashes, rules: hashes }).strict().default({ settings: [], rules: [] }),
  templates: z.array(z.uuid()).max(500), usage: z.string().nullable(), lastSync: z.iso.datetime().nullable(),
  pending: z.object({ settings: settingsDocument.optional(), rules: rulesDocument.optional() }).strict(),
  rulesFrom: z.object({ name: z.string().max(100), at: z.iso.datetime() }).strict().nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;
const EMPTY: State = { base: { settings: null, rules: null }, lineage: { settings: [], rules: [] }, templates: [], usage: null, lastSync: null, pending: {}, rulesFrom: null };
const extend = (lineage: string[], hash: string) => [...lineage.filter((item) => item !== hash), hash].slice(-LINEAGE);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  let stat: fs.Stats; try { stat = fs.lstatSync(file); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new HubError('SYNC_FILE', `${path.basename(file)} in the sync folder is not a regular file under 4 MiB.`);
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new HubError('SYNC_FILE', `${path.basename(file)} in the sync folder could not be read. It was left as it is.`);
  return parsed.data;
}
function writeJson(file: string, value: unknown) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new HubError('SYNC_FILE', 'Sync files must not be links.'); } catch (error) { if (error instanceof HubError) throw error; }
  const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Renamed. */ } }
}

export class DeviceSync {
  readonly machine: Machine;
  private syncing = false; private error: string | null = null;
  private computers = new Map<string, SyncedComputer>();
  private remoteUsage = new Map<string, { mtime: number; records: UsageRecord[] }>();
  constructor(private root: string, private preferences: () => HubPreferences, private savePreferences: (preferences: HubPreferences) => void, private rules: RulesService, private localUsage: () => UsageRecord[]) {
    const existing = load(root, 'machine.json', machineSchema.nullable(), null);
    this.machine = existing ?? { id: randomUUID(), name: (os.hostname() || 'This computer').slice(0, 100) };
    if (!existing) save(root, 'machine.json', this.machine);
  }
  private state(): State { return load(this.root, 'device-sync.json', stateSchema.nullable(), null) ?? structuredClone(EMPTY); }
  private folder() {
    const preferences = this.preferences(); if (!preferences.syncDevices || !path.isAbsolute(preferences.driveDirectory)) return null;
    let drive: string; try { drive = fs.realpathSync(preferences.driveDirectory); if (!fs.statSync(drive).isDirectory()) return null; } catch { return null; }
    const folder = path.join(drive, SYNC_FOLDER);
    for (const sub of ['', 'templates', 'usage']) { const target = path.join(folder, sub); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); if (fs.lstatSync(target).isSymbolicLink()) throw new HubError('SYNC_PATH', 'The sync folder must not be a link.'); }
    return folder;
  }
  private value<D extends SyncedDocument>(document: D): SyncedValue[D] {
    if (document === 'rules') return { content: this.rules.content() } as SyncedValue[D];
    const preferences = this.preferences(); const value: Record<string, unknown> = {};
    for (const key of PORTABLE) if (preferences[key] !== undefined) value[key] = preferences[key];
    return settingsSchema.parse(value) as SyncedValue[D];
  }
  private apply(document: SyncedDocument, held: Held, state: State) {
    if (document === 'rules') { this.rules.adopt((held.value as SyncedValue['rules']).content); state.rulesFrom = { name: held.machine.name, at: held.updatedAt }; return; }
    // Optional settings the other computer left unset go back to their defaults here too.
    this.savePreferences({ ...this.preferences(), terminalWebGL: undefined, automaticMemory: undefined, ...(held.value as SyncedValue['settings']) });
  }
  private publish(folder: string, document: SyncedDocument, value: unknown, history: string[]) { writeJson(path.join(folder, document + '.json'), { version: 1, machine: this.machine, updatedAt: new Date().toISOString(), value, history }); }
  /** A first sync on a computer that never changed the item takes the other computer's version instead of a conflict. */
  private untouched(document: SyncedDocument, value: unknown) {
    if (document === 'rules') return !(value as SyncedValue['rules']).content.trim();
    const settings = value as SyncedValue['settings'];
    return !settings.prices.length && settings.terminalFontSize === 13 && !settings.terminalWebGL && settings.automaticMemory !== false;
  }
  private reconcile(folder: string, document: SyncedDocument, state: State) {
    const local = this.value(document); const localHash = digest(local);
    const remote = readJson<Held>(path.join(folder, document + '.json'), document === 'rules' ? rulesDocument : settingsDocument);
    if (remote) this.seen(remote.machine, remote.updatedAt);
    const settled = (hash: string, lineage: string[]) => { state.base[document] = hash; state.lineage[document] = lineage; delete state.pending[document]; };
    const publish = (lineage: string[]) => { this.publish(folder, document, local, lineage); if (document === 'rules') state.rulesFrom = null; settled(localHash, lineage); };
    if (!remote) return publish(extend(state.lineage[document], localHash));
    const remoteHash = digest(remote.value); const base = state.base[document];
    if (remoteHash === localHash) return settled(localHash, remote.history);
    // Only this computer changed it since the last sync.
    if (base === remoteHash) return publish(extend(remote.history, localHash));
    // Only the other computer changed it, building on what this computer last synced (or this computer never changed it).
    if ((localHash === base && remote.history.includes(base)) || (base === null && this.untouched(document, local))) { this.apply(document, remote, state); return settled(remoteHash, remote.history); }
    // Both changed, or the other version does not descend from this one: hold it for the person to choose.
    (state.pending as Record<SyncedDocument, Held>)[document] = remote;
  }
  private templates(folder: string, state: State) {
    const local = load(this.root, 'project-templates.json', z.array(templateSchema).max(50), []) as ProjectTemplate[];
    const directory = path.join(folder, 'templates'); const remote = new Map<string, ProjectTemplate>(); const present = new Set<string>(); let unreadable = 0;
    for (const name of fs.readdirSync(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const id = name.slice(0, 36); present.add(id);
      // A shared file that cannot be read (half-synced, damaged) still counts as present: it is never taken as a deletion.
      try { const item = readJson(path.join(directory, name), templateSchema) as ProjectTemplate | null; if (item && item.id === id) remote.set(id, item); else unreadable++; } catch { unreadable++; }
    }
    const known = new Set(state.templates); const localIds = new Set(local.map((item) => item.id));
    // Removed here since the last sync: remove it for every computer.
    for (const id of known) if (!localIds.has(id) && present.has(id)) { fs.unlinkSync(path.join(directory, id + '.json')); present.delete(id); remote.delete(id); }
    // Removed on another computer, or new there.
    let next = local.filter((item) => !known.has(item.id) || present.has(item.id));
    for (const item of remote.values()) if (!next.some((other) => other.id === item.id) && next.length < 50) next = [...next, item];
    // New here, or a shared copy that could not be read: this computer's copy is written (templates never change once saved).
    for (const item of next) if (!remote.has(item.id)) writeJson(path.join(directory, item.id + '.json'), item);
    if (next.length !== local.length || next.some((item, index) => item.id !== local[index].id)) save(this.root, 'project-templates.json', next);
    state.templates = next.map((item) => item.id);
    if (unreadable) throw new HubError('SYNC_FILE', `${unreadable} shared template file${unreadable === 1 ? '' : 's'} could not be read; copies on this computer were kept.`);
  }
  private usage(folder: string, state: State) {
    const records = this.localUsage().filter((record) => !record.machine).slice(0, 2000).flatMap((record) => { const parsed = usageSchema.safeParse(record); return parsed.success ? [parsed.data] : []; });
    // The cache names the folder too, so a new Drive folder (or a deleted usage file) gets this computer's history again.
    const own = path.join(folder, 'usage', this.machine.id + '.json'); const hash = digest([folder, records]);
    if (hash !== state.usage || !fs.existsSync(own)) { writeJson(own, { version: 1, machine: this.machine, updatedAt: new Date().toISOString(), value: records }); state.usage = hash; }
    const directory = path.join(folder, 'usage'); const present = new Set<string>();
    for (const name of fs.readdirSync(directory)) {
      const match = /^([0-9a-f-]{36})\.json$/.exec(name); if (!match || match[1] === this.machine.id) continue;
      present.add(match[1]); const file = path.join(directory, name);
      try {
        const mtime = fs.statSync(file).mtimeMs; if (this.remoteUsage.get(match[1])?.mtime === mtime) continue;
        const document = readJson(file, usageDocument); if (!document || document.machine.id !== match[1]) continue;
        this.seen(document.machine, document.updatedAt);
        this.remoteUsage.set(match[1], { mtime, records: document.value.map((record) => ({ ...record, machine: document.machine.name })) });
      } catch { /* Another computer's unreadable usage file is skipped until it is rewritten. */ }
    }
    for (const id of this.remoteUsage.keys()) if (!present.has(id)) this.remoteUsage.delete(id);
  }
  private seen(machine: Machine, updatedAt: string) { if (machine.id !== this.machine.id) this.computers.set(machine.id, { id: machine.id, name: machine.name, updatedAt }); }
  /** Usage recorded on the other computers, labelled with each computer's name. */
  otherUsage(): UsageRecord[] { return this.preferences().syncDevices ? [...this.remoteUsage.values()].flatMap((item) => item.records) : []; }
  sync() {
    if (this.syncing) return this.status();
    let folder: string | null; try { folder = this.folder(); } catch (error) { this.error = (error as Error).message; return this.status(); }
    if (!folder) return this.status();
    this.syncing = true; this.error = null;
    try {
      const state = this.state();
      // Each part runs even when another fails, so one unreadable file does not stop the rest from syncing.
      for (const step of [() => this.reconcile(folder, 'settings', state), () => this.reconcile(folder, 'rules', state), () => this.templates(folder, state), () => this.usage(folder, state)]) {
        try { step(); } catch (error) { this.error ??= error instanceof HubError ? error.message : 'Part of the sync failed. It will retry.'; }
      }
      state.lastSync = new Date().toISOString(); save(this.root, 'device-sync.json', state);
    } catch (error) { this.error = error instanceof HubError ? error.message : 'Sync failed. It will retry.'; }
    finally { this.syncing = false; }
    return this.status();
  }
  /** Settles a conflict by keeping this computer's version or taking the other computer's. */
  resolve(document: SyncedDocument, keep: 'local' | 'remote') {
    const folder = this.folder(); if (!folder) throw new HubError('SYNC_OFFLINE', 'The sync folder is unavailable. Check the Drive folder in Settings.');
    const state = this.state(); const held = state.pending[document]; if (!held) throw new HubError('SYNC_RESOLVED', 'This conflict was already settled.');
    const current = readJson<Held>(path.join(folder, document + '.json'), document === 'rules' ? rulesDocument : settingsDocument);
    if (!current || digest(current) !== digest(held)) { delete state.pending[document]; save(this.root, 'device-sync.json', state); throw new HubError('SYNC_CHANGED', 'The other computer changed it again. Sync to review the newest version.'); }
    if (keep === 'remote') { this.apply(document, held, state); state.base[document] = digest(held.value); state.lineage[document] = held.history; }
    else {
      // This computer's version is published as a successor of the other one, so the other computer takes it without asking.
      const local = this.value(document); const lineage = extend(held.history, digest(local)); this.publish(folder, document, local, lineage);
      state.base[document] = digest(local); state.lineage[document] = lineage; if (document === 'rules') state.rulesFrom = null;
    }
    delete state.pending[document]; save(this.root, 'device-sync.json', state);
    return this.status();
  }
  status(): DeviceSyncStatus {
    const preferences = this.preferences(); let state: State; try { state = this.state(); } catch (error) { state = structuredClone(EMPTY); this.error ??= (error as Error).message; }
    let connected = false; try { connected = Boolean(preferences.syncDevices) && path.isAbsolute(preferences.driveDirectory) && fs.statSync(preferences.driveDirectory).isDirectory(); } catch { /* Offline. */ }
    const conflicts = (['settings', 'rules'] as const).flatMap((document) => { const held = state.pending[document]; return held ? [{ document, from: held.machine.name, at: held.updatedAt }] : []; });
    return { enabled: Boolean(preferences.syncDevices), connected, machine: this.machine, lastSync: state.lastSync, error: this.error, computers: [...this.computers.values()].sort((a, b) => a.name.localeCompare(b.name)), conflicts, rulesFrom: state.rulesFrom };
  }
}
