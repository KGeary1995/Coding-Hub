import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PREFERENCES, type HubPreferences, type UsageRecord } from '../../../shared/hub';
import type { ProjectTemplate } from '../../../shared/productivity';
import { DeviceSync, SYNC_FOLDER } from './device-sync';
import { RulesService } from './rules';
import { load, save } from '../workbench/local-store';
import { templateSchema } from '../workbench/workflows';
import { z } from 'zod';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-sync-')); roots.push(root); return root; };

/** One simulated computer: its own storage, sharing the Drive folder with the others. */
function computer(drive: string, name: string, usage: UsageRecord[] = []) {
  const root = temporary(); fs.writeFileSync(path.join(root, 'machine.json'), JSON.stringify({ id: randomUUID(), name }));
  let preferences: HubPreferences = { ...DEFAULT_PREFERENCES, prices: [], driveDirectory: drive, syncDevices: true };
  const rules = new RulesService(root);
  const sync = new DeviceSync(root, () => preferences, (next) => { preferences = next; }, rules, () => usage);
  return { root, rules, sync, get preferences() { return preferences; }, set preferences(next: HubPreferences) { preferences = next; } };
}
const setRules = (rules: RulesService, content: string) => rules.save(content, rules.read([]).revision, []);
const template = (name: string): ProjectTemplate => {
  const ids = [randomUUID(), randomUUID()];
  return { id: randomUUID(), name, description: '', rules: '', checks: [], createdAt: new Date().toISOString(), workspace: { version: 1, rootDirectory: null, layoutMode: 'columns', focusedSessionId: null,
    sessions: ids.map((id) => ({ id, title: 'Claude', createdAt: new Date().toISOString(), config: { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, binding: { mode: 'workspace' } })),
    tiles: ids.map((sessionId, index) => ({ sessionId, x: index * 6, y: 0, w: 6, h: 12, minW: 3, minH: 10 })) } as ProjectTemplate['workspace'] };
};
const templates = (root: string) => load(root, 'project-templates.json', z.array(templateSchema), []) as ProjectTemplate[];
const record = (runId: string): UsageRecord => ({ runId, sessionId: 's', engine: 'claude', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null });

describe('device sync', () => {
  it('does nothing until it is switched on and the Drive folder exists', () => {
    const drive = temporary(); const a = computer(drive, 'desk');
    a.preferences = { ...a.preferences, syncDevices: false }; a.sync.sync();
    expect(fs.existsSync(path.join(drive, SYNC_FOLDER))).toBe(false);
    a.preferences = { ...a.preferences, syncDevices: true, driveDirectory: path.join(drive, 'missing') };
    expect(a.sync.sync()).toMatchObject({ enabled: true, connected: false, lastSync: null });
  });

  it('carries settings and rules to a new computer, and later changes either way', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const b = computer(drive, 'laptop');
    a.preferences = { ...a.preferences, terminalFontSize: 16, prices: [{ model: 'm', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }; setRules(a.rules, 'Run the tests.');
    a.sync.sync(); const status = b.sync.sync();
    // A computer that never changed its own settings takes the other's instead of reporting a conflict.
    expect(b.preferences).toMatchObject({ terminalFontSize: 16, driveDirectory: drive, syncDevices: true }); expect(b.preferences.prices).toHaveLength(1);
    expect(b.rules.content()).toBe('Run the tests.'); expect(status.conflicts).toEqual([]); expect(status.rulesFrom?.name).toBe('desk');
    // Then a change on the laptop reaches the desk.
    b.preferences = { ...b.preferences, terminalFontSize: 12 }; b.sync.sync(); a.sync.sync();
    expect(a.preferences.terminalFontSize).toBe(12);
    expect(a.sync.status().computers.map((item) => item.name)).toEqual(['laptop']);
  });

  it('holds a change made on both computers as a conflict, and settles it either way', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const b = computer(drive, 'laptop');
    setRules(a.rules, 'Shared start.'); a.sync.sync(); b.sync.sync();
    setRules(a.rules, 'Desk edit.'); setRules(b.rules, 'Laptop edit.');
    a.sync.sync(); const held = b.sync.sync();
    expect(held.conflicts).toEqual([expect.objectContaining({ document: 'rules', from: 'desk' })]);
    expect(b.rules.content()).toBe('Laptop edit.');
    b.sync.resolve('rules', 'local'); a.sync.sync();
    expect(a.rules.content()).toBe('Laptop edit.'); expect(b.sync.status().conflicts).toEqual([]);
    setRules(a.rules, 'Desk again.'); setRules(b.rules, 'Laptop again.'); a.sync.sync(); b.sync.sync();
    b.sync.resolve('rules', 'remote'); expect(b.rules.content()).toBe('Desk again.');
  });

  it('treats edits made on both computers while Drive was offline as a conflict, but takes a run of edits made on one', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const b = computer(drive, 'laptop');
    setRules(a.rules, 'Start.'); a.sync.sync(); b.sync.sync();
    // The laptop edits twice in a row; the desk, which changed nothing, takes the newest without asking.
    setRules(b.rules, 'Laptop 1.'); b.sync.sync(); setRules(b.rules, 'Laptop 2.'); b.sync.sync();
    expect(a.sync.sync().conflicts).toEqual([]); expect(a.rules.content()).toBe('Laptop 2.');
    // Now both publish to their own copy of the Drive folder before Drive catches up.
    const offline = temporary(); fs.cpSync(path.join(drive, SYNC_FOLDER), path.join(offline, SYNC_FOLDER), { recursive: true });
    b.preferences = { ...b.preferences, driveDirectory: offline };
    setRules(a.rules, 'Desk offline.'); a.sync.sync(); setRules(b.rules, 'Laptop offline.'); b.sync.sync();
    // Drive keeps the laptop's file.
    fs.copyFileSync(path.join(offline, SYNC_FOLDER, 'rules.json'), path.join(drive, SYNC_FOLDER, 'rules.json'));
    expect(a.sync.sync().conflicts).toEqual([expect.objectContaining({ document: 'rules', from: 'laptop' })]);
    expect(a.rules.content()).toBe('Desk offline.');
    // Keeping the desk's version publishes it as a successor, which the laptop then takes without a conflict.
    a.sync.resolve('rules', 'local'); b.preferences = { ...b.preferences, driveDirectory: drive };
    expect(b.sync.sync().conflicts).toEqual([]); expect(b.rules.content()).toBe('Desk offline.');
  });

  it('keeps a template whose shared file cannot be read, and repairs the shared copy', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const item = template('Web app');
    save(a.root, 'project-templates.json', [item]); a.sync.sync();
    const file = path.join(drive, SYNC_FOLDER, 'templates', item.id + '.json'); fs.writeFileSync(file, '{"half": ');
    expect(a.sync.sync().error).toMatch(/could not be read/);
    expect(templates(a.root).map((entry) => entry.id)).toEqual([item.id]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).id).toBe(item.id);
  });

  it('publishes usage again to a new Drive folder or after its file was deleted, and survives an unreadable state file', () => {
    const drive = temporary(); const a = computer(drive, 'desk', [record('run-a')]); a.sync.sync();
    const own = (folder: string) => path.join(folder, SYNC_FOLDER, 'usage', JSON.parse(fs.readFileSync(path.join(a.root, 'machine.json'), 'utf8')).id + '.json');
    fs.unlinkSync(own(drive)); a.sync.sync(); expect(fs.existsSync(own(drive))).toBe(true);
    const moved = temporary(); a.preferences = { ...a.preferences, driveDirectory: moved }; a.sync.sync(); expect(fs.existsSync(own(moved))).toBe(true);
    fs.writeFileSync(path.join(a.root, 'device-sync.json'), 'not json');
    expect(a.sync.sync().error).toBeTruthy();
    fs.rmSync(path.join(a.root, 'device-sync.json')); expect(a.sync.sync()).toMatchObject({ error: null });
  });

  it('keeps templates when sync moves to a different Drive folder, and publishes them there', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const item = template('Web app');
    save(a.root, 'project-templates.json', [item]); a.sync.sync();
    const moved = temporary(); a.preferences = { ...a.preferences, driveDirectory: moved }; a.sync.sync();
    expect(templates(a.root).map((entry) => entry.id)).toEqual([item.id]);
    expect(fs.existsSync(path.join(moved, SYNC_FOLDER, 'templates', item.id + '.json'))).toBe(true);
  });

  it('reports unreadable preferences instead of throwing, and lists a run seen twice only once', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const b = computer(drive, 'laptop', [record('same-run')]); const c = computer(drive, 'restored', [record('same-run')]);
    b.sync.sync(); c.sync.sync(); a.sync.sync();
    expect(a.sync.otherUsage().map((item) => item.runId)).toEqual(['same-run']);
    const broken = new DeviceSync(a.root, () => { throw new Error('preferences.json could not be read.'); }, () => {}, a.rules, () => []);
    expect(() => broken.sync()).not.toThrow(); expect(broken.sync().error).toMatch(/could not be read/); expect(broken.otherUsage()).toEqual([]);
  });

  it('merges templates as a set and passes deletions on', () => {
    const drive = temporary(); const a = computer(drive, 'desk'); const b = computer(drive, 'laptop');
    const first = template('Web app'); const second = template('CLI');
    save(a.root, 'project-templates.json', [first]); save(b.root, 'project-templates.json', [second]);
    a.sync.sync(); b.sync.sync(); a.sync.sync();
    expect(templates(a.root).map((item) => item.name).sort()).toEqual(['CLI', 'Web app']);
    expect(templates(b.root).map((item) => item.name).sort()).toEqual(['CLI', 'Web app']);
    save(b.root, 'project-templates.json', templates(b.root).filter((item) => item.id !== first.id)); b.sync.sync(); a.sync.sync();
    expect(templates(a.root).map((item) => item.name)).toEqual(['CLI']);
    expect(fs.existsSync(path.join(drive, SYNC_FOLDER, 'templates', first.id + '.json'))).toBe(false);
  });

  it('shares usage labelled with the computer it came from, and never rewrites another computer’s file', () => {
    const drive = temporary(); const a = computer(drive, 'desk', [record('run-a')]); const b = computer(drive, 'laptop', [record('run-b')]);
    a.sync.sync(); b.sync.sync(); a.sync.sync();
    expect(a.sync.otherUsage()).toEqual([expect.objectContaining({ runId: 'run-b', machine: 'laptop' })]);
    expect(b.sync.otherUsage()).toEqual([expect.objectContaining({ runId: 'run-a', machine: 'desk' })]);
    expect(fs.readdirSync(path.join(drive, SYNC_FOLDER, 'usage'))).toHaveLength(2);
    a.preferences = { ...a.preferences, syncDevices: false }; expect(a.sync.otherUsage()).toEqual([]);
  });

  it('keeps syncing the other parts when one shared file is unreadable', () => {
    const drive = temporary(); const a = computer(drive, 'desk', [record('run-a')]); a.sync.sync();
    fs.writeFileSync(path.join(drive, SYNC_FOLDER, 'settings.json'), '{"broken": true}');
    setRules(a.rules, 'Still syncs.'); const status = a.sync.sync();
    expect(status.error).toMatch(/settings\.json/);
    expect(JSON.parse(fs.readFileSync(path.join(drive, SYNC_FOLDER, 'rules.json'), 'utf8')).value.content).toBe('Still syncs.');
  });
});
