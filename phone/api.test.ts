import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionProblem, follow, INPUT_TIMEOUT, revive, send } from './api';

describe('why the phone app cannot connect', () => {
  const host = 'macbook.tail0000.ts.net';
  it('names the computer and its address, and tells a closed Trace from a computer that cannot be reached', () => {
    expect(connectionProblem(Object.assign(new Error('Bad Gateway'), { status: 502 }), 'MacBook', host)).toBe('MacBook (macbook.tail0000.ts.net) is on, but Trace is not open there. Open Trace on that computer, or add this app again from the computer you want.');
    expect(connectionProblem(new TypeError('Failed to fetch'), 'MacBook', host)).toBe('MacBook (macbook.tail0000.ts.net) can’t be reached. Check that it is on, and that Tailscale is connected on this phone.');
    // The six-second connecting limit ends as an abort, with no status either.
    expect(connectionProblem(new DOMException('Aborted', 'AbortError'), null, host)).toBe('macbook.tail0000.ts.net can’t be reached. Check that it is on, and that Tailscale is connected on this phone.');
    expect(connectionProblem(Object.assign(new Error('Unknown host.'), { status: 421 }), null, host)).toBe('macbook.tail0000.ts.net did not accept this phone: Unknown host.');
  });
});

describe('the phone talking to its computer', () => {
  beforeEach(() => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } });
    vi.stubGlobal('location', { host: 'pc.tail0000.ts.net' });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const until = async (check: () => boolean, what: string, tries = 100) => { for (let i = 0; i < tries && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };

  it('gives up on a key the computer does not take in time, and does not send the keys typed behind it late', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const data = (JSON.parse(String(init.body)) as { data: string }).data; sent.push(data);
      // The network stalls on the first key: the request neither answers nor fails.
      if (data === 'y') return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
      return Promise.resolve(new Response('{}'));
    });
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms); return controller.signal; });
    const results = Promise.allSettled([send('s', 'r', 'y'), send('s', 'r', '\r')]);
    await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT);
    const [first, second] = await results;
    expect(first).toMatchObject({ status: 'rejected', reason: { message: 'The computer did not answer within 8 seconds. Check the channel before typing again: that may not have arrived.' } });
    expect(second).toMatchObject({ status: 'rejected', reason: { message: 'Not sent, because what was typed before it did not get through. Check the channel, then type it again.' } });
    expect(sent).toEqual(['y']);
    // Typed after the failure was shown: sent as usual.
    await send('s', 'r', 'n'); expect(sent).toEqual(['y', 'n']);
  });

  it('skips an event the page cannot handle, and replaces a stream gone quiet while the phone slept at once', async () => {
    let opened = 0; const encoder = new TextEncoder();
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      opened++;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('event: me\ndata: {"n":1}\n\nevent: me\ndata: {"n":2}\n\n'));
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      } })));
    });
    const seen: number[] = []; const states: boolean[] = [];
    const stop = follow(null, (event) => { const n = (event.data as unknown as { n: number }).n; seen.push(n); if (n === 1) throw new Error('A bug in the page.'); }, (connected) => states.push(connected), () => {});
    try {
      await until(() => seen.length === 2, 'both events');
      expect(seen).toEqual([1, 2]); expect(opened).toBe(1); expect(states).toEqual([true]);
      // Heard from just now: kept.
      revive(); await new Promise((resolve) => setTimeout(resolve, 30)); expect(opened).toBe(1);
      // Silent for longer than allowed: replaced without the usual two-second wait.
      revive(5); await until(() => opened === 2, 'the new stream', 50);
      expect(states).toEqual([true, false, true]);
    } finally { stop(); }
  });
});
