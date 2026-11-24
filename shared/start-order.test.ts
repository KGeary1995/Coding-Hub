import { describe, expect, it } from 'vitest';
import { outputMatcher, plainOutput, startOrder } from './start-order';

describe('start in order', () => {
  it('starts by step, and channels on the same step in their tile order', () => {
    const sessions = [{ id: 'a', startup: { order: 2 } }, { id: 'b' }, { id: 'c', startup: { order: 1 } }, { id: 'd', startup: { order: 2 } }];
    expect(startOrder(sessions, ['d', 'a', 'b', 'c']).map((item) => item.id)).toEqual(['c', 'd', 'a']);
  });
  it('reads output without its colour and title codes', () => {
    expect(plainOutput('\x1b[32mLocal:\x1b[0m   http://localhost:5173/\r\n\x1b]0;vite\x07')).toBe('Local:   http://localhost:5173/\n');
  });
  it('finds the text across pieces and colours, not case-sensitive', () => {
    const found = outputMatcher('Ready in');
    expect(found('  VITE v6  \x1b[1mrea')).toBe(false);
    expect(found('dy\x1b[22m in 312 ms')).toBe(true);
    expect(outputMatcher('listening')('nothing here')).toBe(false);
  });
});
