import { ipcRenderer } from 'electron';

/**
 * The hidden window that captures this computer's displays (all of them, side by side as Windows arranges them) for a linked computer's viewer (screen-capture.ts).
 * It keeps the newest frame of the capture, and on request returns the parts that changed since the last request as
 * JPEG: the screen is compared in 64-pixel tiles, and each row's run of changed tiles is one picture.
 */
declare class MediaStreamTrackProcessor { constructor(init: { track: MediaStreamTrack }); readable: ReadableStream<VideoFrame> }
const TILE = 64; const QUALITY = 0.7;
/** Once the screen has been still this long, the parts last sent at QUALITY go again at SHARP, so text that stays put is crisp. */
const SETTLE_MS = 400; const SHARP = 0.95;
interface Part { sourceId: string; x: number; y: number; width: number; height: number }
/** One capture per display, each keeping its newest frame, drawn into its place in the one picture. */
let captures: { part: Part; track: MediaStreamTrack; latest: VideoFrame | null }[] = []; let previous: Uint32Array | null = null;
/** A frame has arrived since the last comparison; without one nothing can have changed, so nothing is read back. */
let fresh = false; let generation = 0;
/** A display's capture stopped by itself (unplugged, the session locked, the driver reset): the picture is stale from then on. */
let ended = false;
/** Tiles sent at QUALITY since their last sharp copy, and when a tile last changed. */
let blurred = new Set<number>(); let changedAt = 0;
let canvas: OffscreenCanvas | null = null; let context: OffscreenCanvasRenderingContext2D | null = null;

function stop() { generation++; ended = false; blurred = new Set(); changedAt = 0; for (const capture of captures) { capture.track.stop(); capture.latest?.close(); } captures = []; previous = null; canvas = null; context = null; }

async function open(part: Part, current: number) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: part.sourceId, maxWidth: part.width, maxHeight: part.height, maxFrameRate: 30 } } } as unknown as MediaStreamConstraints);
  const track = stream.getVideoTracks()[0]; const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const first = await reader.read(); if (first.done) { track.stop(); throw new Error('The capture ended at once.'); }
  const capture = { part, track, latest: first.value as VideoFrame | null };
  if (current !== generation) { track.stop(); first.value.close(); return; }
  captures.push(capture); fresh = true;
  // Keeps only the newest frame; each older one is closed so the capture does not stall.
  void (async () => { for (;;) { const next = await reader.read().catch(() => ({ done: true as const, value: undefined })); if (next.done || current !== generation) { next.value?.close(); if (current === generation) ended = true; return; } capture.latest?.close(); capture.latest = next.value; fresh = true; } })();
}

ipcRenderer.on('trace-capture-start', async (_event, request: { width: number; height: number; parts: Part[] }) => {
  stop(); const current = generation;
  try {
    const width = request.width & ~1; const height = request.height & ~1;
    canvas = new OffscreenCanvas(width, height); context = canvas.getContext('2d', { willReadFrequently: true });
    context!.fillStyle = '#000'; context!.fillRect(0, 0, width, height);
    // A display that cannot be captured stays black; only none at all is an error.
    const opened = await Promise.allSettled(request.parts.map((part) => open(part, current)));
    if (!captures.length) throw (opened.find((item) => item.status === 'rejected') as PromiseRejectedResult | undefined)?.reason ?? new Error('The screen could not be captured.');
    ipcRenderer.send('trace-capture-started', { width, height });
  } catch (error) { stop(); ipcRenderer.send('trace-capture-started', { error: (error as Error).message || 'The screen could not be captured.' }); }
});

ipcRenderer.on('trace-capture-frame', async (_event, request: { id: number; full: boolean }) => {
  try {
    if (!canvas || !context || !captures.length) throw new Error('Not capturing.');
    if (ended) throw new Error('The capture ended.');
    const { width, height } = canvas; const columns = Math.ceil(width / TILE);
    if (request.full || fresh) {
      fresh = false;
      for (const { part, latest } of captures) if (latest) context.drawImage(latest, part.x, part.y, part.width, part.height);
      const pixels = new Uint32Array(context.getImageData(0, 0, width, height).data.buffer); const before = request.full ? null : previous; previous = pixels;
      const changed = new Set<number>();
      for (let ty = 0, row = 0; ty < height; ty += TILE, row++) for (let tx = 0, column = 0; tx < width; tx += TILE, column++) {
        if (!before || tileChanged(pixels, before, width, tx, ty, Math.min(TILE, width - tx), Math.min(TILE, height - ty))) changed.add(row * columns + column);
      }
      if (changed.size) { for (const tile of changed) blurred.add(tile); changedAt = Date.now(); ipcRenderer.send('trace-capture-frame', { id: request.id, rects: await encode(tileRuns(changed, width, height), QUALITY) }); return; }
    }
    // Still for a moment: what went out blurred (fast, while it was changing) goes again sharp.
    if (blurred.size && Date.now() - changedAt >= SETTLE_MS) { const sharp = blurred; blurred = new Set(); ipcRenderer.send('trace-capture-frame', { id: request.id, rects: await encode(tileRuns(sharp, width, height), SHARP) }); return; }
    ipcRenderer.send('trace-capture-frame', { id: request.id, rects: [] });
  } catch (error) { ipcRenderer.send('trace-capture-frame', { id: request.id, error: (error as Error).message }); }
});

/** The picture's parts as JPEG, encoded side by side: the browser compresses each off this thread. */
async function encode(rects: { x: number; y: number; width: number; height: number }[], quality: number) {
  return Promise.all(rects.map(async (rect) => {
    const part = new OffscreenCanvas(rect.width, rect.height); part.getContext('2d')!.drawImage(canvas!, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return { ...rect, jpeg: new Uint8Array(await (await part.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer()) };
  }));
}

/**
 * Each row's runs of the given tiles (numbered across, then down), as rectangles. A run reaching the right edge ends
 * there, at the picture's width (which need not be a multiple of the tile size).
 */
export function tileRuns(tiles: Set<number>, width: number, height: number) {
  const columns = Math.ceil(width / TILE); const rects: { x: number; y: number; width: number; height: number }[] = [];
  for (let ty = 0, row = 0; ty < height; ty += TILE, row++) {
    const rows = Math.min(TILE, height - ty); let start = -1;
    for (let column = 0; column <= columns; column++) {
      const on = column < columns && tiles.has(row * columns + column);
      if (on && start < 0) start = column * TILE;
      if (!on && start >= 0) { rects.push({ x: start, y: ty, width: Math.min(column * TILE, width) - start, height: rows }); start = -1; }
    }
  }
  return rects;
}

ipcRenderer.on('trace-capture-stop', () => stop());

function tileChanged(now: Uint32Array, before: Uint32Array, width: number, x: number, y: number, columns: number, rows: number) {
  for (let row = y; row < y + rows; row++) { const offset = row * width; for (let column = x; column < x + columns; column++) if (now[offset + column] !== before[offset + column]) return true; }
  return false;
}
