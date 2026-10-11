import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateService, updatesEnabled } from './update-service';

const directories: string[] = [];
class FakeUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; allowPrerelease = true; allowDowngrade = true;
  checkForUpdates = vi.fn(async () => { this.emit('update-available', { version: '1.3.0' }); });
  downloadUpdate = vi.fn(async () => { this.emit('download-progress', { percent: 51 }); this.emit('update-downloaded', { version: '1.3.0' }); });
  quitAndInstall = vi.fn();
}
function fixture(enabled = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hub-updates-')); directories.push(directory);
  const updater = new FakeUpdater();
  const publish = vi.fn(); const hasSessions = vi.fn(() => false); const prepareRestart = vi.fn(async () => true);
  const dependencies = { installationFailed: vi.fn(), version: '1.2.0', enabled, disabledReason: 'Installed Windows edition required.', storageDirectory: directory, updater, publish, hasSessions, prepareRestart };
  const service = new UpdateService(dependencies);
  return { service, updater, publish, hasSessions, prepareRestart, directory, dependencies };
}
afterEach(() => { vi.useRealTimers(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });
describe('Windows update lifecycle', () => {
  it('checks stable releases, explicitly downloads and restarts; never installs on normal quit', async () => {
    const { service, updater, publish } = fixture();
    expect(updater.autoDownload).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false); expect(updater.allowDowngrade).toBe(false);
    expect((await service.execute({ action: 'check' })).phase).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect((await service.execute({ action: 'download' })).phase).toBe('ready');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await service.execute({ action: 'install' });
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(publish.mock.calls.some(([state]) => state.progress === 51)).toBe(true);
  });
  it('blocks active sessions, honors cancellation, and blocks installation when saving fails', async () => {
    const { service, updater, hasSessions, prepareRestart } = fixture();
    await service.execute({ action: 'check' }); await service.execute({ action: 'download' });
    hasSessions.mockReturnValue(true);
    await expect(service.execute({ action: 'install' })).rejects.toMatchObject({ code: 'ACTIVE_SESSIONS' });
    expect(prepareRestart).not.toHaveBeenCalled();
    hasSessions.mockReturnValue(false); prepareRestart.mockResolvedValue(false);
    expect((await service.execute({ action: 'install' })).phase).toBe('ready');
    prepareRestart.mockRejectedValue(new Error('Storage unavailable'));
    expect((await service.execute({ action: 'install' })).phase).toBe('error');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('unlocks launches when the updater fails to start the installer and retains the downloaded update for retry', async () => {
    const { service, updater, dependencies } = fixture();
    dependencies.installationFailed = vi.fn();
    await service.execute({ action: 'check' }); await service.execute({ action: 'download' });
    updater.quitAndInstall.mockImplementationOnce(() => { updater.emit('error', new Error('Installer locked')); });
    expect((await service.execute({ action: 'install' })).phase).toBe('error');
    expect(dependencies.installationFailed).toHaveBeenCalledOnce();
    expect((await service.execute({ action: 'install' })).phase).toBe('installing');
  });
  it('rejects invalid actions/URLs and unsafe lifecycle transitions', async () => {
    const { service } = fixture();
    await expect(service.execute({ action: 'check', url: 'https://untrusted.invalid' })).rejects.toMatchObject({ code: 'INVALID_UPDATE_REQUEST' });
    await expect(service.execute({ action: 'install' })).rejects.toMatchObject({ code: 'UPDATE_STATE' });
    await expect(service.execute({ action: 'download' })).rejects.toMatchObject({ code: 'UPDATE_STATE' });
    await service.execute({ action: 'check' }); await service.execute({ action: 'download' });
    await expect(service.execute({ action: 'check' })).rejects.toMatchObject({ code: 'UPDATE_STATE' });
  });
  it('reports network/verification errors without leaking diagnostics and allows retry', async () => {
    const { service, updater } = fixture();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('secret-token'));
    expect((await service.execute({ action: 'check' })).phase).toBe('error');
    expect(service.status().message).not.toContain('secret-token');
    await service.execute({ action: 'check' });
    updater.downloadUpdate.mockRejectedValueOnce(new Error('Checksum mismatch'));
    expect((await service.execute({ action: 'download' })).phase).toBe('error');
    expect((await service.execute({ action: 'download' })).phase).toBe('ready');
  });
  it('serializes concurrent checks and downloads', async () => {
    const { service, updater } = fixture();
    let resolve!: () => void;
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const pending = service.execute({ action: 'check' });
    await expect(service.execute({ action: 'check' })).rejects.toMatchObject({ code: 'UPDATE_BUSY' });
    updater.emit('update-available', { version: '1.3.0' }); resolve(); await pending;
  });
  it('persists automatic-check preference and stops scheduled checks when disabled', async () => {
    vi.useFakeTimers();
    const { service, updater, directory, dependencies } = fixture();
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await service.execute({ action: 'automatic', enabled: false });
    expect(JSON.parse(readFileSync(path.join(directory, 'updates.json'), 'utf8')).automaticChecks).toBe(false);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    const restored = new UpdateService(dependencies);
    expect(restored.status().automaticChecks).toBe(false); restored.close(); service.close();
  });
  it('disables source/portable/non-Windows hosts even when update metadata is present', async () => {
    const { service, directory } = fixture(false);
    await expect(service.execute({ action: 'check' })).rejects.toMatchObject({ code: 'UPDATES_DISABLED' });
    writeFileSync(path.join(directory, 'app-update.yml'), 'provider: github');
    expect(updatesEnabled(true, 'win32', directory, false)).toBe(true);
    expect(updatesEnabled(false, 'win32', directory, false)).toBe(false);
    expect(updatesEnabled(true, 'linux', directory, false)).toBe(false);
    expect(updatesEnabled(true, 'win32', directory, true)).toBe(false);
    expect(updatesEnabled(true, 'win32', path.join(directory, 'missing'), false)).toBe(false);
  });
});
