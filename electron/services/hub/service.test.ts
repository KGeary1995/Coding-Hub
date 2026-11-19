import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HubService } from './service';
import { defaultDriveDirectory } from './preferences';
import { mainStalls } from '../storage/host-health';
import { DEFAULT_PREFERENCES, type MemoryNote } from '../../../shared/hub';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

describe('installing project memory', () => {
  it('refuses a subfolder of a repository, where CLIs never read project MCP settings', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project'); const sub = path.join(project, 'packages', 'app'); fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    const hub = new HubService(path.join(root, 'hub')); cleanup.push(() => hub.close());
    expect(() => hub.execute({ action: 'memory-install', directory: sub })).toThrow("repository's top folder");
    expect(fs.existsSync(path.join(sub, '.mcp.json'))).toBe(false);
  });
});

describe('Drive sync from the hub', () => {
  /** A hub whose Drive folder is a temporary one (never the person's real Drive), or none. */
  function hub(drive: boolean) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); const folder = path.join(root, 'drive'); if (drive) fs.mkdirSync(folder);
    const service = new HubService(path.join(root, 'hub'));
    // A note write starts a Drive sync the test need not wait for: removing the folder under it left the folder behind.
    cleanup.push(async () => { await service.drain(5000); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
    service.execute({ action: 'save-preferences', preferences: { ...DEFAULT_PREFERENCES, driveDirectory: drive ? folder : '' } });
    return { service, copy: (note: MemoryNote) => path.join(folder, 'AI-Coding-Hub-Memory', note.project, note.id + '.json'), tracked: () => (service as unknown as { projects: Set<string> }).projects };
  }
  it('saves a note at once and copies it to Drive without holding the process', async () => {
    const { service, copy, tracked } = hub(true);
    const note = service.execute({ action: 'memory-write', project: 'shared', title: 'Handoff', content: 'Body', author: 'human' }) as MemoryNote;
    // Before: the Drive folder was listed and the note copied before the request returned.
    expect(fs.existsSync(copy(note))).toBe(false); expect(tracked().has('shared')).toBe(true);
    await service.syncProject('shared'); expect(fs.existsSync(copy(note))).toBe(true);
  });
  it('lets quitting wait for a note saved at the end of a session to reach Drive', async () => {
    const { service, copy } = hub(true);
    const note = service.execute({ action: 'memory-write', project: 'shared', title: 'Session summary', content: 'Body', author: 'claude' }) as MemoryNote;
    await service.drain(5000); expect(fs.existsSync(copy(note))).toBe(true);
    // Nothing pending: it returns at once rather than waiting out the limit.
    const started = Date.now(); await service.drain(5000); expect(Date.now() - started).toBeLessThan(1000);
  });
  it('starts a channel’s sync in the background, and a launch can wait for it; neither throws while Drive is unavailable', async () => {
    const { service, tracked } = hub(false);
    expect(service.trackProject('shared')).toBeUndefined(); expect(tracked().has('shared')).toBe(true);
    await expect(service.syncProject('shared')).resolves.toBeUndefined();
    // Sync now still tells the person why it cannot run.
    await expect(service.executeAsync({ action: 'drive-sync', project: 'shared' })).rejects.toThrow('No Google Drive folder is selected');
    expect(() => service.execute({ action: 'drive-sync', project: 'shared' })).toThrow('executeAsync');
    // While Drive cannot be read, a key opened in the Memory panel still joins the sync, so its notes arrive when Drive does.
    tracked().clear(); expect(await service.executeAsync({ action: 'memory-list', project: 'elsewhere' })).toEqual([]); expect(tracked().has('elsewhere')).toBe(true);
  });
  it('keeps a key typed in the Memory panel out of the 30-second sync unless it has notes here or on Drive', async () => {
    const { service, tracked } = hub(true);
    expect(await service.executeAsync({ action: 'memory-list', project: 'shar' })).toEqual([]); expect(tracked().has('shar')).toBe(false);
    service.execute({ action: 'memory-write', project: 'shared', title: 'Handoff', content: 'Body', author: 'human' }); await service.syncProject('shared'); tracked().clear();
    expect(await service.executeAsync({ action: 'memory-list', project: 'shared' })).toHaveLength(1); expect(tracked().has('shared')).toBe(true);
    expect(await service.executeAsync({ action: 'memory-projects' })).toEqual([expect.objectContaining({ key: 'shared', notes: 1 })]);
  });
  it('saves several notes with one Drive sync per project, and says how many were saved when one fails', async () => {
    const { service, copy } = hub(true); const sync = vi.spyOn(service, 'syncProject');
    const note = (project: string, title: string) => ({ project, title, content: 'Body', author: 'codex' as const });
    const notes = service.execute({ action: 'memory-write-many', notes: [note('shared', 'F1'), note('shared', 'F2'), note('other', 'F3')] }) as MemoryNote[];
    expect(notes.map((item) => item.title)).toEqual(['F1', 'F2', 'F3']); expect(sync.mock.calls.map(([project]) => project).sort()).toEqual(['other', 'shared']);
    await service.drain(5000); for (const item of notes) expect(fs.existsSync(copy(item))).toBe(true);
    sync.mockClear();
    expect(() => service.execute({ action: 'memory-write-many', notes: [note('shared', 'F4'), { ...note('shared', 'F5'), supersedes: '00000000-0000-4000-8000-000000000000' }] })).toThrow('1 of 2 notes were saved');
    expect(sync.mock.calls.map(([project]) => project)).toEqual(['shared']);
    expect(() => service.execute({ action: 'memory-write-many', notes: [] })).toThrow();
  });
});

