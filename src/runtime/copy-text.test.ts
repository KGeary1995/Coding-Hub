import { describe, expect, it } from 'vitest';
import { unwrapCopied } from './copy-text';

const rows = (...texts: string[]) => texts.map((text) => ({ text, startColumn: 0 }));

describe('copying from a channel', () => {
  it('joins the lines Claude Code broke only to fit the window (its /help screen at 60 columns)', () => {
    expect(unwrapCopied(rows(
      ' Quick safety check: Is this a project you created or one',
      ' you trust? (Like your own code, a well-known open source',
      ' project, or work from your team). If not, take a moment to',
      ' review what\'s in this folder first.',
    ), 60)).toBe(' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.');
  });
  it('joins a reply paragraph under its bullet, and keeps real line breaks', () => {
    expect(unwrapCopied(rows(
      '⏺ The tests pass, and the build finished without warnings on',
      '  both computers. Next I will publish the release.',
      '',
      '  - First item',
      '  - Second item that is short',
    ), 64)).toBe('⏺ The tests pass, and the build finished without warnings on both computers. Next I will publish the release.\n\n  - First item\n  - Second item that is short');
  });
  it('leaves short lines, code and a single line alone', () => {
    expect(unwrapCopied(rows('const a = 1;', 'const b = 2;'), 80)).toBe('const a = 1;\nconst b = 2;');
    expect(unwrapCopied(rows('one line only   '), 80)).toBe('one line only   ');
    // A line that reaches the edge but is followed by a list item is not joined.
    expect(unwrapCopied(rows('x'.repeat(76), '- next'), 80)).toBe('x'.repeat(76) + '\n- next');
  });
  it('counts where a partial first line started on screen', () => {
    const line = 'Some text before the selection starts the end of a long sentence that reached the';
    expect(unwrapCopied([{ text: 'the end of a long sentence that reached the', startColumn: 34, line }, { text: 'edge of the window.', startColumn: 0, line: 'edge of the window.' }], 80)).toBe('the end of a long sentence that reached the edge of the window.');
    // A short line stays its own line, wherever the selection started.
    expect(unwrapCopied([{ text: 'short', startColumn: 4, line: '    short' }, { text: '    next', startColumn: 0, line: '    next' }], 80)).toBe('short\n    next');
  });
});
