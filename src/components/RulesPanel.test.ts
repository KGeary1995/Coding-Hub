import { describe, expect, it } from 'vitest';
import { afterForget, forgettable } from './RulesPanel';

describe('a shared-rules project whose folder is missing', () => {
  const rules = { content: '', revision: 'r', directories: ['/gone', '/here'], targets: [] };
  const target = (directory: string, error?: string) => ({ directory, claudeHash: 'a', codexHash: 'b', applied: false, ...(error ? { error } : {}) });
  it('can be removed when it is registered and cannot be read', () => {
    expect(forgettable(target('/gone', 'A selected rules project is missing or inaccessible.'), rules)).toBe(true);
  });
  it('is not offered for a project that reads, or one only open in the workspace', () => {
    expect(forgettable(target('/here'), rules)).toBe(false);
    expect(forgettable(target('/workspace-only', 'A selected rules project is missing or inaccessible.'), rules)).toBe(false);
  });
});

describe('after removing a missing project', () => {
  const loaded = { content: 'R1', revision: 'r1', directories: ['/gone'], targets: [] };
  it('takes the new revision and keeps the draft when the saved rules did not change', () => {
    expect(afterForget(loaded, { ...loaded, revision: 'r2', directories: [] }, 'my draft')).toEqual({ snapshot: { ...loaded, revision: 'r2', directories: [] }, content: 'my draft', stale: false });
  });
  it('shows rules that arrived meanwhile in an untouched editor', () => {
    expect(afterForget(loaded, { ...loaded, content: 'R2', revision: 'r3', directories: [] }, 'R1')).toEqual({ snapshot: { ...loaded, content: 'R2', revision: 'r3', directories: [] }, content: 'R2', stale: false });
  });
  it('keeps the old revision under a draft, so Save is refused rather than overwriting rules that arrived meanwhile', () => {
    expect(afterForget(loaded, { ...loaded, content: 'R2', revision: 'r3', directories: [] }, 'my draft')).toEqual({ snapshot: { ...loaded, content: 'R2', revision: 'r1', directories: [] }, content: 'my draft', stale: true });
  });
});
