import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScopeStrip } from './ScopeStrip';

const strip = (props: Partial<Parameters<typeof ScopeStrip>[0]>) => renderToStaticMarkup(<ScopeStrip sessionId="s1" state="working" engine="codex" limit={null} limitLabel="Context 13% (near its limit from 80%)" {...props} />);

describe('a channel’s footer', () => {
  it('draws a share as a meter with its percentage, named by the meter', () => {
    const html = strip({ limit: 0.13, tokens: 105 });
    expect(html).toContain('role="img" aria-label="Context 13% (near its limit from 80%)"');
    expect(html).toContain('<i style="width:13%"></i>');
    expect(html).toContain('<b class="tr-foot-value ">13%</b>');
    expect(html).toContain('<b class="tr-foot-value">105</b> tok today');
  });
  it('turns the meter and its share to the limit colour from 80%, and never draws more than a full track', () => {
    const html = strip({ limit: 1.2 });
    expect(html).toContain('tr-scope-limit ui-meter limit'); expect(html).toContain('<i style="width:100%"></i>'); expect(html).toContain('<b class="tr-foot-value hot">120%</b>');
  });
  it('shows only the amount, with no meter, where the CLI reports no window: an empty track read as 0%', () => {
    const html = strip({ engine: 'claude', contextUsed: 145_000, tokens: 250 });
    expect(html).not.toContain('ui-meter');
    // The label is read out here: no meter carries the name.
    expect(html).toContain('<span class="tr-foot-label">Context</span><b class="tr-foot-value">145k</b>');
    expect(html).toContain('Claude Code does not report its context window');
  });
  it('says nothing of context before the first report, and still counts the tokens', () => {
    const html = strip({ engine: 'claude', tokens: 0 });
    expect(html).not.toContain('Context'); expect(html).toContain('<b class="tr-foot-value">0</b> tok today');
  });
  it('names the meter for what it measures when it falls back to the channel’s budget', () => {
    const html = strip({ limit: 0.4, limitName: 'Budget', limitLabel: 'Channel budget 40% used (near its limit from 80%)' });
    expect(html).toContain('<span class="tr-foot-label" aria-hidden="true">Budget</span>'); expect(html).not.toContain('>Context<');
  });
  it('draws no output trace for a chat channel, which has no terminal output to trace', () => {
    const html = strip({ chat: true, limit: 0.13, tokens: 105 });
    expect(html).not.toContain('tr-scope-plot'); expect(html).not.toContain('chars/s'); expect(html).toContain('tok today');
  });
  it('gives a Terminal or Gemini channel only the output trace and its rate', () => {
    for (const engine of ['shell', 'gemini'] as const) {
      const html = strip({ engine, limit: 0.5, tokens: 900 });
      expect(html).not.toContain('tr-foot-item'); expect(html).toContain('tr-scope-trace'); expect(html).toContain('0 chars/s');
    }
  });
});
