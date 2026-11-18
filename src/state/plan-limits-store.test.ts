import { describe, expect, it } from 'vitest';
import { resetText } from './plan-limits-store';

const now = Date.parse('2026-11-18T12:00:00Z');
const at = (resets: string | null) => resetText({ label: 'Session', usedPercent: 40, resets }, now);

describe('plan limit reset text', () => {
  it('counts down to an ISO reset time in the future', () => {
    expect(at('2026-11-18T12:20:00Z')).toBe('in 20 min');
    expect(at('2026-11-18T15:00:00Z')).toBe('in 3 h');
  });
  it('says nothing for a reset time that has passed, instead of "in 1 min"', () => {
    expect(at('2026-11-15T23:12:54.000Z')).toBeNull();
    expect(at('2026-11-18T12:00:00Z')).toBeNull();
  });
  it('shows a reset the CLI words itself as written, even one Date.parse would read as another year', () => {
    expect(at('Nov 4')).toBe('Nov 4');
    expect(at('Oct 31 at 7:59am')).toBe('Oct 31 at 7:59am');
    expect(at(null)).toBeNull();
  });
});
