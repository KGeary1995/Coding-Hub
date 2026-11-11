import type { Duplex } from 'node:stream';
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { SCREEN_CLIPBOARD_LIMIT } from '../../../shared/screen';

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
  /** The viewer's copied text, for this computer's clipboard. It may finish later (Electron's write does): a paste waits for it. */
  clipboard(text: string): void | Promise<void>;
}
const TIGHT = 7; const CONTINUOUS = -313; const CLIPBOARD_LIMIT = SCREEN_CLIPBOARD_LIMIT;
/** How often an unchanged screen is looked at again; cheap, as the capture skips frames it has already compared. */
const IDLE_POLL = 15;
/** Updates wait while this much is still unsent, so the viewer sees the newest screen rather than a queue of old ones. */
const SEND_LIMIT = 64 * 1024;
/**
 * The local socket says nothing about the link beyond it (`tailscale serve`, then the network): a slow link fills up
 * further on, and the viewer falls behind. A viewer that takes fences (noVNC does) answers each one only after drawing
 * everything sent before it, so at most this many updates are on their way at once, and a slow link gets fewer,
 * newer pictures rather than a queue of old ones.
 */
const FENCE = -312; export const IN_FLIGHT = 2;
const FENCE_REQUEST = 0x80000000; const FENCE_BLOCKS = 0b11;

/** Tight's "compact" length: 7 bits per byte, at most three bytes. */
export function compactLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length & 0x7f) | 0x80, length >> 7]);
  return Buffer.from([(length & 0x7f) | 0x80, ((length >> 7) & 0x7f) | 0x80, length >> 14]);
}
/** Classic VNC clipboard text is Latin-1; anything outside it becomes "?". */
const latin1 = (text: string) => Buffer.from(text.replace(/[^\x00-\xff]/g, '?'), 'latin1');
/**
 * The extended clipboard (as noVNC's core/rfb.js speaks it): UTF-8 text, so quotes, dashes and emoji arrive intact. A
 * clipboard message with a negative length carries flags (actions in the top byte, formats in the low bits); one side
 * says it has text (Notify), the other asks for it (Request), and it comes back deflated (Provide).
 */
const EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0; const TEXT = 1;
const CAPS = 1 << 24; const REQUEST = 1 << 25; const PEEK = 1 << 26; const NOTIFY = 1 << 27; const PROVIDE = 1 << 28;
/** How long keys and clicks wait for text the viewer said it copied (Notify) to arrive (Provide), then go anyway: long enough for the round trip over a slow relayed link, since a paste let go early pastes the old text. */
export const PASTE_WAIT = 5000;
/**
 * Text for the extended clipboard: CRLF line endings, UTF-8, ending in a NUL, at most `limit` bytes in all (the limit is
 * on what is sent, not on characters, which take up to four bytes each); cut at a character boundary.
 */
export function clipboardBytes(text: string, limit = CLIPBOARD_LIMIT): Buffer {
  let utf8 = Buffer.from(text.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8');
  if (utf8.length > limit - 1) { let end = limit - 1; while (end > 0 && (utf8[end] & 0xc0) === 0x80) end--; utf8 = utf8.subarray(0, end); }
  return Buffer.concat([utf8, Buffer.from([0])]);
}
/** Two clipboard texts that differ only in their line ends (CRLF, CR or LF). */
const sameText = (a: string, b: string) => a === b || a.replace(/\r\n|\r/g, '\n') === b.replace(/\r\n|\r/g, '\n');
const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value >>> 0, 0); return buffer; };

/**
 * One viewer of this computer's screen, speaking VNC (RFB 3.8). The connection reaching here is already authenticated
 * (a linked computer's key, checked by the remote), so VNC's own security is "None". Updates are pushed as the
 * screen changes (VNC's continuous updates, which noVNC takes up) rather than one per request, so a change costs one
 * trip across the network, not two; sending waits while the connection is backed up.
 */
