import { createHash } from 'node:crypto';

/**
 * The little of WebSocket (RFC 6455) the phone's screen needs: the handshake, and frames carrying a byte stream. A
 * browser can only stream both ways over a WebSocket, and noVNC drives one; the payloads are VNC bytes, so message
 * boundaries do not matter and every data frame's payload is passed on as it arrives.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** No VNC message comes near this; a larger frame is not a viewer's. */
const MAX_FRAME = 16 * 1024 * 1024;

export const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

/** A server's frame: never masked. Binary data, or a pong, or a close. */
export function frame(payload: Buffer, opcode = 0x2) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([head, payload]);
}

export type FrameEvent = { type: 'data'; data: Buffer } | { type: 'ping'; data: Buffer } | { type: 'close' };

/** Reads a client's frames from the bytes as they arrive. Clients must mask; an unmasked or oversized frame is an error. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): FrameEvent[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events: FrameEvent[] = [];
    for (;;) {
      if (this.buffer.length < 2) return events;
      const opcode = this.buffer[0] & 0x0f; const masked = (this.buffer[1] & 0x80) !== 0; let length = this.buffer[1] & 0x7f; let offset = 2;
      if (!masked) throw new Error('An unmasked frame from a client.');
      if (length === 126) { if (this.buffer.length < 4) return events; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return events; const size = this.buffer.readBigUInt64BE(2); if (size > BigInt(MAX_FRAME)) throw new Error('A frame too large.'); length = Number(size); offset = 10; }
      if (length > MAX_FRAME) throw new Error('A frame too large.');
      if (this.buffer.length < offset + 4 + length) return events;
      const mask = this.buffer.subarray(offset, offset + 4); const data = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < data.length; index++) data[index] ^= mask[index & 3];
      this.buffer = this.buffer.subarray(offset + 4 + length);
      // Text, binary and their continuations all carry stream bytes; pongs are ignored.
      if (opcode === 0x8) { events.push({ type: 'close' }); return events; }
      if (opcode === 0x9) events.push({ type: 'ping', data });
      else if (opcode <= 0x2) events.push({ type: 'data', data });
    }
  }
}
