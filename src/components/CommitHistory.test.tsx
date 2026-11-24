import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitCommit } from '../../shared/types';
import { layoutGraph } from '../../shared/commit-graph';
import { CommitRow, commitLabel, commitWhen, GraphCell, ROW_HEIGHT } from './CommitHistory';

const now = Date.parse('2026-11-24T12:00:00Z');
const commit = (sha: string, parents: string[], extra: Partial<GitCommit> = {}): GitCommit => ({ sha: sha.repeat(40), parents: parents.map((item) => item.repeat(40)), author: 'Ada', date: '2026-11-24T10:00:00Z', subject: `Commit ${sha}`, refs: [], ...extra });

describe('History rows', () => {
  it('draws a merge as a hollow dot with a line to each parent lane, at the row height', () => {
    const graph = layoutGraph([commit('m', ['a', 'b']), commit('a', ['r']), commit('b', ['r']), commit('r', [])]);
    const html = renderToStaticMarkup(<GraphCell row={graph.rows[0]} width={graph.width} head />);
    expect(html).toContain(`height="${ROW_HEIGHT}"`); expect(html).toContain('width="28"'); expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('commit-dot commit-lane-0 merge head');
    // Straight down into its own lane, and a curve out to the new lane at column 1.
    expect(html).toContain(`d="M7 22V${ROW_HEIGHT}"`); expect(html).toMatch(/d="M7 22C7 33 21 33 21 44" class="commit-lane-1"|class="commit-lane-1" d="M7 22C7 33 21 33 21 44"/);
  });

  it('is a pressed button named by its refs, subject, short id, author and time', () => {
    const item = commit('c', ['a'], { refs: [{ name: 'main', kind: 'branch', current: true }, { name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }, { name: 'old', kind: 'tag' }], subject: 'Fix <the> thing' });
    const graph = layoutGraph([item]);
    const html = renderToStaticMarkup(<CommitRow commit={item} row={graph.rows[0]} width={graph.width} head selected onSelect={() => {}} />);
    expect(html).toMatch(/^<button type="button" class="commit-row selected" aria-pressed="true"/);
    expect(html).toContain('<span class="ui-badge accent">HEAD</span>'); expect(html).toContain('title="Remote branch origin/main"'); expect(html).toContain('title="Tag v1"');
    // A fourth ref is folded into a count; the subject is text, never markup.
    expect(html).toContain('>+1</span>'); expect(html).toContain('Fix &lt;the&gt; thing'); expect(html).toContain('<code>ccccccc</code>');
    expect(commitLabel(item, true, now)).toBe('HEAD, main, origin/main, tag v1, tag old: Fix <the> thing, ccccccc by Ada, 2 h ago');
    expect(commitLabel(commit('d', [], { subject: '' }), false, now)).toBe('(no subject), ddddddd by Ada, 2 h ago');
  });

  it('says how long ago for the last month, then the date', () => {
    expect(commitWhen('2026-11-21T12:00:00Z', now)).toBe('3 days ago');
    expect(commitWhen('2025-01-02T12:00:00Z', now)).toBe(new Date('2025-01-02T12:00:00Z').toLocaleDateString());
  });
});
