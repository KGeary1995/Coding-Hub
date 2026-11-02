import { describe, expect, it } from 'vitest';
import { acceptKey, frame, FrameReader } from './websocket';

/** A client's frame, masked as browsers send them. */
function clientFrame(payload: Buffer, opcode = 0x2) {
  const mask = Buffer.from([1, 2, 3, 4]); const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index & 3]));
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, masked]);
}

describe('websocket', () => {
  it('answers the handshake as RFC 6455 says', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
  it('reads masked frames split anywhere, with long lengths, pings and close', () => {
    const reader = new FrameReader(); const long = Buffer.alloc(300, 7);
    const bytes = Buffer.concat([clientFrame(Buffer.from('RFB')), clientFrame(long), clientFrame(Buffer.from('hi'), 0x9), clientFrame(Buffer.alloc(0), 0x8)]);
    const events = [...reader.push(bytes.subarray(0, 5)), ...reader.push(bytes.subarray(5, 200)), ...reader.push(bytes.subarray(200))];
    expect(events).toEqual([{ type: 'data', data: Buffer.from('RFB') }, { type: 'data', data: long }, { type: 'ping', data: Buffer.from('hi') }, { type: 'close' }]);
  });
  it('refuses unmasked frames', () => {
    expect(() => new FrameReader().push(Buffer.from([0x82, 1, 0]))).toThrow();
  });
  it('writes unmasked frames of every length form', () => {
    expect(frame(Buffer.from('ab'))).toEqual(Buffer.from([0x82, 2, 97, 98]));
    expect(frame(Buffer.alloc(200)).subarray(0, 4)).toEqual(Buffer.from([0x82, 126, 0, 200]));
    expect(frame(Buffer.alloc(70000)).subarray(0, 2)).toEqual(Buffer.from([0x82, 127]));
  });
});
