import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

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
    expect(out).not.toContain('<img'); expect(out).not.toContain('<script'); expect(out).not.toContain('<a ');
    expect(out).toContain('&lt;img'); expect(out).toContain('<span class="chat-link" title="javascript:alert(1)">site</span>');
  });
});
