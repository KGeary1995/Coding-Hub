import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff-parser';

describe('visual diff rows', () => {
  it('numbers both sides of multiple hunks and counts changes without counting headers', () => {
    const parsed = parseDiff('--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n@@ -20 +30 @@\n-last\n+++new content\n\\ No newline at end of file\n');
    expect(parsed).toMatchObject({ additions: 2, deletions: 2, combined: false });
    expect(parsed.rows.filter((row) => row.kind === 'addition')).toEqual([
      { kind: 'addition', oldLine: null, newLine: 2, text: 'new' }, { kind: 'addition', oldLine: null, newLine: 30, text: '++new content' },
    ]);
    expect(parsed.rows.find((row) => row.kind === 'context')).toMatchObject({ oldLine: 1, newLine: 1 });
  });
  it('keeps combined merge hunks and binary/mode metadata readable without invented line numbers', () => {
    const parsed = parseDiff('diff --cc conflict.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\nBinary files a/file and b/file differ\n');
    expect(parsed.combined).toBe(true); expect(parsed.additions).toBe(0);
    expect(parsed.rows.every((row) => row.oldLine === null && row.newLine === null)).toBe(true);
    expect(parseDiff('')).toMatchObject({ rows: [], additions: 0, deletions: 0 });
  });
});
