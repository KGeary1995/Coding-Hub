import { describe, expect, it } from 'vitest';
import { parseDiff, splitRows } from './diff-parser';

describe('visual diff rows', () => {
  it('numbers both sides of multiple hunks and counts changes without counting headers', () => {
    const parsed = parseDiff('--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n@@ -20 +30 @@\n-last\n+++new content\n\\ No newline at end of file\n');
    expect(parsed).toMatchObject({ additions: 2, deletions: 2, combined: false });
    expect(parsed.rows.filter((row) => row.kind === 'addition')).toEqual([
      { kind: 'addition', oldLine: null, newLine: 2, text: 'new' }, { kind: 'addition', oldLine: null, newLine: 30, text: '++new content' },
    ]);
    expect(parsed.rows.find((row) => row.kind === 'context')).toMatchObject({ oldLine: 1, newLine: 1 });
  });
  it('numbers blank context lines written without a leading space', () => {
    const parsed = parseDiff('@@ -1,3 +1,3 @@\n first\n\n-old\n+new\n');
    expect(parsed.rows.filter((row) => row.kind === 'context').map((row) => row.oldLine)).toEqual([1, 2]);
    expect(parsed.rows.find((row) => row.kind === 'addition')).toMatchObject({ newLine: 3 });
  });
  it('keeps combined merge hunks and binary/mode metadata readable without invented line numbers', () => {
    const parsed = parseDiff('diff --cc conflict.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\nBinary files a/file and b/file differ\n');
    expect(parsed.combined).toBe(true); expect(parsed.additions).toBe(0);
    expect(parsed.rows.every((row) => row.oldLine === null && row.newLine === null)).toBe(true);
    expect(parseDiff('')).toMatchObject({ rows: [], additions: 0, deletions: 0 });
  });
});

describe('a diff side by side', () => {
  it('puts each removed line beside the line that took its place, and context on both sides', () => {
    const { rows } = parseDiff('@@ -1,4 +1,4 @@\n same\n-old one\n-old two\n+new one\n end\n');
    const pairs = splitRows(rows);
    expect(pairs[0]).toMatchObject({ full: { kind: 'hunk' } });
    expect(pairs[1]).toMatchObject({ left: { text: 'same' }, right: { text: 'same' } });
    expect(pairs[2]).toMatchObject({ left: { kind: 'deletion', text: 'old one', oldLine: 2 }, right: { kind: 'addition', text: 'new one', newLine: 2 } });
    expect(pairs[3]).toMatchObject({ left: { kind: 'deletion', text: 'old two' }, right: null });
    expect(pairs[4]).toMatchObject({ left: { text: 'end' }, right: { text: 'end' } });
  });
  it('starts a new run when a line is removed after one was added', () => {
    const { rows } = parseDiff('@@ -1,2 +1,2 @@\n+a\n-b\n');
    expect(splitRows(rows).slice(1)).toMatchObject([{ left: null, right: { text: 'a' } }, { left: { text: 'b' }, right: null }]);
  });
});
