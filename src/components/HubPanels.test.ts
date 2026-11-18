import { describe, expect, it } from 'vitest';
import { committedKey } from './HubPanels';

describe('the shared project key field', () => {
  it('keeps a valid typed key, and goes back to the key in use for one that is not valid', () => {
    expect(committedKey('rce-research', 'coding-hub')).toBe('rce-research');
    for (const invalid of ['', 'two words', '-leading', 'a/b']) expect(committedKey(invalid, 'coding-hub')).toBe('coding-hub');
  });
});
