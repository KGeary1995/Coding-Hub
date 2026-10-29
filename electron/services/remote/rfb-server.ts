import type { Duplex } from 'node:stream';

/** A changed part of the screen, as JPEG (sent with Tight encoding, which noVNC draws natively). */
export interface FrameRect { x: number; y: number; width: number; height: number; jpeg: Uint8Array }
export interface ScreenSource {
  width: number; height: number;
  /** The parts that changed since the last call, or all of it (`full`). Empty when nothing changed. */
  frame(full: boolean): Promise<FrameRect[]>;
}
export interface ScreenInput {
  /** `x`, `y` in screen pixels; `buttons` is the VNC mask (1 left, 2 middle, 4 right, 8/16 wheel up/down, 32/64 left/right). */
  pointer(x: number, y: number, buttons: number): void;
  key(keysym: number, down: boolean): void;
  /** The viewer's copied text, for this computer's clipboard. */
  clipboard(text: string): void;
}
const TIGHT = 7; const IDLE_POLL = 100; const CLIPBOARD_LIMIT = 1024 * 1024;

/** Tight's "compact" length: 7 bits per byte, at most three bytes. */
export function compactLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length & 0x7f) | 0x80, length >> 7]);
  return Buffer.from([(length & 0x7f) | 0x80, ((length >> 7) & 0x7f) | 0x80, length >> 14]);
}
/** Classic VNC clipboard text is Latin-1; anything outside it becomes "?". */
const latin1 = (text: string) => Buffer.from(text.replace(/[^\x00-\xff]/g, '?'), 'latin1');

/**
 * One viewer of this computer's screen, speaking VNC (RFB 3.8). The connection reaching here is already authenticated
 * (a linked computer's key, checked by the remote), so VNC's own security is "None". The viewer asks for each update,
 * so the frame rate follows what the connection carries.
 */
export class RfbSession {
  private buffer: Buffer = Buffer.alloc(0); private stage: 'version' | 'security' | 'init' | 'messages' = 'version';
  private encodings = new Set<number>(); private request: { incremental: boolean } | null = null; private pumping = false;
  private closed = false; private clipboardTimer: ReturnType<typeof setInterval> | null = null; private lastClipboard: string | null = null;

  constructor(private socket: Duplex, private source: ScreenSource, private input: ScreenInput, private name: string, private ended: () => void, private readClipboard?: () => Promise<string>) {
    socket.on('data', (data: Buffer) => { try { this.receive(data); } catch { this.close(); } });
    // The HTTP server keeps upgraded sockets half-open, so the viewer hanging up ends the session here too.
    socket.on('close', () => this.finish()); socket.on('error', () => this.finish()); socket.on('end', () => this.close());
    socket.write('RFB 003.008\n');
  }

  close() { if (!this.closed) this.socket.destroy(); this.finish(); }

  private finish() {
    if (this.closed) return; this.closed = true;
    if (this.clipboardTimer) clearInterval(this.clipboardTimer); this.clipboardTimer = null;
    this.ended();
  }

