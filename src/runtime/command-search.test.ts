import { describe, expect, it } from 'vitest';
import { matchRange, parseQuery, repositoryRelative, searchesFiles } from './command-search';

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

  it('turns a search hit into the path Files selects', () => {
    expect(repositoryRelative('/work/orbit/src/api/client.ts', '/work/orbit')).toBe('src/api/client.ts');
    expect(repositoryRelative('/work/orbit/src/a.ts', '/work/orbit/')).toBe('src/a.ts');
    expect(repositoryRelative('C:\\Code\\Orbit\\src\\a.ts', 'c:\\code\\orbit')).toBe('src/a.ts');
    expect(repositoryRelative('/work/orbit-web/a.ts', '/work/orbit')).toBeNull();
    expect(repositoryRelative('/work/Orbit/a.ts', '/work/orbit')).toBeNull();
    expect(repositoryRelative('/work/orbit', '/work/orbit')).toBeNull();
  });
});