describe('the Drive folder of a computer with no saved preferences', () => {
  it('is Google Drive for desktop’s usual folder on Windows and none elsewhere, unless CODING_HUB_DEFAULT_DRIVE_DIR says otherwise', () => {
    expect(defaultDriveDirectory({}, 'win32')).toBe('G:\\My Drive\\Coding Hub'); expect(defaultDriveDirectory({}, 'darwin')).toBe('');
    expect(defaultDriveDirectory({ CODING_HUB_DEFAULT_DRIVE_DIR: '' }, 'win32')).toBe(''); expect(defaultDriveDirectory({ CODING_HUB_DEFAULT_DRIVE_DIR: '/tmp/drive' }, 'darwin')).toBe('/tmp/drive');
  });
  // Tests and smokes start Trace with no preferences.json; their notes reached the person's real Drive folder.
  it('keeps tests out of the person’s real Drive, while a saved folder still applies', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); const service = new HubService(path.join(root, 'hub'));
    cleanup.push(() => { vi.unstubAllEnvs(); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
    expect(service.preferences().driveDirectory).toBe(''); expect(service.drive.status().problem).toContain('No Google Drive folder is selected');
    // Off Windows the line above holds without the variable too: a folder named by it shows that the hub reads it.
    const named = path.join(root, 'named'); vi.stubEnv('CODING_HUB_DEFAULT_DRIVE_DIR', named); expect(service.preferences().driveDirectory).toBe(named);
    service.execute({ action: 'save-preferences', preferences: { ...DEFAULT_PREFERENCES, driveDirectory: root } }); expect(service.preferences().driveDirectory).toBe(root);
  });
});

describe('device sync from the hub', () => {
  it('publishes this computer’s usage at once for Sync now and when Trace quits, and at most every few minutes otherwise', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const service = new HubService(path.join(root, 'hub')); const sync = vi.spyOn(service.devices, 'sync');
    service.execute({ action: 'device-sync-now' }); expect(sync).toHaveBeenLastCalledWith(true);
    sync.mockClear(); service.close(); expect(sync).toHaveBeenCalledWith(true);
    // A failure at quit does not stop the rest of closing.
    sync.mockImplementation(() => { throw new Error('Drive gone'); }); expect(() => service.close()).not.toThrow();
  });
  it('labels the device sync in the 30-second tick for the stall record', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); const service = new HubService(path.join(root, 'hub'));
    const timed = vi.spyOn(mainStalls, 'timed'); const sync = vi.spyOn(service.devices, 'sync');
    cleanup.push(() => { timed.mockRestore(); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(timed).toHaveBeenCalledWith('hub-tick', expect.any(Function)); expect(sync).toHaveBeenCalledTimes(1);
  });
});
