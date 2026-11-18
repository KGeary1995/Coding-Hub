import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { closeAsks, ConfirmStep } from './ConfirmStep';

describe('asking before something that cannot be undone', () => {
  it('Close asks only while the channel runs', () => {
    expect(closeAsks('running')).toBe(true);
    for (const status of ['idle', 'stopped', 'error', 'starting']) expect(closeAsks(status)).toBe(false);
  });
  it('names the action and offers Keep, which takes focus', () => {
    const html = renderToStaticMarkup(<ConfirmStep question="Stop Claude Code and close channel 2?" action="Stop and close" className="tr-detail-button" actionClassName="tr-detail-button stop" onConfirm={() => {}} onCancel={() => {}} />);
    expect(html).toContain('role="group" aria-label="Stop Claude Code and close channel 2?"');
    expect(html).toContain('<button type="button" class="tr-detail-button stop">Stop and close</button>');
    expect(html).toMatch(/<button type="button" class="tr-detail-button"[^>]*>Keep<\/button>/);
  });
});
