import { describe, expect, it } from 'vitest';
import { MAX_RECENT, withRecent } from './recent-projects';

describe('recent projects', () => {
  it('puts the folder opened first, once, and keeps the ten newest', () => {
    expect(withRecent(['/b', '/a'], '/a')).toEqual(['/a', '/b']);
    expect(withRecent([], '/a')).toEqual(['/a']);
    const many = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    expect(withRecent(many, '/new')).toHaveLength(MAX_RECENT); expect(withRecent(many, '/new')[0]).toBe('/new');
  });
});
