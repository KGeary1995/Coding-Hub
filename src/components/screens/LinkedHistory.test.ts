import { describe, expect, it } from 'vitest';
import type { RemoteHistoryItem } from '../../../shared/remote';
import { matchesHistory } from './LinkedHistory';

const item: RemoteHistoryItem = { key: 'codex:1', engine: 'codex', title: 'Fix the sync folder', folder: 'Coding-Hub', modified: '2026-11-24T20:00:00.000Z' };

describe('History on another computer\'s tab', () => {
  it('filters by title, folder or agent, ignoring case and outer spaces', () => {
    expect(matchesHistory(item, '')).toBe(true); expect(matchesHistory(item, '  SYNC ')).toBe(true);
    expect(matchesHistory(item, 'coding-hub')).toBe(true); expect(matchesHistory(item, 'codex')).toBe(true);
    expect(matchesHistory(item, 'claude')).toBe(false);
  });
});
