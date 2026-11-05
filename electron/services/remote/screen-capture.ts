import path from 'node:path';
import { BrowserWindow, desktopCapturer, screen, session } from 'electron';
import type { FrameRect, ScreenSource } from './rfb-server';
import { layoutDisplays, type DisplayRect } from './screen-layout';

const PARTITION = 'trace-screen-capture';

/**
 * Captures every display, as one picture laid out as Windows arranges them (screen-layout.ts), in a hidden window (screen-capture-preload.ts does the work), opened for one viewer and
 * closed after. Its own in-memory session may use the screen capture; nothing else there may ask for anything.
 */
export class ScreenCapture implements ScreenSource {
  width = 0; height = 0;
  private next = 0; private pending = new Map<number, { resolve: (rects: FrameRect[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private window: BrowserWindow) {}

  static async start(page: string): Promise<ScreenCapture> {
    const capture = session.fromPartition(PARTITION);
    let window: BrowserWindow | null = null;
    capture.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && !(details as { mediaTypes?: string[] }).mediaTypes?.includes('audio')));
    capture.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && permission === 'media');
    window = new BrowserWindow({ show: false, width: 200, height: 200, skipTaskbar: true, webPreferences: { preload: path.join(__dirname, '../../screen-capture-preload.js'), partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const instance = new ScreenCapture(window);
    try {
      await window.loadFile(page);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length) throw new Error('No display was found.');
      // Physical pixels on the virtual desktop (what SendInput's coordinates use); a display Electron cannot place falls back to the main one alone.
      const displays: DisplayRect[] = screen.getAllDisplays().map((display) => {
        const rect = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : { x: display.bounds.x * display.scaleFactor, y: display.bounds.y * display.scaleFactor, width: display.bounds.width * display.scaleFactor, height: display.bounds.height * display.scaleFactor };
        return { id: String(display.id), ...rect };
      });
      const layout = layoutDisplays(displays);
      let parts = layout.parts.flatMap((part) => { const source = sources.find((item) => item.display_id === part.id); return source ? [{ ...part, sourceId: source.id }] : []; });
      let size = { width: layout.width, height: layout.height };
      if (!parts.length) { const one = layoutDisplays([{ id: '', x: 0, y: 0, ...screen.getPrimaryDisplay().size }]); size = one; parts = [{ ...one.parts[0], sourceId: sources[0].id }]; }
      const started = await new Promise<{ width?: number; height?: number; error?: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ error: 'The capture did not start.' }), 15000);
        window!.webContents.ipc.once('trace-capture-started', (_event, value) => { clearTimeout(timer); resolve(value); });
        window!.webContents.send('trace-capture-start', { ...size, parts });
      });
      if (started.error || !started.width || !started.height) throw new Error(started.error ?? 'The capture did not start.');
      instance.width = started.width; instance.height = started.height;
      window.webContents.ipc.on('trace-capture-frame', (_event, value: { id: number; rects?: FrameRect[]; error?: string }) => {
        const waiting = instance.pending.get(value.id); if (!waiting) return; instance.pending.delete(value.id); clearTimeout(waiting.timer);
        if (value.error || !value.rects) waiting.reject(new Error(value.error ?? 'No frame.')); else waiting.resolve(value.rects);
      });
      window.webContents.on('render-process-gone', () => instance.stop());
      return instance;
    } catch (error) { window.destroy(); throw error; }
  }

  frame(full: boolean): Promise<FrameRect[]> {
    if (this.window.isDestroyed()) return Promise.reject(new Error('The capture stopped.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The capture stopped answering.')); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.window.webContents.send('trace-capture-frame', { id, full });
    });
  }

  stop() {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('The capture stopped.')); } this.pending.clear();
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
