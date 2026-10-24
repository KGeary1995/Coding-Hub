import { describe, expect, it } from 'vitest';
import { matchRange, parseQuery, searchesFiles } from './command-search';

describe('command menu search', () => {
  it('picks a scope from a leading prefix character', () => {
    expect(parseQuery('>stop', 'all')).toEqual({ scope: 'actions', text: 'stop' });
    expect(parseQuery('@ ch2', 'all')).toEqual({ scope: 'channels', text: 'ch2' });
    expect(parseQuery('/client.ts', 'actions')).toEqual({ scope: 'files', text: 'client.ts' });
    expect(parseQuery('#handoff', 'all')).toEqual({ scope: 'memory', text: 'handoff' });
    expect(parseQuery('  settings ', 'channels')).toEqual({ scope: 'channels', text: 'settings' });
  });

  it('finds the first case-insensitive match for highlighting', () => {
    expect(matchRange('Open workspace settings', 'SETTINGS')).toEqual([15, 23]);
    expect(matchRange('Open workspace settings', 'nope')).toBeNull();
    expect(matchRange('Anything', '')).toBeNull();
  });

  it('only searches files once there is enough text', () => {
    expect(searchesFiles('all', 'ab')).toBe(false);
    expect(searchesFiles('all', 'abc')).toBe(true);
    expect(searchesFiles('files', 'ab')).toBe(true);
    expect(searchesFiles('actions', 'abcdef')).toBe(false);
  });
});