  private receive(data: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    for (;;) {
      if (this.stage === 'version') {
        if (this.buffer.length < 12) return;
        if (!/^RFB 003\.00[78]\n$/.test(this.buffer.subarray(0, 12).toString('latin1'))) throw new Error('version');
        this.take(12); this.socket.write(Buffer.from([1, 1])); this.stage = 'security'; continue;
      }
      if (this.stage === 'security') {
        if (this.buffer.length < 1) return;
        if (this.take(1)[0] !== 1) throw new Error('security');
        this.socket.write(Buffer.alloc(4)); this.stage = 'init'; continue;
      }
      if (this.stage === 'init') {
        if (this.buffer.length < 1) return; this.take(1);
        const name = Buffer.from(this.name, 'utf8'); const init = Buffer.alloc(24);
        init.writeUInt16BE(this.source.width, 0); init.writeUInt16BE(this.source.height, 2);
        // 32 bits per pixel, depth 24, little-endian, true colour, 8 bits each: what noVNC uses (JPEG ignores it).
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4); init.writeUInt32BE(name.length, 20);
        this.socket.write(Buffer.concat([init, name])); this.stage = 'messages';
        if (this.readClipboard) this.clipboardTimer = setInterval(() => void this.syncClipboard(), 1000);
        continue;
      }
      if (!this.buffer.length) return;
      const type = this.buffer[0];
      if (type === 0) { if (this.buffer.length < 20) return; this.take(20); continue; } // SetPixelFormat: JPEG needs none
      if (type === 2) {
        if (this.buffer.length < 4) return; const count = this.buffer.readUInt16BE(2); if (this.buffer.length < 4 + 4 * count) return;
        const message = this.take(4 + 4 * count); this.encodings = new Set(Array.from({ length: count }, (_, index) => message.readInt32BE(4 + 4 * index)));
        continue;
      }
      if (type === 3) { if (this.buffer.length < 10) return; const message = this.take(10); this.request = { incremental: message[1] === 1 && (this.request?.incremental ?? true) }; void this.pump(); continue; }
      if (type === 4) { if (this.buffer.length < 8) return; const message = this.take(8); this.input.key(message.readUInt32BE(4), message[1] === 1); continue; }
      if (type === 5) {
        if (this.buffer.length < 6) return; const message = this.take(6);
        this.input.pointer(Math.min(message.readUInt16BE(2), this.source.width - 1), Math.min(message.readUInt16BE(4), this.source.height - 1), message[1]);
        continue;
      }
      if (type === 6) {
        if (this.buffer.length < 8) return; const length = this.buffer.readUInt32BE(4); if (length > CLIPBOARD_LIMIT) throw new Error('clipboard');
        if (this.buffer.length < 8 + length) return;
        const text = this.take(8 + length).subarray(8).toString('latin1'); this.lastClipboard = text; this.input.clipboard(text);
        continue;
      }
      throw new Error('message ' + type);
    }
  }

  private take(length: number) { const part = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return part; }

  /** Answers the viewer's request with what changed, waiting while nothing has. */
  private async pump() {
    if (this.pumping) return; this.pumping = true;
    try {
      while (this.request && !this.closed) {
        // Only Tight carries JPEG; every viewer Trace ships (noVNC) asks for it.
        if (!this.encodings.has(TIGHT)) { this.close(); return; }
        const full = !this.request.incremental; const rects = await this.source.frame(full);
        if (this.closed) return;
        if (!rects.length) { await new Promise((resolve) => setTimeout(resolve, IDLE_POLL)); continue; }
        this.request = null;
        const parts: Buffer[] = [Buffer.from([0, 0, rects.length >> 8, rects.length & 0xff])];
        for (const rect of rects) {
          const header = Buffer.alloc(12); header.writeUInt16BE(rect.x, 0); header.writeUInt16BE(rect.y, 2); header.writeUInt16BE(rect.width, 4); header.writeUInt16BE(rect.height, 6); header.writeInt32BE(TIGHT, 8);
          parts.push(header, Buffer.from([0x90]), compactLength(rect.jpeg.byteLength), Buffer.from(rect.jpeg.buffer, rect.jpeg.byteOffset, rect.jpeg.byteLength));
        }
        if (!this.socket.write(Buffer.concat(parts))) await new Promise((resolve) => { this.socket.once('drain', resolve); this.socket.once('close', resolve); });
      }
    } finally { this.pumping = false; }
  }

  /** Text copied here reaches the viewer's clipboard; what is there when the viewer connects stays here. */
  private async syncClipboard() {
    if (this.closed || !this.readClipboard) return;
    const text = (await this.readClipboard().catch(() => '')).slice(0, CLIPBOARD_LIMIT);
    if (this.lastClipboard === null) { this.lastClipboard = text; return; }
    if (text === this.lastClipboard || this.closed) return; this.lastClipboard = text;
    const body = latin1(text); const header = Buffer.alloc(8); header[0] = 3; header.writeUInt32BE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }
}
