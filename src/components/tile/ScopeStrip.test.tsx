import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScopeStrip } from './ScopeStrip';

const strip = (props: Partial<Parameters<typeof ScopeStrip>[0]>) => renderToStaticMarkup(<ScopeStrip sessionId="s1" state="working" engine="codex" limit={null} limitLabel="Context 13% (near its limit from 80%)" {...props} />);

describe('a channel’s footer', () => {
  it('in the header, says the same in short: the meter and share, "tok", the trace without its rate line', () => {
    const head = strip({ limit: 0.41, tokens: 1_700_000, engine: 'claude', place: 'head' });
    expect(head).toContain('in-head'); expect(head).toContain('<b class="tr-foot-value ">41%</b>'); expect(head).toContain('</b> tok</span>'); expect(head).not.toContain('tok today');
    expect(head).toContain('tr-scope-trace'); expect(head).not.toContain('chars/s</span>'); expect(head).toContain('Terminal output over the last two minutes');
    expect(strip({ tokens: 5 })).toContain('in-foot');
    // An amount in context has no meter to name it: in the header it is followed by "ctx", not left a bare number.
    expect(strip({ contextUsed: 145, tokens: 250, engine: 'claude', place: 'head' })).toContain('<b class="tr-foot-value">145</b> ctx</span>');
  });
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
  it('gives a Terminal channel only the output trace and its rate', () => {
    const html = strip({ engine: 'shell', limit: 0.5, tokens: 900 });
    expect(html).not.toContain('tr-foot-item'); expect(html).toContain('tr-scope-trace'); expect(html).toContain('0 chars/s');
  });
  it('shows a Gemini CLI channel’s tokens today, a dash until they are measured, and no context: it reports no window', () => {
    const measured = strip({ engine: 'gemini', tokens: 525_509 });
    expect(measured).toContain('<b class="tr-foot-value">525.5k</b> tok today'); expect(measured).not.toContain('Context'); expect(measured).not.toContain('ui-meter'); expect(measured).toContain('tr-scope-trace');
    // Not measured is a dash; a counted zero is 0.
    expect(strip({ engine: 'gemini', tokens: null })).toContain('<b class="tr-foot-value">—</b> tok today');
    expect(strip({ engine: 'gemini', tokens: 0 })).toContain('<b class="tr-foot-value">0</b> tok today');
  });
});
