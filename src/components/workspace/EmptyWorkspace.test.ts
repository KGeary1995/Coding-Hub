import { describe, expect, it } from 'vitest';
import type { SessionHistoryRun } from '../../../shared/types';
import { ago, recentProjects } from './EmptyWorkspace';

const run = (cwd: string, startedAt: string): SessionHistoryRun => ({ runId: cwd + startedAt, sessionId: 's', engine: 'claude', config: { engine: 'claude' } as SessionHistoryRun['config'], cwd, startedAt, endedAt: null, status: 'completed', exitCode: 0, recordedBytes: 0, logTruncated: false });

describe('empty workspace', () => {
  it('lists each run folder once, newest first, and skips relative paths', () => {
    const recent = recentProjects([
      run('/work/a', '2026-10-20T10:00:00Z'), run('/work/b', '2026-10-22T10:00:00Z'),
      run('/work/a', '2026-10-23T10:00:00Z'), run('relative', '2026-10-24T10:00:00Z'), run('C:\\code\\c', '2026-10-21T10:00:00Z'),
    ]);
    expect(recent).toEqual([{ directory: '/work/a', at: '2026-10-23T10:00:00Z' }, { directory: '/work/b', at: '2026-10-22T10:00:00Z' }, { directory: 'C:\\code\\c', at: '2026-10-21T10:00:00Z' }]);
    expect(recentProjects(Array.from({ length: 9 }, (_, i) => run(`/p/${i}`, `2026-10-1${i}T00:00:00Z`)))).toHaveLength(5);
  });

  it('describes the last activity in plain units', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(ago('2026-10-24T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-10-24T11:45:00Z', now)).toBe('15 min ago');
    expect(ago('2026-10-24T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-23T10:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-10-20T12:00:00Z', now)).toBe('4 days ago');
  });
});
