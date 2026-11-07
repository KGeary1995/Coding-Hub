import { describe, expect, it } from 'vitest';
import { inBatches } from './plan-limits';

describe('usage limit checks', () => {
  it('runs at most the given number of checks at once and keeps their order', async () => {
    let running = 0; let most = 0;
    const tasks = Array.from({ length: 11 }, (_, index) => async () => {
      running++; most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5 + (index % 3) * 5));
      running--; return index;
    });
    expect(await inBatches(tasks, 2)).toEqual(Array.from({ length: 11 }, (_, index) => index));
    expect(most).toBe(2);
    expect(await inBatches([], 2)).toEqual([]);
  });
});
