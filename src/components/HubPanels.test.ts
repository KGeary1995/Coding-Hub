import { describe, expect, it } from 'vitest';
import { committedKey, settledBudgets } from './HubPanels';
import { DEFAULT_PREFERENCES } from '../../shared/hub';

describe('the budget fields', () => {
  it('keep what is being typed, and are kept to their ranges once left or saved', () => {
    const settled = (limitWarning: number | undefined, dailyCost: number | null | undefined) => settledBudgets({ ...DEFAULT_PREFERENCES, limitWarning, dailyCost });
    expect(settled(75, 0.5)).toMatchObject({ limitWarning: 75, dailyCost: 0.5 });
    expect(settled(7, 0)).toMatchObject({ limitWarning: 50, dailyCost: 0.01 });
    expect(settled(120.4, 20)).toMatchObject({ limitWarning: 99, dailyCost: 20 });
    expect(settled(undefined, null)).toMatchObject({ limitWarning: undefined, dailyCost: null });
    expect(settled(Number.NaN, Number.NaN)).toMatchObject({ limitWarning: undefined, dailyCost: null });
  });
});

describe('the shared project key field', () => {
  it('keeps a valid typed key, and goes back to the key in use for one that is not valid', () => {
    expect(committedKey('rce-research', 'coding-hub')).toBe('rce-research');
    for (const invalid of ['', 'two words', '-leading', 'a/b']) expect(committedKey(invalid, 'coding-hub')).toBe('coding-hub');
  });
});
