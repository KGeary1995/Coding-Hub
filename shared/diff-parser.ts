export interface DiffRow {
  kind: 'meta' | 'hunk' | 'context' | 'addition' | 'deletion' | 'notice';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** Unified hunks get line numbers; combined merge hunks retain their raw prefixes. */
export function parseDiff(patch: string): { rows: DiffRow[]; additions: number; deletions: number; combined: boolean } {
  const rows: DiffRow[] = [];
  let oldLine = 0; let newLine = 0;
  let inHunk = false; let combined = false;
  let additions = 0; let deletions = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      rows.push({ kind: 'hunk', oldLine: null, newLine: null, text });
    } else if (text.startsWith('@@@')) {
      combined = true; inHunk = false;
      rows.push({ kind: 'hunk', oldLine: null, newLine: null, text });
    } else if (text.startsWith('diff ') || !inHunk) {
      if (text.startsWith('diff ')) inHunk = false;
      rows.push({ kind: 'meta', oldLine: null, newLine: null, text });
    } else if (text.startsWith('+')) {
      additions++; rows.push({ kind: 'addition', oldLine: null, newLine: newLine++, text: text.slice(1) });
    } else if (text.startsWith('-')) {
      deletions++; rows.push({ kind: 'deletion', oldLine: oldLine++, newLine: null, text: text.slice(1) });
    } else if (text.startsWith(' ') || text === '') {
      // diff.suppressBlankEmpty=true writes blank context lines without the leading space.
      rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text: text.slice(1) });
    } else rows.push({ kind: 'notice', oldLine: null, newLine: null, text });
  }
  return { rows, additions, deletions, combined };
}

/**
 * A unified diff's rows side by side (Changes' Split, 1.31.3): a context line on both sides, and in each run of
 * changes, the removed lines on the left beside the added lines that took their place, in order. Hunk, meta and
 * notice rows span both sides.
 */
export function splitRows(rows: DiffRow[]): ({ full: DiffRow } | { left: DiffRow | null; right: DiffRow | null })[] {
  const out: ({ full: DiffRow } | { left: DiffRow | null; right: DiffRow | null })[] = []; let removed: DiffRow[] = []; let added: DiffRow[] = [];
  const flush = () => { for (let index = 0; index < Math.max(removed.length, added.length); index++) out.push({ left: removed[index] ?? null, right: added[index] ?? null }); removed = []; added = []; };
  for (const row of rows) {
    if (row.kind === 'deletion') { if (added.length) flush(); removed.push(row); continue; }
    if (row.kind === 'addition') { added.push(row); continue; }
    flush(); out.push(row.kind === 'context' ? { left: row, right: row } : { full: row });
  }
  flush(); return out;
}
