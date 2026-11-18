import { describe, expect, it } from 'vitest';
import { delta } from '../../state/usage-summary';
import { changeText } from './UsageScreen';

describe('changeText', () => {
  it('reads an ordinary change as an arrow and a percentage', () => {
    expect(changeText(delta(120, 100), '14 d')).toBe('▲ 20% vs prior 14 d');
    expect(changeText(delta(80, 100), '7 d')).toBe('▼ 20% vs prior 7 d');
    expect(changeText(delta(100, 100), 'today')).toBe('▲ 0% vs prior today');
  });
  it('says so when there is no earlier window to compare with', () => {
    expect(changeText(delta(5, 0), '14 d')).toBe('no prior 14 d');
  });
  it('puts a change from a near-zero window in words, not a five-digit figure', () => {
    // The defect: 1,026,190 tokens after 1,000 read "▲ 102519%".
    expect(changeText(delta(1_026_190, 1_000), '14 d')).toBe('more than 10× the prior 14 d');
    expect(changeText(delta(1_100, 100), '14 d')).toBe('more than 10× the prior 14 d');
    expect(changeText(delta(1_099, 100), '14 d')).toBe('▲ 999% vs prior 14 d');
  });
});
