import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LimitNote } from './screens';

describe('a plan-limits reading without windows on the phone', () => {
  it('shows a failed check in the danger colour', () => {
    expect(renderToStaticMarkup(<LimitNote limit={{ error: 'Codex could not be started.', failed: true }} />)).toBe('<p class="limit-failed">Codex could not be started.</p>');
  });
  it('shows a fact dim, and so does an older reading that does not say which it is', () => {
    for (const failed of [false, undefined]) expect(renderToStaticMarkup(<LimitNote limit={{ error: 'This Codex account has no usage limits to show.', failed }} />)).toBe('<p class="dim">This Codex account has no usage limits to show.</p>');
  });
  it('shows nothing for a reading with windows', () => {
    expect(renderToStaticMarkup(<LimitNote limit={{ error: null, failed: true }} />)).toBe('');
  });
});
