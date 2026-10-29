import { ipcRenderer } from 'electron';

/**
 * The hidden window that captures this computer's main display for a linked computer's viewer (screen-capture.ts).
 * It keeps the newest frame of the capture, and on request returns the parts that changed since the last request as
 * JPEG: the screen is compared in 64-pixel tiles, and each row's run of changed tiles is one picture.
 */
declare class MediaStreamTrackProcessor { constructor(init: { track: MediaStreamTrack }); readable: ReadableStream<VideoFrame> }
const TILE = 64; const QUALITY = 0.7;
let track: MediaStreamTrack | null = null; let latest: VideoFrame | null = null; let previous: Uint32Array | null = null;
let canvas: OffscreenCanvas | null = null; let context: OffscreenCanvasRenderingContext2D | null = null;

function stop() { track?.stop(); track = null; latest?.close(); latest = null; previous = null; canvas = null; context = null; }

ipcRenderer.on('trace-capture-start', async (_event, request: { sourceId: string; maxWidth: number; maxHeight: number }) => {
  stop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: request.sourceId, maxWidth: request.maxWidth, maxHeight: request.maxHeight, maxFrameRate: 15 } } } as unknown as MediaStreamConstraints);
    const current = stream.getVideoTracks()[0]; track = current;
    const reader = new MediaStreamTrackProcessor({ track: current }).readable.getReader();
    const first = await reader.read(); if (first.done) throw new Error('The capture ended at once.');
    latest = first.value; const width = latest.displayWidth & ~1; const height = latest.displayHeight & ~1;
    canvas = new OffscreenCanvas(width, height); context = canvas.getContext('2d', { willReadFrequently: true });
    // Keeps only the newest frame; each older one is closed so the capture does not stall.
    void (async () => { for (;;) { const next = await reader.read().catch(() => ({ done: true as const, value: undefined })); if (next.done || track !== current) { next.value?.close(); return; } latest?.close(); latest = next.value; } })();
    ipcRenderer.send('trace-capture-started', { width, height });
  } catch (error) { stop(); ipcRenderer.send('trace-capture-started', { error: (error as Error).message || 'The screen could not be captured.' }); }
});

ipcRenderer.on('trace-capture-frame', async (_event, request: { id: number; full: boolean }) => {
  try {
    if (!canvas || !context || !latest) throw new Error('Not capturing.');
    const { width, height } = canvas; context.drawImage(latest, 0, 0, width, height);
    const pixels = new Uint32Array(context.getImageData(0, 0, width, height).data.buffer); const before = request.full ? null : previous; previous = pixels;
    const rects: { x: number; y: number; width: number; height: number; jpeg: Uint8Array }[] = [];
    for (let ty = 0; ty < height; ty += TILE) {
      const rows = Math.min(TILE, height - ty); let start = -1;
      for (let tx = 0; tx <= width; tx += TILE) {
        const changed = tx < width && (!before || tileChanged(pixels, before, width, tx, ty, Math.min(TILE, width - tx), rows));
        if (changed && start < 0) start = tx;
        if (!changed && start >= 0) { rects.push({ x: start, y: ty, width: tx - start, height: rows, jpeg: new Uint8Array() }); start = -1; }
      }
    }
    for (const rect of rects) {
      const part = new OffscreenCanvas(rect.width, rect.height); part.getContext('2d')!.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      rect.jpeg = new Uint8Array(await (await part.convertToBlob({ type: 'image/jpeg', quality: QUALITY })).arrayBuffer());
    }
    ipcRenderer.send('trace-capture-frame', { id: request.id, rects });
  } catch (error) { ipcRenderer.send('trace-capture-frame', { id: request.id, error: (error as Error).message }); }
});

ipcRenderer.on('trace-capture-stop', () => stop());

function tileChanged(now: Uint32Array, before: Uint32Array, width: number, x: number, y: number, columns: number, rows: number) {
  for (let row = y; row < y + rows; row++) { const offset = row * width; for (let column = x; column < x + columns; column++) if (now[offset + column] !== before[offset + column]) return true; }
  return false;
}
