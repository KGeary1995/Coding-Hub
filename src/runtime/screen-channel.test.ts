import { afterEach, describe, expect, it } from 'vitest';
import type { ScreenEvent, ScreenRequest } from '../../shared/screen';

// The renderer has CloseEvent; Node 22 does not.
if (!('CloseEvent' in globalThis)) (globalThis as Record<string, unknown>).CloseEvent = class extends Event { code: number; reason: string; wasClean: boolean; constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) { super(type); this.code = init.code ?? 0; this.reason = init.reason ?? ''; this.wasClean = init.wasClean ?? false; } };

/** A host whose answer to open waits, so the server's first bytes can arrive before it (as they do). */
function host() {
  const requests: ScreenRequest[] = []; let listener: ((event: ScreenEvent) => void) | null = null; let answerOpen: (ok: boolean) => void = () => {};
  (globalThis as Record<string, unknown>).window = { codingHub: {
    onScreenEvent: (next: (event: ScreenEvent) => void) => { listener = next; return () => {}; },
    screen: (request: ScreenRequest) => { requests.push(request); return request.action === 'screen-open' ? new Promise((resolve) => { answerOpen = (ok) => resolve(ok ? { ok: true, value: null } : { ok: false, error: { code: 'SCREEN_CONNECT', message: 'Screen Sharing is off on Mac.' } }); }) : Promise.resolve({ ok: true, value: null }); },
  } };
  return { requests, emit: (event: ScreenEvent) => listener?.(event), answerOpen: (ok = true) => answerOpen(ok) };
}
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a linked screen as noVNC sees it', async () => {
  const { ScreenChannel } = await import('./screen-channel');

  it('has every property noVNC checks a raw channel for', () => {
    host(); const channel = new ScreenChannel('mac');
    const names = [...Object.keys(channel), ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel))];
    for (const prop of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState']) expect(names).toContain(prop);
  });

  it('opens before delivering bytes the server sent first, and copies what it sends', async () => {
    const fake = host(); const channel = new ScreenChannel('mac'); const seen: string[] = [];
    channel.onopen = () => seen.push('open'); channel.onmessage = (event) => seen.push(new TextDecoder().decode(event.data as ArrayBuffer));
    const open = fake.requests[0] as Extract<ScreenRequest, { action: 'screen-open' }>;
    fake.emit({ type: 'data', streamId: open.streamId, data: new TextEncoder().encode('RFB 003.889\n') });
    expect(seen).toEqual([]);
    fake.answerOpen(); await flush();
    expect(seen).toEqual(['open', 'RFB 003.889\n']); expect(channel.readyState).toBe('open');
    const buffer = new Uint8Array([1, 2, 3]); channel.send(buffer); buffer[0] = 9;
    expect((fake.requests[1] as Extract<ScreenRequest, { action: 'screen-send' }>).data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('closes with the reason the host gave', async () => {
    const fake = host(); const channel = new ScreenChannel('mac'); let closed: CloseEvent | null = null; let failed = false;
    channel.onclose = (event) => { closed = event; }; channel.onerror = () => { failed = true; };
    fake.answerOpen(false); await flush();
    expect(channel.readyState).toBe('closed'); expect(channel.error).toBe('Screen Sharing is off on Mac.'); expect(failed).toBe(true); expect(closed!.wasClean).toBe(false);
  });

  it('a close the window asks for ends cleanly once the host confirms', async () => {
    const fake = host(); const channel = new ScreenChannel('mac'); let closed: CloseEvent | null = null; channel.onclose = (event) => { closed = event; };
    fake.answerOpen(); await flush();
    channel.close(); expect(fake.requests.at(-1)).toMatchObject({ action: 'screen-close' }); expect(channel.readyState).toBe('closing');
    fake.emit({ type: 'closed', streamId: (fake.requests[0] as { streamId: string }).streamId });
    expect(channel.readyState).toBe('closed'); expect(closed!.wasClean).toBe(true); expect(channel.error).toBeNull();
  });
});
