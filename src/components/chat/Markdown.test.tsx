import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyAddress, Markdown, openAddress, webAddress } from './Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('chat markdown', () => {
  it('formats the usual parts of a reply', () => {
    expect(html('# Plan\n\nSome **bold**, *italic* and `code`.')).toBe('<div class="chat-markdown"><h3>Plan</h3><p>Some <strong>bold</strong>, <em>italic</em> and <code>code</code>.</p></div>');
    expect(html('- one\n- two\n  - nested')).toBe('<div class="chat-markdown"><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul></div>');
    expect(html('1. first\n2. second')).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html('```ts\nconst a = 1;\n```')).toBe('<div class="chat-markdown"><pre class="chat-code" data-language="ts"><code>const a = 1;</code></pre></div>');
    expect(html('| A | B |\n|---|---|\n| 1 | 2 |')).toContain('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
    expect(html('> quoted')).toContain('<blockquote><p>quoted</p></blockquote>');
  });
  it('never turns reply text into HTML or navigable links', () => {
    const out = html('<img src=x onerror=alert(1)> [site](javascript:alert(1)) <script>bad()</script>');
    expect(out).not.toContain('<img'); expect(out).not.toContain('<script'); expect(out).not.toContain('<a '); expect(out).not.toContain('href');
    expect(out).toContain('&lt;img'); expect(out).toContain('<button type="button" class="chat-link" title="javascript:alert(1)" aria-expanded="false">site</button>');
  });
});

describe('links in chat replies', () => {
  it('are buttons that show the address, for Markdown links and bare web addresses', () => {
    expect(html('See [the PR](https://github.com/o/r/pull/1).')).toContain('<button type="button" class="chat-link" title="https://github.com/o/r/pull/1" aria-expanded="false">the PR</button></span>.');
    // A sentence's closing punctuation is not part of the address.
    expect(html('Docs: https://example.com/a_b?x=1, then go.')).toContain('<button type="button" class="chat-link" title="https://example.com/a_b?x=1" aria-expanded="false">https://example.com/a_b?x=1</button></span>, then go.');
  });
  it('leave addresses in code alone, and never put a link inside a link', () => {
    expect(html('`https://example.com`')).toBe('<div class="chat-markdown"><p><code>https://example.com</code></p></div>');
    const nested = html('[https://a.example](https://b.example)');
    expect(nested.match(/<button/g)).toHaveLength(1); expect(nested).toContain('title="https://b.example"');
  });
  it('open in the browser only for http and https addresses', () => {
    expect(webAddress('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(webAddress('http://localhost:5173/')).toBe('http://localhost:5173/');
    for (const other of ['javascript:alert(1)', 'file:///C:/Windows', 'src/main.ts', 'mailto:a@b.c', 'data:text/html,x']) expect(webAddress(other)).toBeNull();
  });
  it('keep balanced parentheses in a bare address, and an underscore inside a word is not emphasis', () => {
    expect(html('See https://en.wikipedia.org/wiki/Rust_(programming_language).')).toContain('title="https://en.wikipedia.org/wiki/Rust_(programming_language)"');
    expect(html('(see https://example.com/a)')).toContain('title="https://example.com/a"');
    const snake = html('a_b https://x.example/c_d');
    expect(snake).not.toContain('<em>'); expect(snake).toContain('title="https://x.example/c_d"');
    expect(html('an _emphasised_ word')).toContain('<em>emphasised</em>');
  });
});

describe('link actions', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('copy through the host on the desktop, and say why when it refuses', async () => {
    const copied: string[] = [];
    vi.stubGlobal('window', { codingHub: { copyText: async (text: string) => { copied.push(text); return { ok: true, value: null }; } } });
    await copyAddress('https://example.com/a'); expect(copied).toEqual(['https://example.com/a']);
    vi.stubGlobal('window', { codingHub: { copyText: async () => ({ ok: false, error: { code: 'HOST_ERROR', message: 'Clipboard is busy.' } }) } });
    await expect(copyAddress('https://example.com/a')).rejects.toThrow('Clipboard is busy.');
  });
  it('on the phone, opening counts as done although window.open returns null with noopener', async () => {
    const open = vi.fn(() => null); vi.stubGlobal('window', { open });
    await expect(openAddress('https://example.com/a')).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
  });
});
