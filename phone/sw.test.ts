import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://pc.tail0000.ts.net';
interface Page { method: string; url: string; mode: string }
const PAGE: Page = { method: 'GET', url: ORIGIN + '/', mode: 'navigate' };
const asset = (name: string): Page => ({ method: 'GET', url: `${ORIGIN}/assets/${name}`, mode: 'no-cors' });
const page = (...files: string[]) => `<html>${files.map((file) => `<script type="module" src="/assets/${file}"></script>`).join('')}</html>`;

/** The service worker in a stand-in worker scope, with the network and its saved copies (by path) under the test's control. */
function worker(network: (request: Page | string) => Promise<Response>, saved: Record<string, string> | Map<string, Response> = {}) {
  const store = saved instanceof Map ? saved : new Map(Object.entries(saved).map(([key, body]) => [key, new Response(body)]));
  const name = (key: string | Page) => typeof key === 'string' ? key : new URL(key.url).pathname;
  const cache = {
    match: async (key: string | Page) => store.get(name(key))?.clone(), put: async (key: string | Page, response: Response) => { store.set(name(key), response); },
    keys: async () => [...store.keys()].map((key) => ({ url: ORIGIN + key })), delete: async (key: { url: string }) => store.delete(new URL(key.url).pathname),
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; }, location: { origin: ORIGIN } };
  vm.runInNewContext(SOURCE, { self, caches: { open: async () => cache }, fetch: network, setTimeout, URL, Response });
  const open = (request: Page) => {
    let response: Promise<Response> | undefined; const waits: Promise<unknown>[] = [];
    listeners.fetch({ request, respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: (value: Promise<unknown>) => { waits.push(value); } });
    return { response: response!, waits };
  };
  return { open, store, saved: async (key: string) => store.get(key)?.clone().text() };
}
const settled = async <T>(promise: Promise<T>) => { let done = false; void promise.then(() => { done = true; }, () => { done = true; }); await vi.advanceTimersByTimeAsync(0); return done; };
const offline = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };

describe('the phone app’s saved copy', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens the saved app when the computer leaves the request unanswered, and saves the new one if it answers later', async () => {
    vi.useFakeTimers(); let answer: (response: Response) => void = () => {};
    const sw = worker(() => new Promise((resolve) => { answer = resolve; }), { '/': 'saved app' });
    const { response, waits } = sw.open(PAGE);
    await vi.advanceTimersByTimeAsync(2900); expect(await settled(response)).toBe(false);
    await vi.advanceTimersByTimeAsync(100); expect(await (await response).text()).toBe('saved app');
    answer(new Response('new app')); await Promise.all(waits);
    expect(await sw.saved('/')).toBe('new app');
  });

  it('uses the computer’s answer when it comes in time, and the saved app when Trace there is not answering', async () => {
    vi.useFakeTimers();
    const fresh = worker(async () => new Response('new app'), { '/': 'saved app' }).open(PAGE).response;
    await vi.advanceTimersByTimeAsync(0); expect(await (await fresh).text()).toBe('new app');
    const closed = worker(async () => new Response('Bad Gateway', { status: 502 }), { '/': 'saved app' }).open(PAGE).response;
    await vi.advanceTimersByTimeAsync(0); expect(await (await closed).text()).toBe('saved app');
    const off = worker(offline, { '/': 'saved app' }).open(PAGE).response;
    await vi.advanceTimersByTimeAsync(0); expect(await (await off).text()).toBe('saved app');
  });

  it('waits for the computer when nothing is saved yet', async () => {
    vi.useFakeTimers(); let answer: (response: Response) => void = () => {};
    const { response } = worker(() => new Promise((resolve) => { answer = resolve; })).open(PAGE);
    await vi.advanceTimersByTimeAsync(10000); expect(await settled(response)).toBe(false);
    answer(new Response('new app')); expect(await (await response).text()).toBe('new app');
  });

  it('gives a saved script at once, even when the computer no longer has it or does not answer', async () => {
    vi.useFakeTimers(); const asked: string[] = [];
    const gone = worker(async (request) => { asked.push(String(typeof request === 'string' ? request : request.url)); return new Response('Not found', { status: 404 }); }, { '/assets/old.js': 'old script' });
    expect(await (await gone.open(asset('old.js')).response).text()).toBe('old script');
    const silent = worker(() => new Promise(() => {}), { '/assets/old.js': 'old script' }).open(asset('old.js')).response;
    expect(await settled(silent)).toBe(true); expect(await (await silent).text()).toBe('old script');
    expect(asked).toEqual([]);
  });

  it('saves a late newer page only with its files, so the next start with the computer off still has a working app', async () => {
    vi.useFakeTimers(); let answer: (response: Response) => void = () => {};
    // Trace on the computer was updated: its page now names new.js, and old.js is gone there.
    const network = async (request: Page | string) => {
      const url = typeof request === 'string' ? request : new URL(request.url).pathname;
      if (url === '/') return new Promise<Response>((resolve) => { answer = resolve; });
      return url === '/assets/new.js' ? new Response('new script') : new Response('Not found', { status: 404 });
    };
    const sw = worker(network, { '/': page('old.js'), '/assets/old.js': 'old script' });
    const first = sw.open(PAGE); await vi.advanceTimersByTimeAsync(3000); expect(await (await first.response).text()).toBe(page('old.js'));
    answer(new Response(page('new.js'))); await Promise.all(first.waits);
    expect(await sw.saved('/')).toBe(page('new.js')); expect(await sw.saved('/assets/new.js')).toBe('new script'); expect(sw.store.has('/assets/old.js')).toBe(false);
    // The next start, with the computer off: the saved page's script has a saved copy.
    const next = worker(offline, sw.store); const shown = next.open(PAGE); await vi.advanceTimersByTimeAsync(0);
    const html = await (await shown.response).text(); const script = /src="(\/assets\/[^"]+)"/.exec(html)![1];
    expect(await (await next.open(asset(script.slice(8))).response).text()).toBe('new script');
  });

  it('keeps the saved page and its files when a late newer page’s files cannot be saved', async () => {
    vi.useFakeTimers(); let answer: (response: Response) => void = () => {};
    const network = async (request: Page | string) => typeof request !== 'string' && request.mode === 'navigate' ? new Promise<Response>((resolve) => { answer = resolve; }) : offline();
    const sw = worker(network, { '/': page('old.js'), '/assets/old.js': 'old script' });
    const first = sw.open(PAGE); await vi.advanceTimersByTimeAsync(3000); await first.response;
    answer(new Response(page('new.js'))); await Promise.all(first.waits);
    expect(await sw.saved('/')).toBe(page('old.js')); expect(await sw.saved('/assets/old.js')).toBe('old script');
  });
});
