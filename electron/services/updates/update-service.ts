import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { UpdateRequest, UpdateStatus } from '../../../shared/updates';
import { HubError } from '../cli/engine-adapter';

interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoRunAppAfterInstall: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}
interface Dependencies {
  version: string;
  enabled: boolean;
  disabledReason: string;
  storageDirectory: string;
  /** process.platform: Windows installs on quit through the updater's own quit handler, a Mac through Squirrel (quitting). */
  platform?: string;
  updater: Updater;
  publish: (status: UpdateStatus) => void;
  hasSessions: () => boolean;
  /** `remote`: asked for from a linked computer, so no one is here to answer a dialog. */
  prepareRestart: (remote?: boolean) => Promise<boolean>;
  installationFailed?: () => void;
  /** Opens the public downloads page, for editions that are updated by hand. */
  openDownloads?: () => Promise<void>;
}
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'check', 'download', 'install', 'downloads']) }).strict(),
  z.object({ action: z.enum(['automatic', 'install-on-quit']), enabled: z.boolean() }).strict(),
]);

/** Only the native host selects the release provider. Renderer requests contain no URLs. */
export class UpdateService {
  private state: UpdateStatus;
  private settingsPath: string;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private busy = false;
  private recoveryPhase: 'idle' | 'available' | 'ready' = 'idle';
  constructor(private dependencies: Dependencies) {
    this.settingsPath = path.join(dependencies.storageDirectory, 'updates.json');
    let automaticChecks = true; let installOnQuit = true;
    try {
      const parsed = z.object({ automaticChecks: z.boolean(), installOnQuit: z.boolean().optional() }).strict().parse(JSON.parse(readFileSync(this.settingsPath, 'utf8')));
      automaticChecks = parsed.automaticChecks; installOnQuit = parsed.installOnQuit ?? true;
    } catch { /* Invalid/missing preferences use the default; no credentials are stored here. */ }
    this.state = { phase: dependencies.enabled ? 'idle' : 'disabled', version: dependencies.version, availableVersion: null, progress: null, lastChecked: null, automaticChecks, installOnQuit, message: dependencies.enabled ? 'Ready to check for stable releases.' : dependencies.disabledReason };
    const updater = dependencies.updater;
    updater.autoDownload = false;
    // Off unless quitting turns it on for Trace's own quit: any other quit (a second one while Trace shuts down) installs
    // nothing. On Windows it is on only while a download runs, so the updater adds its quit handler then (download).
    // A Mac's Squirrel would install whatever quit came, so there quitting installs instead.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('update-available', (info: { version: string }) => {
      this.recoveryPhase = 'available';
      this.set({ phase: 'available', availableVersion: info.version, progress: null, message: `Version ${info.version} is available to download.` });
    });
    updater.on('update-not-available', () => {
      this.recoveryPhase = 'idle';
      this.set({ phase: 'current', availableVersion: null, progress: null, message: 'You have the latest stable release.' });
    });
    updater.on('download-progress', (info: { percent: number }) => {
      if (this.state.phase === 'downloading') this.set({ progress: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : null });
    });
    updater.on('update-downloaded', (info: { version: string }) => {
      this.recoveryPhase = 'ready';
      this.set({ phase: 'ready', availableVersion: info.version, progress: 100, message: this.readyMessage() });
    });
    updater.on('error', () => this.fail());
  }
  private get windows() { return (this.dependencies.platform ?? process.platform) === 'win32'; }
  private readyMessage() { return this.state.installOnQuit ? `Update downloaded. It installs when you quit Trace${this.windows ? '' : ' with no channels left running'}, or restart now to install it.` : 'Update downloaded. Stop all channels, then restart to install.'; }
  status(): UpdateStatus { return { ...this.state }; }
  /** Windows' quit handler is added when a download ends, and only while autoInstallOnAppQuit is on: on just for that. */
  private async download() {
    const updater = this.dependencies.updater; if (this.windows) updater.autoInstallOnAppQuit = true;
    try { await updater.downloadUpdate(); } finally { updater.autoInstallOnAppQuit = false; }
  }
  /**
   * Trace is quitting (main.ts, once channels were stopped or left to the background runner and storage is saved):
   * whether a downloaded update installs now. `safe`: nothing was left running that the installer would meet; `kept`:
   * channels keep running in the background runner, which on a Mac runs from the app an update replaces. On Windows
   * the updater installs on its own quit handler (false returned: quit as usual); on a Mac true means quitAndInstall
   * was called and quits Trace itself once Squirrel has the update.
   */
  quitting({ safe, kept, giveUp }: { safe: boolean; kept: boolean; giveUp?: () => void }): boolean {
    const install = this.dependencies.enabled && this.state.installOnQuit && this.recoveryPhase === 'ready' && this.state.phase !== 'installing' && safe;
    if (this.windows) { this.dependencies.updater.autoInstallOnAppQuit = install; return false; }
    if (!install || kept) return false;
    this.giveUp = giveUp;
    try { this.dependencies.updater.autoRunAppAfterInstall = false; this.dependencies.updater.quitAndInstall(); return true; } catch { this.giveUp = undefined; return false; }
  }
  /** Trace was opened again while a Mac quits to install: it opens again, on the new version, once installed. */
  reopenAfterInstall() { if (this.giveUp) this.dependencies.updater.autoRunAppAfterInstall = true; return Boolean(this.giveUp); }
  private set(patch: Partial<UpdateStatus>) { this.state = { ...this.state, ...patch }; this.dependencies.publish(this.status()); }
  /** A Mac quitting to install (quitting): told when the updater fails, so Trace quits instead of waiting. */
  private giveUp?: () => void;
  private fail() { const giveUp = this.giveUp; this.giveUp = undefined; giveUp?.(); if (this.state.phase === 'installing') this.dependencies.installationFailed?.(); this.set({ phase: 'error', message: 'Update failed. Check your connection and that a stable GitHub release includes its installer and update feed (latest.yml, or latest-mac.yml on a Mac), then retry.' }); }
  start() {
    if (!this.dependencies.enabled || !this.state.automaticChecks || this.timer || this.interval) return;
    // 'available' too: a release found but not downloaded yet may have been replaced by a newer one since.
    // What a check finds is downloaded at once, so it is ready to install when Trace quits or restarts (1.51.0).
    const check = () => { if (!this.busy && ['idle', 'current', 'available', 'error'].includes(this.state.phase)) void this.execute({ action: 'check' }).then(() => this.state.automaticChecks && this.state.phase === 'available' ? this.execute({ action: 'download' }) : undefined).catch(() => {}); };
    this.timer = setTimeout(() => { this.timer = undefined; check(); }, 30_000);
    this.interval = setInterval(check, 4 * 60 * 60 * 1000);
    this.timer.unref?.(); this.interval.unref?.();
  }
  close() { if (this.timer) clearTimeout(this.timer); if (this.interval) clearInterval(this.interval); this.timer = undefined; this.interval = undefined; }
  /**
   * Restart and install, asked for from a linked computer: checks for and downloads the update first if needed, then
   * restarts shortly after answering, so the answer reaches that computer. Returns what will happen, in its words.
   */
  async remoteInstall(): Promise<string> {
    if (!this.dependencies.enabled) throw new HubError('UPDATES_DISABLED', this.state.message);
    if (this.busy) throw new HubError('UPDATE_BUSY', 'An update is already being checked or downloaded there. Try again in a minute.');
    if (this.dependencies.hasSessions()) throw new HubError('ACTIVE_SESSIONS', 'Stop the channels running there first, then try again.');
    this.busy = true;
    try {
      const phase = this.state.phase === 'error' ? this.recoveryPhase : this.state.phase;
      if (phase === 'idle' || phase === 'current' || phase === 'available') {
        if (phase !== 'available') { this.set({ phase: 'checking', lastChecked: new Date().toISOString(), message: 'Checking GitHub for stable releases…' }); await this.dependencies.updater.checkForUpdates(); }
        if (this.state.phase === 'current') return `Trace ${this.dependencies.version} there is already the latest version.`;
        if (this.state.phase !== 'available') throw new HubError('UPDATE_FAILED', 'Trace there could not check for updates. Check its connection.');
        this.set({ phase: 'downloading', progress: 0, message: 'Downloading and verifying the update…' }); await this.download();
      }
      if (this.state.phase !== 'ready') throw new HubError('UPDATE_FAILED', 'Trace there could not download the update.');
      if (!await this.dependencies.prepareRestart(true)) throw new HubError('UPDATE_FAILED', 'Trace there could not get ready to restart.');
      const version = this.state.availableVersion;
      this.set({ phase: 'installing', message: 'Restarting to install the update…' });
      // A throw here would otherwise leave Trace refusing everything as 'restarting' until restarted by hand.
      setTimeout(() => { try { this.dependencies.updater.quitAndInstall(false, true); } catch { this.fail(); } }, 1500);
      return `Installing Trace ${version ?? 'update'} there. It restarts and is back in about a minute.`;
    } catch (error) {
      if (error instanceof HubError) throw error;
      this.fail(); throw new HubError('UPDATE_FAILED', 'Trace there could not download the update. Check its connection.');
    } finally { this.busy = false; }
  }
  async execute(payload: unknown): Promise<UpdateStatus> {
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_UPDATE_REQUEST', 'Invalid update request.');
    const request: UpdateRequest = parsed.data;
    if (request.action === 'status') return this.status();
    if (request.action === 'downloads') { await this.dependencies.openDownloads?.(); return this.status(); }
    if (request.action === 'automatic' || request.action === 'install-on-quit') {
      const next = request.action === 'automatic' ? { automaticChecks: request.enabled, installOnQuit: this.state.installOnQuit } : { automaticChecks: this.state.automaticChecks, installOnQuit: request.enabled };
      mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      const temporary = `${this.settingsPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, this.settingsPath);
      this.set(next);
      if (this.state.phase === 'ready') this.set({ message: this.readyMessage() });
      if (request.action === 'automatic') { this.close(); this.start(); }
      return this.status();
    }
    if (!this.dependencies.enabled) throw new HubError('UPDATES_DISABLED', this.state.message);
    if (this.busy) throw new HubError('UPDATE_BUSY', 'An update operation is already in progress.');
    const phase = this.state.phase === 'error' ? this.recoveryPhase : this.state.phase;
    if (request.action === 'check' && !['idle', 'current', 'available'].includes(phase)) throw new HubError('UPDATE_STATE', 'Finish the downloaded update before checking again.');
    if (request.action === 'download' && phase !== 'available') throw new HubError('UPDATE_STATE', 'Check for an available update before downloading.');
    if (request.action === 'install' && phase !== 'ready') throw new HubError('UPDATE_STATE', 'Download the update before installing.');
    this.busy = true;
    try {
      if (request.action === 'check') {
        this.set({ phase: 'checking', lastChecked: new Date().toISOString(), message: 'Checking GitHub for stable releases…' });
        await this.dependencies.updater.checkForUpdates();
      } else if (request.action === 'download') {
        this.set({ phase: 'downloading', progress: 0, message: 'Downloading and verifying the update…' });
        await this.download();
      } else {
        if (this.dependencies.hasSessions()) throw new HubError('ACTIVE_SESSIONS', 'Stop all running or starting channels before installing an update.');
        if (!await this.dependencies.prepareRestart()) return this.status();
        this.set({ phase: 'installing', message: 'Restarting to install the update…' });
        this.dependencies.updater.quitAndInstall(false, true);
      }
    } catch (error) {
      if (error instanceof HubError) throw error;
      this.fail();
    } finally { this.busy = false; }
    return this.status();
  }
}

/**
 * The installed Windows edition updates itself, and so does a Mac app built with a Developer ID (`macUpdates`, from
 * `traceMacUpdates` in its package.json): macOS installs an update only if it is signed by the same developer.
 */
export function updatesEnabled(packaged: boolean, platform: string, resourcesPath: string, portable: boolean, macUpdates = false): boolean {
  return packaged && (platform === 'win32' ? !portable : platform === 'darwin' && macUpdates) && existsSync(path.join(resourcesPath, 'app-update.yml'));
}
