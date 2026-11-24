import { describe, expect, it } from 'vitest';
import { PreviewDetector, previewAddresses, previewLabel, previewNavigation } from './app-preview';

const urls = (text: string) => previewAddresses(text).map((address) => address.url);

describe('previewAddresses', () => {
  it('reads the lines dev servers print, colours and all', () => {
    // Vite 6 colours the port in bold inside the address.
    expect(urls('\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n  ➜  Network: use --host to expose\r\n')).toEqual(['http://localhost:5173/']);
    expect(urls('   ▲ Next.js 15.1.0\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.20:3000\n')).toEqual(['http://localhost:3000/']);
    expect(urls('You can now view my-app in the browser.\n\n  Local:            http://localhost:3000\n  On Your Network:  http://10.0.0.5:3000\n')).toEqual(['http://localhost:3000/']);
    expect(urls('Serving HTTP on 127.0.0.1 port 8000 (http://127.0.0.1:8000/) ...\n')).toEqual(['http://127.0.0.1:8000/']);
    // Every address (0.0.0.0, [::]) includes loopback, which is what Trace opens.
    expect(urls('Serving HTTP on :: port 8080 (http://[::]:8080/) ...\n')).toEqual(['http://[::1]:8080/']);
    expect(urls(' * Running on http://0.0.0.0:5000\n')).toEqual(['http://127.0.0.1:5000/']);
    expect(urls('listening at http://[::1]:4321/ and HTTP://LOCALHOST:4000.\n')).toEqual(['http://[::1]:4321/', 'http://localhost:4000/']);
  });
  it('refuses other hosts, low ports, https and look-alikes', () => {
    expect(urls('http://192.168.1.20:3000/ http://example.com:8080/ http://localhost.example.com:3000/ http://127.0.0.1.nip.io:3000/\n')).toEqual([]);
    expect(urls('http://localhost:80/ http://localhost:1023/ http://localhost:65536/ http://localhost:99999/\n')).toEqual([]);
    expect(urls('https://localhost:5173/ localhost:5173 http://localhost/\n')).toEqual([]);
    expect(urls('http://localhost:1024/ http://localhost:65535/\n')).toEqual(['http://localhost:1024/', 'http://localhost:65535/']);
  });
  it('names each address once and waits for the end of a port', () => {
    expect(urls('http://localhost:5173/ again http://localhost:5173/\n')).toEqual(['http://localhost:5173/']);
    expect(urls('Local: http://localhost:51')).toEqual([]);
  });
});

describe('PreviewDetector', () => {
  it('finds an address split between pieces of output', () => {
    const detector = new PreviewDetector();
    expect(detector.feed('run', '  Local:   http://local')).toEqual([]);
    expect(detector.feed('run', 'host:51')).toEqual([]);
    expect(detector.feed('run', '73/\r\n').map((item) => item.url)).toEqual(['http://localhost:5173/']);
  });
  it('finds one split inside a colour code, and keeps runs apart', () => {
    const detector = new PreviewDetector();
    expect(detector.feed('a', 'http://localhost:\x1b[')).toEqual([]);
    expect(detector.feed('b', '1m3000\r\n')).toEqual([]);
    expect(detector.feed('a', '1m5173\x1b[22m/\n').map((item) => item.port)).toEqual([5173]);
    detector.forget('a'); expect(detector.feed('a', '73/\n')).toEqual([]);
  });
});

describe('previewNavigation', () => {
  const shown = 'http://localhost:5173/';
  it('keeps the page on its own address', () => {
    expect(previewNavigation('http://localhost:5173/about?x=1#top', shown)).toBe('allow');
    expect(previewNavigation('http://localhost:5174/', shown)).toBe('external');
    expect(previewNavigation('http://127.0.0.1:5173/', shown)).toBe('external');
    expect(previewNavigation('https://localhost:5173/', shown)).toBe('external');
    expect(previewNavigation('https://example.com/docs', shown)).toBe('external');
  });
  it('sends nothing but web addresses anywhere', () => {
    for (const target of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu', 'devtools://devtools', 'ms-settings:', 'not a url']) expect(previewNavigation(target, shown)).toBe('block');
  });
  it('labels an address as the tile shows it', () => { expect(previewLabel('http://localhost:5173/')).toBe('localhost:5173'); });
});
