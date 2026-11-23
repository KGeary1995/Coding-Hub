import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { withKeys } from './HelpPanel';

const draw = (text: string) => renderToStaticMarkup(<>{withKeys(text)}</>);

describe('keys in Help', () => {
  it('draws shortcuts and function keys as key caps', () => {
    expect(draw('F1: open this guide.')).toBe('<kbd>F1</kbd>: open this guide.');
    expect(draw('Ctrl+Shift+P (Cmd+Shift+P): the command menu')).toBe('<kbd>Ctrl+Shift+P</kbd> (<kbd>Cmd+Shift+P</kbd>): the command menu');
  });
  it('leaves a Round Table’s finding numbers as words', () => {
    expect(draw('Trace numbers them F1, F2, …; the driver answers FIXED or DECLINED.')).toBe('Trace numbers them F1, F2, …; the driver answers FIXED or DECLINED.');
  });
});
