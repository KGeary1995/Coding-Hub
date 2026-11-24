import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron';
import { previewNavigation, type PreviewAddress, type PreviewStatus } from '../../../shared/app-preview';
import { HubError } from '../cli/engine-adapter';

/** In memory only (no `persist:`): the app's cookies and storage are gone when Trace quits, and never mix with Trace's own. */
const PARTITION = 'trace-app-preview';
/** A phone gets a new picture at most this often; asking sooner gets the last one. */
const PICTURE_EVERY = 1000;
/** The phone's picture: at most this wide, as JPEG, and never larger than this. */
const PICTURE_WIDTH = 1024; const PICTURE_BYTES = 1536 * 1024;
/** A phone's page is closed once no phone has asked for its picture for this long. */
const PHONE_IDLE = 2 * 60000;
/** How often an open preview checks that its app still answers, so a stopped server says so without a reload. */
const ALIVE_EVERY = 5000;

/**
 * The page is someone's app, not Trace: it runs sandboxed with no preload, in its own session that grants no permission
 * and downloads nothing, and it stays on its own address. Another web address opens in the system browser; anything else
 * (file:, javascript:, data:) goes nowhere.
 */
export const PREVIEW_PREFERENCES: Electron.WebPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, partition: PARTITION, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true };
let hardened = false;
function harden(contents: WebContents, address: () => string) {
  if (!hardened) {
    hardened = true; const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); session.setPermissionCheckHandler(() => false); session.setDevicePermissionHandler(() => false);
    session.on('will-download', (event) => event.preventDefault());
  }
  const leave = (event: Electron.Event, url: string) => { const where = previewNavigation(url, address()); if (where === 'allow') return; event.preventDefault(); if (where === 'external') void shell.openExternal(url); };
  contents.on('will-navigate', leave); contents.on('will-redirect', leave);
  contents.setWindowOpenHandler(({ url }) => { if (previewNavigation(url, address()) !== 'block') void shell.openExternal(url); return { action: 'deny' }; });
}
/** Whether a main-frame load failure means the app is not there (refused, reset, unreachable), rather than a navigation Trace cancelled. */
const gone = (code: number, mainFrame: boolean) => mainFrame && code !== -3;
/** Whether something still listens at the app's address; a slow answer counts as there (a busy dev server is not a stopped one). */
async function answers(url: string) {
  try { await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2500), redirect: 'manual' }); return true; }
  catch (error) { return error instanceof Error && error.name === 'TimeoutError'; }
}

/**
 * The app preview (1.39.0): one page beside the channels, a WebContentsView owned by the main process over the window's
 * own content, placed where the window keeps room for it. Phones get pictures of the app from a page of their own, drawn
 * off screen, so they work while Trace's window is hidden or shows something else.
 */
export class AppPreview {
  private view: WebContentsView | null = null;
  private shown: { sessionId: string; address: PreviewAddress; status: PreviewStatus } | null = null;
  private bounds: Electron.Rectangle | null = null;
  private alive: ReturnType<typeof setInterval> | null = null;
  private phones = new Map<string, { page: BrowserWindow; address: PreviewAddress; used: number; picture: { at: number; data: Buffer } | null; taking: Promise<Buffer> | null; stopped: boolean }>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  constructor(private window: () => BrowserWindow | null, private publish: (sessionId: string, port: number, status: PreviewStatus) => void) {}

