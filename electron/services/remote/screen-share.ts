import { spawn } from 'node:child_process';
import http from 'node:http';
import { app } from 'electron';
import { HubError } from '../cli/engine-adapter';
import { save } from '../workbench/local-store';
import { SCREEN_SERVICE_PATH, SCREEN_SERVICE_PORT, type ScreenShareStatus } from '../../../shared/screen';
import { SHARE_FILE, shareEnabled } from './screen-service-server';
import type { RunTailscale } from './tailscale';

/** The name of the sign-in entry (Settings → Apps → Startup lists it). */
const LOGIN_NAME = 'Trace screen sharing';

/**
 * Settings → Other computers → Share this screen, on Windows: starts the screen service (Trace with --screen-service),
 * registers it to start at sign-in, and has `tailscale serve` pass https://<name>.ts.net/api/screen to it. Off undoes
 * all three (the service sees the switch and quits).
 */
export class ScreenShare {
  constructor(private root: string, private name: () => string, private runTailscale: RunTailscale, private port = SCREEN_SERVICE_PORT) {}
  get supported() { return process.platform === 'win32'; }

  async status(): Promise<ScreenShareStatus> { return { supported: this.supported, enabled: this.supported && shareEnabled(this.root), running: this.supported && await this.running() }; }

  async set(enabled: boolean): Promise<ScreenShareStatus> {
    if (!this.supported) throw new HubError('SCREEN_UNSUPPORTED', 'Trace shares the screen on Windows. On a Mac, turn on System Settings → General → Sharing → Screen Sharing instead.');
    if (enabled) await this.serve();
    save(this.root, SHARE_FILE, { enabled }); this.login(enabled);
    if (enabled) await this.start(); else await this.runTailscale(['serve', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, 'off']).catch(() => {});
    return this.status();
  }

  /** When Trace starts: the service runs again (an update closes it), and the Tailscale path is put back if it went. */
  async ensure() {
    if (!this.supported || !shareEnabled(this.root)) return;
    this.login(true); await this.serve().catch(() => {}); await this.start();
  }

  private running() {
    return new Promise<boolean>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 1500 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
      request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false); });
    });
  }
  private async start() {
    if (await this.running()) return;
    spawn(process.execPath, this.args(), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 40 && !(await this.running()); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  private args() { return [...(app.isPackaged ? [] : [app.getAppPath()]), '--screen-service', `--storage=${this.root}`, `--name=${this.name()}`]; }
  private login(enabled: boolean) { app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: this.args(), name: LOGIN_NAME }); }
  private async serve() {
    try { await this.runTailscale(['serve', '--bg', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, `http://127.0.0.1:${this.port}`]); }
    catch (error) { throw new HubError('SCREEN_TAILSCALE', `Tailscale could not pass the screen on (${(error as Error).message}). Set up Phone access with Tailscale HTTPS above first.`); }
  }
}