export class RfbSession {
  private buffer: Buffer = Buffer.alloc(0); private stage: 'version' | 'security' | 'init' | 'messages' = 'version';
  private encodings = new Set<number>(); private request: { incremental: boolean } | null = null; private pumping = false;
  private continuous = false; private offered = false;
  private closed = false; private clipboardTimer: ReturnType<typeof setInterval> | null = null; private lastClipboard: string | null = null;
  /** The extended clipboard: whether this side offered it, whether the viewer took it up (its own Caps), and the text copied here that the viewer was told about. */
  private extendedOffered = false; private extended = false; private offer: string | null = null;
  /**
   * Keys and clicks that came after the viewer said it copied text (Notify), held until the text itself arrives (Provide):
   * a paste (Ctrl+V right after the text) would otherwise reach this computer before its clipboard has the new text.
   */
  private held: (() => void)[] | null = null; private heldTimer: ReturnType<typeof setTimeout> | null = null;
  /** Text Requests sent and not yet answered with text; when input was first held; a hold never lasts past twice PASTE_WAIT. */
  private awaiting = 0; private heldSince = 0;
  /** Clipboard writes still under way: a paste waits for the text to be on the clipboard. */
  private writing = 0;
  /** Updates sent and not yet answered by the viewer's fence, and the pump waiting for one. */
  private inFlight = 0; private fenced: (() => void) | null = null; private fenceId = 0;

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
    if (this.heldTimer) clearTimeout(this.heldTimer); this.heldTimer = null; this.held = null;
    this.fenced?.(); this.fenced = null;
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
        // Our Caps: text up to the limit, and the actions this side answers; the viewer replies with its own.
        if (!this.extendedOffered && this.encodings.has(EXTENDED_CLIPBOARD)) { this.extendedOffered = true; this.writeExtended(CAPS | REQUEST | PEEK | NOTIFY | PROVIDE | TEXT, u32(CLIPBOARD_LIMIT)); }
        continue;
      }
      if (type === 3) {
        if (this.buffer.length < 10) return; const message = this.take(10); this.request = { incremental: message[1] === 1 && (this.request?.incremental ?? true) };
        // Offered once (EndOfContinuousUpdates); the viewer answers with EnableContinuousUpdates and stops asking.
        if (!this.offered && this.encodings.has(CONTINUOUS)) { this.offered = true; this.socket.write(Buffer.from([150])); }
        void this.pump(); continue;
      }
      if (type === 150) {
        if (this.buffer.length < 10) return; this.continuous = this.take(10)[1] === 1;
        // Turned off, the viewer asks again for each update; the protocol wants this message to confirm it.
        if (!this.continuous) this.socket.write(Buffer.from([150]));
        void this.pump(); continue;
      }
      if (type === 4) { if (this.buffer.length < 8) return; const message = this.take(8); this.act(() => this.input.key(message.readUInt32BE(4), message[1] === 1)); continue; }
      if (type === 5) {
        if (this.buffer.length < 6) return; const message = this.take(6);
        const x = Math.min(message.readUInt16BE(2), this.source.width - 1); const y = Math.min(message.readUInt16BE(4), this.source.height - 1); const buttons = message[1];
        this.act(() => this.input.pointer(x, y, buttons));
        continue;
      }
      if (type === 6) {
        // A negative length is an extended clipboard message.
        if (this.buffer.length < 8) return; const signed = this.buffer.readInt32BE(4); const length = Math.abs(signed); if (length > CLIPBOARD_LIMIT) throw new Error('clipboard');
        if (this.buffer.length < 8 + length) return;
        const body = this.take(8 + length).subarray(8);
        if (signed >= 0) this.copied(body.toString('latin1')); else this.extendedClipboard(body);
        continue;
      }
      if (type === 248) {
        // ClientFence: the answer to one of ours (the viewer has drawn what came before it), or a request to answer.
        if (this.buffer.length < 9) return; const length = this.buffer[8]; if (length > 64) throw new Error('fence'); if (this.buffer.length < 9 + length) return;
        const message = this.take(9 + length); const flags = message.readUInt32BE(4);
        if (flags & FENCE_REQUEST) this.socket.write(this.fence(flags & FENCE_BLOCKS, message.subarray(9)));
        else { this.inFlight = Math.max(0, this.inFlight - 1); const go = this.fenced; this.fenced = null; go?.(); }
        continue;
      }
      throw new Error('message ' + type);
    }
  }

  /**
   * Text copied on the viewer's computer, for this one's clipboard (and not sent back as a change made here). The keys and
   * clicks that came after it (a paste) are held until the write has finished, done or failed: Electron's write finishes
   * later, and a V let go before it pastes the old text. PASTE_WAIT stays the limit. Should the viewer have said it copied
   * something newer meanwhile (another Notify), that text's arrival lets them go instead.
   */
  private copied(text: string) {
    this.lastClipboard = text; const written = this.input.clipboard(text);
    if (!(written instanceof Promise)) { this.settle(); return; }
    this.writing++; this.hold();
    void written.then(() => {}, () => {}).then(() => { this.writing--; if (!this.closed) this.settle(); });
  }
  /**
   * A reply from the viewer lets held input go only once nothing it waits on is left: no text this side asked for is still to
   * come, and no clipboard write is still under way. (PASTE_WAIT, through hold(), stays the limit.)
   */
  private settle() { if (this.awaiting === 0 && this.writing === 0) this.release(); }
  /** Input now, or after the text the viewer copied, in the order it came. */
  private act(action: () => void) { if (this.held) this.held.push(action); else action(); }
  /**
   * Holds input, or keeps holding it: each new wait (another copy announced, a write under way) gets PASTE_WAIT again, but
   * the hold ends at most twice PASTE_WAIT after it began, so a viewer that keeps announcing text cannot hold input forever.
   */
  private hold() {
    if (!this.held) { this.held = []; this.heldSince = Date.now(); }
    if (this.heldTimer) clearTimeout(this.heldTimer);
    const wait = Math.max(0, Math.min(PASTE_WAIT, this.heldSince + 2 * PASTE_WAIT - Date.now()));
    this.heldTimer = setTimeout(() => { this.awaiting = 0; this.release(); }, wait);
  }
  private release() { const actions = this.held ?? []; this.held = null; if (this.heldTimer) clearTimeout(this.heldTimer); this.heldTimer = null; for (const action of actions) action(); }

  private extendedClipboard(body: Buffer) {
    if (body.length < 4) throw new Error('clipboard'); const flags = body.readUInt32BE(0); const text = (flags & TEXT) !== 0;
    if (flags & CAPS) { this.extended = true; return; }
    if (flags & PROVIDE) {
      // No text in it: held input goes only if no text this side asked for is still to come.
      if (!text) { this.settle(); return; }
      this.awaiting = Math.max(0, this.awaiting - 1);
      // noVNC flushes without finishing its stream; the size limit applies to the text inflated, not just what was sent.
      const data = inflateSync(body.subarray(4), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: CLIPBOARD_LIMIT + 5 });
      if (data.length < 4) throw new Error('clipboard'); const size = data.readUInt32BE(0); if (size > data.length - 4) throw new Error('clipboard');
      // On the clipboard; what was held behind it goes once the write has finished (copied).
      const value = data.subarray(4, 4 + size).toString('utf8'); this.copied(value.endsWith('\0') ? value.slice(0, -1) : value);
      return;
    }
    if (flags & NOTIFY) { if (text) { this.awaiting++; this.hold(); this.writeExtended(REQUEST | TEXT); } return; }
    if (flags & REQUEST) {
      if (!text || this.offer === null) return;
      // The size, then the text (CRLF, NUL, within the limit in bytes), all deflated.
      const utf8 = clipboardBytes(this.offer);
      this.writeExtended(PROVIDE | TEXT, deflateSync(Buffer.concat([u32(utf8.length), utf8])));
      return;
    }
    if (flags & PEEK) this.writeExtended(NOTIFY | (this.offer !== null ? TEXT : 0));
  }
  private writeExtended(flags: number, payload: Buffer = Buffer.alloc(0)) {
    const header = Buffer.alloc(8); header[0] = 3; header.writeInt32BE(-(4 + payload.length), 4);
    this.socket.write(Buffer.concat([header, u32(flags), payload]));
  }

  /** ServerFence: flags, then up to 64 bytes the viewer sends back unchanged. */
  private fence(flags: number, payload: Buffer) { const header = Buffer.alloc(9); header[0] = 248; header.writeUInt32BE(flags >>> 0, 4); header[8] = payload.length; return Buffer.concat([header, payload]); }

  private take(length: number) { const part = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return part; }

  /** Sends what changed, while the viewer has asked for an update or takes them continuously; waits while nothing has. */
  private async pump() {
    if (this.pumping) return; this.pumping = true;
    try {
      while ((this.request || this.continuous) && !this.closed) {
        // Only Tight carries JPEG; every viewer Trace ships (noVNC) asks for it.
        if (!this.encodings.has(TIGHT)) { this.close(); return; }
        if (this.socket.writableLength > SEND_LIMIT) { await new Promise((resolve) => { this.socket.once('drain', resolve); this.socket.once('close', resolve); }); continue; }
        if (this.encodings.has(FENCE) && this.inFlight >= IN_FLIGHT) { await new Promise<void>((resolve) => { this.fenced = resolve; }); continue; }
        const full = this.request ? !this.request.incremental : false; const rects = await this.source.frame(full);
        if (this.closed) return;
        if (!rects.length) { await new Promise((resolve) => setTimeout(resolve, IDLE_POLL)); continue; }
        this.request = null;
        const parts: Buffer[] = [Buffer.from([0, 0, rects.length >> 8, rects.length & 0xff])];
        for (const rect of rects) {
          const header = Buffer.alloc(12); header.writeUInt16BE(rect.x, 0); header.writeUInt16BE(rect.y, 2); header.writeUInt16BE(rect.width, 4); header.writeUInt16BE(rect.height, 6); header.writeInt32BE(TIGHT, 8);
          parts.push(header, Buffer.from([0x90]), compactLength(rect.jpeg.byteLength), Buffer.from(rect.jpeg.buffer, rect.jpeg.byteOffset, rect.jpeg.byteLength));
        }
        // A fence after each update: its answer says the viewer has drawn it.
        if (this.encodings.has(FENCE)) { parts.push(this.fence(FENCE_REQUEST, Buffer.from([++this.fenceId & 0xff]))); this.inFlight++; }
        this.socket.write(Buffer.concat(parts));
      }
    // A capture that fails (stopped, ended, the displays changed) ends the session, so the viewer connects again to a
    // fresh one; carrying on would leave the last picture up with nothing more sent.
    } catch { this.close(); } finally { this.pumping = false; }
  }

  /** Text copied here reaches the viewer's clipboard; what is there when the viewer connects stays here. */
  private async syncClipboard() {
    if (this.closed || !this.readClipboard) return;
    const text = (await this.readClipboard().catch(() => '')).slice(0, CLIPBOARD_LIMIT);
    if (this.lastClipboard === null) { this.lastClipboard = text; return; }
    // The same text with other line ends (pasted here as CRLF, read back as LF) is not a new copy to send back.
    if (sameText(text, this.lastClipboard) || this.closed) return; this.lastClipboard = text;
    // A viewer with the extended clipboard is told there is text, and asks for it (Request, answered above).
    if (this.extended) { this.offer = text; this.writeExtended(NOTIFY | TEXT); return; }
    const body = latin1(text); const header = Buffer.alloc(8); header[0] = 3; header.writeUInt32BE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }
}
