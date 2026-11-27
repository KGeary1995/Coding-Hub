import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateService, updatesEnabled } from './update-service';

const directories: string[] = [];
class FakeUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; allowPrerelease = true; allowDowngrade = true; autoRunAppAfterInstall = true;
  checkForUpdates = vi.fn(async () => { this.emit('update-available', { version: '1.3.0' }); });
  /** Whether electron-updater would add its quit handler: it does when a download ends, only while autoInstallOnAppQuit is on. */
  quitHandler = false;
  downloadUpdate = vi.fn(async () => { this.emit('download-progress', { percent: 51 }); this.emit('update-downloaded', { version: '1.3.0' }); this.quitHandler ||= this.autoInstallOnAppQuit; });
  quitAndInstall = vi.fn();
}
function fixture(enabled = true, platform = 'win32') {
  const directory = mkdtempSync(path.join(tmpdir(), 'hub-updates-')); directories.push(directory);
  const updater = new FakeUpdater();
  const publish = vi.fn(); const hasSessions = vi.fn(() => false); const prepareRestart = vi.fn(async () => true);
  const dependencies = { installationFailed: vi.fn(), version: '1.2.0', enabled, disabledReason: 'Installed Windows edition required.', storageDirectory: directory, platform, updater, publish, hasSessions, prepareRestart };
  const service = new UpdateService(dependencies);
  return { service, updater, publish, hasSessions, prepareRestart, directory, dependencies };
}
afterEach(() => { vi.useRealTimers(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });
describe('Windows update lifecycle', () => {
  it('installs when a linked computer asks: checks, downloads, saves without a dialog, then restarts after answering', async () => {
    vi.useFakeTimers(); const { service, updater, prepareRestart, hasSessions } = fixture();
    hasSessions.mockReturnValueOnce(true); await expect(service.remoteInstall()).rejects.toMatchObject({ code: 'ACTIVE_SESSIONS' });
    expect(await service.remoteInstall()).toMatch(/Installing Trace 1\.3\.0 there/);
    expect(updater.checkForUpdates).toHaveBeenCalled(); expect(updater.downloadUpdate).toHaveBeenCalled(); expect(prepareRestart).toHaveBeenCalledWith(true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled(); vi.advanceTimersByTime(1500); expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
  it('reports a failed restart asked for by a linked computer, rather than staying in "restarting"', async () => {
    vi.useFakeTimers(); const { service, updater, dependencies } = fixture(); updater.quitAndInstall.mockImplementationOnce(() => { throw new Error('Installer missing'); });
    await service.remoteInstall(); vi.advanceTimersByTime(1500);
    expect(dependencies.installationFailed).toHaveBeenCalledOnce(); expect(service.status().phase).toBe('error');
  });
  it('keeps checking on schedule while a found update waits to be downloaded, so a newer one is noticed', async () => {
    vi.useFakeTimers(); const { service, updater } = fixture();
    // Its download failed (no connection, say): the next check still comes.
    updater.downloadUpdate.mockImplementation(async () => { updater.emit('error', new Error('offline')); });
    service.start(); await vi.advanceTimersByTimeAsync(30_000); expect(service.status()).toMatchObject({ phase: 'error', availableVersion: '1.3.0' });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); service.close();
  });
  it('says so when a linked computer asks and it is already up to date', async () => {
    const { service, updater } = fixture(); updater.checkForUpdates.mockImplementationOnce(async () => { updater.emit('update-not-available'); });
    expect(await service.remoteInstall()).toMatch(/already the latest/); expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await expect(fixture(false).service.remoteInstall()).rejects.toMatchObject({ code: 'UPDATES_DISABLED' });
  });
  it('checks stable releases, explicitly downloads and restarts', async () => {
    const { service, updater, publish } = fixture();
    expect(updater.autoDownload).toBe(false);
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
  it('downloads what an automatic check finds, so it is ready to install', async () => {
    vi.useFakeTimers(); const { service, updater } = fixture();
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1); expect(service.status()).toMatchObject({ phase: 'ready', message: 'Update downloaded. It installs when you quit Trace, or restart now to install it.' }); service.close();
  });
  it('on Windows, installs a downloaded update when Trace quits, unless turned off or something was left running', async () => {
    const { service, updater, directory, dependencies } = fixture();
    // Before anything is downloaded, quitting installs nothing.
    expect(updater.autoInstallOnAppQuit).toBe(false); expect(service.quitting({ safe: true, kept: true })).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
    await service.execute({ action: 'check' }); await service.execute({ action: 'download' });
    // The quit handler is added, but any quit other than Trace's own (a second one while it shuts down) installs nothing.
    expect(updater.quitHandler).toBe(true); expect(updater.autoInstallOnAppQuit).toBe(false);
    // Channels kept in the background runner do not hold it back on Windows; the updater's own quit handler installs.
    expect(service.quitting({ safe: true, kept: true })).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(true); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.quitting({ safe: false, kept: false })).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
    expect((await service.execute({ action: 'install-on-quit', enabled: false })).message).toBe('Update downloaded. Stop all channels, then restart to install.');
    expect(service.quitting({ safe: true, kept: false })).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(JSON.parse(readFileSync(path.join(directory, 'updates.json'), 'utf8'))).toEqual({ automaticChecks: true, installOnQuit: false });
    expect(new UpdateService(dependencies).status().installOnQuit).toBe(false);
  });
  it('on Windows, installs on quit when the setting is turned on only after the download (the quit handler is added at download)', async () => {
    const { updater, directory, dependencies } = fixture(); writeFileSync(path.join(directory, 'updates.json'), JSON.stringify({ automaticChecks: true, installOnQuit: false }));
    const off = new UpdateService(dependencies);
    await off.execute({ action: 'check' }); await off.execute({ action: 'download' }); expect(updater.quitHandler).toBe(true); expect(updater.autoInstallOnAppQuit).toBe(false);
    await off.execute({ action: 'install-on-quit', enabled: true }); off.quitting({ safe: true, kept: false }); expect(updater.autoInstallOnAppQuit).toBe(true);
  });
  it('on a Mac, installs on quit only with no channels kept running, and never through Squirrel on any quit', async () => {
    const { service, updater } = fixture(true, 'darwin');
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await service.execute({ action: 'check' }); await service.execute({ action: 'download' });
    expect(service.status().message).toBe('Update downloaded. It installs when you quit Trace with no channels left running, or restart now to install it.');
    expect(service.quitting({ safe: true, kept: true })).toBe(false); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    const giveUp = vi.fn(); expect(service.quitting({ safe: true, kept: false, giveUp })).toBe(true); expect(updater.autoRunAppAfterInstall).toBe(false); expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    // Opened again meanwhile: it opens on the new version once installed.
    expect(service.reopenAfterInstall()).toBe(true); expect(updater.autoRunAppAfterInstall).toBe(true);
    // Squirrel failed: Trace quits at once instead of waiting.
    updater.emit('error', new Error('read-only volume')); expect(giveUp).toHaveBeenCalledTimes(1); expect(service.reopenAfterInstall()).toBe(false);
  });
  it('reads a preferences file saved before install on quit existed', () => {
    const { directory, dependencies } = fixture(); writeFileSync(path.join(directory, 'updates.json'), JSON.stringify({ automaticChecks: false }));
    expect(new UpdateService(dependencies).status()).toMatchObject({ automaticChecks: false, installOnQuit: true });
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
    // A Mac app updates itself only when it was built with a Developer ID.
    expect(updatesEnabled(true, 'darwin', directory, false)).toBe(false);
    expect(updatesEnabled(true, 'darwin', directory, false, true)).toBe(true);
    expect(updatesEnabled(false, 'darwin', directory, false, true)).toBe(false);
    expect(updatesEnabled(true, 'darwin', path.join(directory, 'missing'), false, true)).toBe(false);
  });
  it('opens the downloads page from any edition, updating or not', async () => {
    for (const enabled of [false, true]) {
      const { service, dependencies } = fixture(enabled); const openDownloads = vi.fn(async () => {});
      const withPage = new UpdateService({ ...dependencies, openDownloads });
      expect((await withPage.execute({ action: 'downloads' })).phase).toBe(enabled ? 'idle' : 'disabled');
      expect(openDownloads).toHaveBeenCalledOnce();
      await expect(service.execute({ action: 'downloads', url: 'https://example.com' })).rejects.toMatchObject({ code: 'INVALID_UPDATE_REQUEST' });
    }
  });
});
