import path from 'node:path';
import { BrowserWindow, desktopCapturer, screen, session } from 'electron';
import type { FrameRect, ScreenSource } from './rfb-server';

const PARTITION = 'trace-screen-capture';
/** Larger screens are captured scaled down to fit this: enough to read, small enough to carry. */
const MAX_WIDTH = 1920; const MAX_HEIGHT = 1200;

/**
 * Captures the main display in a hidden window (screen-capture-preload.ts does the work), opened for one viewer and
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
      const primary = String(screen.getPrimaryDisplay().id);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((item) => item.display_id === primary) ?? sources[0];
      if (!source) throw new Error('No display was found.');
      const started = await new Promise<{ width?: number; height?: number; error?: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ error: 'The capture did not start.' }), 15000);
        window!.webContents.ipc.once('trace-capture-started', (_event, value) => { clearTimeout(timer); resolve(value); });
        window!.webContents.send('trace-capture-start', { sourceId: source.id, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT });
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