  current() { return this.shown ? { sessionId: this.shown.sessionId, port: this.shown.address.port, status: this.shown.status } : null; }
  show(sessionId: string, address: PreviewAddress) {
    const window = this.window(); if (!window || window.isDestroyed()) throw new HubError('PREVIEW_WINDOW', 'Trace’s window is not open.');
    if (!this.view) {
      const view = new WebContentsView({ webPreferences: PREVIEW_PREFERENCES }); this.view = view;
      harden(view.webContents, () => this.shown?.address.url ?? 'http://localhost/');
      view.webContents.on('did-fail-load', (_event, code, _text, _url, mainFrame) => { if (gone(code, mainFrame)) this.status('stopped'); });
      view.webContents.on('did-finish-load', () => { if (this.shown?.status === 'loading') this.status('ready'); });
      view.webContents.on('render-process-gone', () => this.status('stopped'));
      view.setBackgroundColor('#ffffff'); view.setVisible(false); window.contentView.addChildView(view);
    }
    this.shown = { sessionId, address, status: 'loading' }; this.place(); this.publishStatus();
    void this.view.webContents.loadURL(address.url).catch(() => { /* did-fail-load says it stopped. */ });
    this.alive ??= setInterval(() => void this.check(), ALIVE_EVERY);
  }
  /** Where the window keeps room for the page, in its CSS pixels (scaled here by the window's zoom); null hides it. */
  place(bounds?: Electron.Rectangle | null) {
    if (bounds !== undefined) this.bounds = bounds; const window = this.window(); if (!this.view || !window || window.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor(); const room = this.bounds;
    // A stopped app is hidden, so the window's own "The app stopped" and Reload show in its place.
    const visible = Boolean(room && room.width >= 1 && room.height >= 1 && this.shown?.status === 'ready');
    if (room) this.view.setBounds({ x: Math.round(room.x * zoom), y: Math.round(room.y * zoom), width: Math.round(room.width * zoom), height: Math.round(room.height * zoom) });
    this.view.setVisible(visible);
  }
  reload() { if (!this.shown || !this.view) throw new HubError('PREVIEW_CLOSED', 'No app preview is open.'); this.status('loading'); void this.view.webContents.loadURL(this.shown.address.url).catch(() => {}); }
  async openInBrowser() { if (!this.shown) throw new HubError('PREVIEW_CLOSED', 'No app preview is open.'); await shell.openExternal(this.shown.address.url); }
  close() {
    if (this.alive) clearInterval(this.alive); this.alive = null; const view = this.view; this.view = null; this.shown = null;
    if (!view) return; const window = this.window(); try { if (window && !window.isDestroyed()) window.contentView.removeChildView(view); } catch { /* Already gone with the window. */ }
    view.webContents.close();
  }
  /** The channel's run ended: its app is shown as stopped, and phones' pages of it are closed. */
  ended(sessionId: string) { if (this.shown?.sessionId === sessionId) this.status('stopped'); this.closePhone(sessionId); }
  /** Asks the app for its address now and then: a server that stopped (Ctrl+C in its channel) shows as stopped. */
  private async check() {
    const shown = this.shown; if (!shown || shown.status !== 'ready') return;
    if (!await answers(shown.address.url) && this.shown === shown) this.status('stopped');
  }
  private status(status: PreviewStatus) { if (!this.shown || this.shown.status === status) return; this.shown.status = status; this.place(); this.publishStatus(); }
  private publishStatus() { if (this.shown) this.publish(this.shown.sessionId, this.shown.address.port, this.shown.status); }

  /**
   * A picture of a channel's app for a phone, as JPEG: from a page drawn off screen (opened on the first ask, closed after
   * two quiet minutes), at most one a second however often phones ask.
   */
  async picture(sessionId: string, address: PreviewAddress): Promise<Buffer> {
    let phone = this.phones.get(sessionId);
    // A page whose app stopped is opened afresh: the app may be back, and if not the phone is told it stopped.
    if (phone && (phone.address.url !== address.url || phone.stopped)) { this.closePhone(sessionId); phone = undefined; }
    if (!phone) {
      const page = new BrowserWindow({ show: false, width: 1024, height: 720, title: 'Trace app preview', skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true, webPreferences: { ...PREVIEW_PREFERENCES, offscreen: true } });
      page.on('page-title-updated', (event) => event.preventDefault()); page.webContents.setFrameRate(5);
      harden(page.webContents, () => address.url);
      const opened = phone = { page, address, used: Date.now(), picture: null, taking: null, stopped: false as boolean }; this.phones.set(sessionId, phone);
      page.webContents.on('did-fail-load', (_event, code, _text, _url, mainFrame) => { if (gone(code, mainFrame)) opened.stopped = true; });
      page.webContents.on('render-process-gone', () => { opened.stopped = true; });
      try { await page.loadURL(address.url); } catch { this.closePhone(sessionId); throw new HubError('PREVIEW_STOPPED', 'The app stopped. Start it again in its channel, then try again.'); }
      this.sweep ??= setInterval(() => { for (const [id, item] of this.phones) if (Date.now() - item.used > PHONE_IDLE) this.closePhone(id); }, 30000);
    }
    phone.used = Date.now();
    if (phone.picture && Date.now() - phone.picture.at < PICTURE_EVERY) return phone.picture.data;
    const current = phone; current.taking ??= (async () => {
      if (!await answers(current.address.url)) { current.taking = null; this.closePhone(sessionId); throw new HubError('PREVIEW_STOPPED', 'The app stopped. Start it again in its channel, then try again.'); }
      try {
        // A page just loaded has no frame drawn yet: it is asked again, a few times, a moment later.
        let image: Electron.NativeImage | null = null;
        for (let tries = 0; !image && tries < 6; tries++) { if (tries) await new Promise((resolve) => setTimeout(resolve, 250)); image = await current.page.webContents.capturePage().then((taken) => taken.isEmpty() ? null : taken, () => null); }
        if (!image) throw new Error('empty');
        const sized = image.getSize().width > PICTURE_WIDTH ? image.resize({ width: PICTURE_WIDTH }) : image;
        let data = sized.toJPEG(70); if (data.length > PICTURE_BYTES) data = sized.toJPEG(40);
        if (data.length > PICTURE_BYTES) throw new Error('large');
        current.picture = { at: Date.now(), data }; return data;
      } catch { throw new HubError('PREVIEW_PICTURE', 'Trace could not take a picture of the app just now. Try again.'); } finally { current.taking = null; }
    })();
    return current.taking;
  }
  private closePhone(sessionId: string) { const phone = this.phones.get(sessionId); if (!phone) return; this.phones.delete(sessionId); if (!phone.page.isDestroyed()) phone.page.destroy(); if (!this.phones.size && this.sweep) { clearInterval(this.sweep); this.sweep = null; } }
  dispose() { this.close(); for (const id of [...this.phones.keys()]) this.closePhone(id); }
}
