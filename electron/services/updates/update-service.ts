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
  updater: Updater;
  publish: (status: UpdateStatus) => void;
  hasSessions: () => boolean;
  prepareRestart: () => Promise<boolean>;
  installationFailed?: () => void;
}
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'check', 'download', 'install']) }).strict(),
  z.object({ action: z.literal('automatic'), enabled: z.boolean() }).strict(),
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
    let automaticChecks = true;
    try {
      const parsed = z.object({ automaticChecks: z.boolean() }).strict().parse(JSON.parse(readFileSync(this.settingsPath, 'utf8')));
      automaticChecks = parsed.automaticChecks;
    } catch { /* Invalid/missing preferences use the default; no credentials are stored here. */ }
    this.state = { phase: dependencies.enabled ? 'idle' : 'disabled', version: dependencies.version, availableVersion: null, progress: null, lastChecked: null, automaticChecks, message: dependencies.enabled ? 'Ready to check for stable releases.' : dependencies.disabledReason };
    const updater = dependencies.updater;
    updater.autoDownload = false;
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
      this.set({ phase: 'ready', availableVersion: info.version, progress: 100, message: 'Update downloaded. Stop all sessions, then restart to install.' });
    });
    updater.on('error', () => this.fail());
  }
  status(): UpdateStatus { return { ...this.state }; }
  private set(patch: Partial<UpdateStatus>) { this.state = { ...this.state, ...patch }; this.dependencies.publish(this.status()); }
  private fail() { if (this.state.phase === 'installing') this.dependencies.installationFailed?.(); this.set({ phase: 'error', message: 'Update failed. Check your connection and that a stable GitHub release includes its installer and latest.yml, then retry.' }); }
  start() {
    if (!this.dependencies.enabled || !this.state.automaticChecks || this.timer || this.interval) return;
    const check = () => { if (!this.busy && ['idle', 'current', 'error'].includes(this.state.phase)) void this.execute({ action: 'check' }).catch(() => {}); };
    this.timer = setTimeout(() => { this.timer = undefined; check(); }, 30_000);
    this.interval = setInterval(check, 4 * 60 * 60 * 1000);
    this.timer.unref?.(); this.interval.unref?.();
  }
  close() { if (this.timer) clearTimeout(this.timer); if (this.interval) clearInterval(this.interval); this.timer = undefined; this.interval = undefined; }
  async execute(payload: unknown): Promise<UpdateStatus> {
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_UPDATE_REQUEST', 'Invalid update request.');
    const request: UpdateRequest = parsed.data;
    if (request.action === 'status') return this.status();
    if (request.action === 'automatic') {
      mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      const temporary = `${this.settingsPath}.tmp`;
      writeFileSync(temporary, JSON.stringify({ automaticChecks: request.enabled }), { mode: 0o600 });
      renameSync(temporary, this.settingsPath);
      this.set({ automaticChecks: request.enabled });
      this.close(); this.start();
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
        await this.dependencies.updater.downloadUpdate();
      } else {
        if (this.dependencies.hasSessions()) throw new HubError('ACTIVE_SESSIONS', 'Stop all running or starting CLI sessions before installing an update.');
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

export function updatesEnabled(packaged: boolean, platform: string, resourcesPath: string, portable: boolean): boolean {
  return packaged && platform === 'win32' && !portable && existsSync(path.join(resourcesPath, 'app-update.yml'));
}
