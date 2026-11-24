import { describe, expect, it } from 'vitest';
import { PreviewOffers } from './preview-offers';

describe('PreviewOffers', () => {
  it('offers what any channel prints, Gemini and terminals too, the first of a run fresh', () => {
    const offers = new PreviewOffers();
    // A Gemini terminal channel running the dev server for its agent.
    expect(offers.data('gemini-channel', 'gemini-run', '\x1b[2K  ➜  Local:   http://localhost:\x1b[1m5173\x1b[22m/\r\n')).toEqual([{ address: { host: 'localhost', port: 5173, url: 'http://localhost:5173/' }, fresh: true }]);
    expect(offers.data('shell-channel', 'shell-run', 'Serving HTTP on 127.0.0.1 port 8000 (http://127.0.0.1:8000/) ...\n')).toHaveLength(1);
    // The same address again is nothing new; another one is, but not the run's first.
    expect(offers.data('gemini-channel', 'gemini-run', 'Local: http://localhost:5173/\n')).toEqual([]);
    expect(offers.data('gemini-channel', 'gemini-run', 'Port 5173 is in use, trying another one...\n  Local: http://localhost:5174/\n')).toEqual([{ address: { host: 'localhost', port: 5174, url: 'http://localhost:5174/' }, fresh: false }]);
    expect(offers.list()).toEqual([{ sessionId: 'gemini-channel', port: 5174, url: 'http://localhost:5174/' }, { sessionId: 'shell-channel', port: 8000, url: 'http://127.0.0.1:8000/' }]);
    expect(offers.allowed('gemini-channel', 5173).url).toBe('http://localhost:5173/');
  });
  it('refuses a port no running channel printed', () => {
    const offers = new PreviewOffers();
    offers.data('one', 'run-1', 'http://localhost:3000/\n');
    expect(() => offers.allowed('one', 3001)).toThrow(expect.objectContaining({ code: 'PREVIEW_UNKNOWN' }));
    // Another channel's port is not this channel's.
    expect(() => offers.allowed('two', 3000)).toThrow(expect.objectContaining({ code: 'PREVIEW_UNKNOWN' }));
    // Ignored addresses are never allowed either.
    offers.data('one', 'run-1', 'http://example.com:3002/ http://localhost:80/\n');
    expect(() => offers.allowed('one', 3002)).toThrow(); expect(() => offers.allowed('one', 80)).toThrow();
  });
  it('takes an ended run’s addresses back, and a new run starts fresh', () => {
    const offers = new PreviewOffers();
    offers.data('one', 'run-1', 'http://localhost:3000/\n');
    expect(offers.exit('one', 'other-run')).toBe(false); expect(offers.allowed('one', 3000).port).toBe(3000);
    expect(offers.exit('one', 'run-1')).toBe(true); expect(offers.list()).toEqual([]);
    expect(() => offers.allowed('one', 3000)).toThrow();
    expect(offers.data('one', 'run-2', 'http://localhost:3000/\n')[0]?.fresh).toBe(true);
  });
  it('finds an address split between pieces of a run’s output', () => {
    const offers = new PreviewOffers();
    expect(offers.data('one', 'run-1', 'Local: http://127.0.0.1:80')).toEqual([]);
    expect(offers.data('one', 'run-1', '80/\n').map((item) => item.address.port)).toEqual([8080]);
  });
});
