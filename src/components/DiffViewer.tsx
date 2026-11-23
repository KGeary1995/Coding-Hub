import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, FileBox, GitBranch, GitCompareArrows, Info, LoaderCircle, Minus, Plus, Search, TriangleAlert } from 'lucide-react';
import type { Delivery } from './GitDeliveryPanel';
import { splitRows } from '../../shared/diff-parser';
import type { DiffArea, GitChange, GitFileDiff, GitStatus, RepositoryContext } from '../../shared/types';
import { parseDiff, type DiffRow } from '../../shared/diff-parser';
import type { ReviewComment } from '../state/review-comments';
import { CommentButton, CommentForm, CommentNote, ReviewBar } from './ReviewComments';

interface Selection { path: string; area: DiffArea }
const groups: { area: DiffArea; title: string }[] = [{ area: 'working', title: 'Unstaged' }, { area: 'staged', title: 'Staged' }, { area: 'untracked', title: 'Untracked' }];
function includes(change: GitChange, area: DiffArea) { return area === 'untracked' ? change.untracked : !change.untracked && (area === 'staged' ? change.indexStatus : change.worktreeStatus) !== ' '; }
function statusLabel(change: GitChange, area: DiffArea) {
  if (change.conflicted) return 'Conflict';
  const letter = area === 'staged' ? change.indexStatus : change.worktreeStatus;
  return ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', '?': 'New file' } as Record<string, string>)[letter] ?? letter;
}
/** The same folder, whatever the separators, case or trailing slash: the Git root line shows only when it differs. */
const folderKey = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const samePath = (a: string, b: string) => folderKey(a) === folderKey(b);
/** The badge tone of a status letter: added and new are green, deleted and conflicted red, the rest need a look. */
const letterTone = (letter: string) => ({ '!': 'danger', D: 'danger', A: 'success', '?': 'success', R: 'accent', C: 'accent' } as Record<string, string>)[letter] ?? 'warning';

/**
 * Changes' file list and diff. The list also stages (1.31.3): + stages a file, − unstages it, and each group stages or
 * unstages all of its files, through the page's delivery reading (its fingerprint), so there is one list, not two.
 */
export function DiffViewer({ repository, revision, delivery }: { repository: RepositoryContext; revision: number; delivery?: Delivery }) {
  const [filter, setFilter] = useState(''); const [split, setSplit] = useState(false); const [wrap, setWrap] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  /** Comments on lines of this repository's diffs, kept while Changes is open, and the line one is being written on (1.32.2). */
  const [comments, setComments] = useState<ReviewComment[]>([]); const [drafting, setDrafting] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false; setError(null); setStatus(null); setDiff(null);
    void window.codingHub!.gitStatus({ repositoryId: repository.id }).then((result) => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error.message); return; }
      setStatus(result.value); setStatusRevision((value) => value + 1);
      setSelected((current) => current && result.value.changes.some((item) => item.path === current.path && includes(item, current.area)) ? current : groups.flatMap(({ area }) => result.value.changes.filter((item) => includes(item, area)).map((item) => ({ path: item.path, area })))[0] ?? null);
    }).catch(() => { if (!cancelled) setError('Git status could not be loaded.'); });
    return () => { cancelled = true; };
  }, [repository.id, revision]);
  useEffect(() => {
    if (!selected || !status) return;
    let cancelled = false; setDiff(null); setDiffError(null);
    void window.codingHub!.gitDiff({ repositoryId: repository.id, ...selected }).then((result) => {
      if (cancelled) return;
      if (result.ok) setDiff(result.value); else setDiffError(result.error.message);
    }).catch(() => { if (!cancelled) setDiffError('The diff could not be loaded.'); });
    return () => { cancelled = true; };
  }, [repository.id, selected, status, statusRevision]);
  const parsed = useMemo(() => parseDiff(diff?.patch ?? ''), [diff?.patch]);
  const change = status?.changes.find((item) => item.path === selected?.path);
  /** Where a row's comments hang: its new line, or its old one for a removed line. Header and notice rows take none. */
  const anchor = (row: DiffRow) => { const line = row.kind === 'deletion' ? row.oldLine : row.newLine ?? row.oldLine; return line === null || !selected ? null : { key: `${selected.path}:${row.kind === 'deletion' ? '-' : '+'}${line}`, line, removed: row.kind === 'deletion' }; };
  const labelOf = (line: number, removed: boolean) => `${selected?.path} line ${line}${removed ? ' (removed)' : ''}`;
  if (error) return <div className="repository-empty repository-message ui-card ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Git review unavailable</h2><p className="error-message">{error}</p></div>;
  if (!status) return <div className="repository-empty repository-message ui-card ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Reading Git status…</p></div>;
  return <><div className="git-context"><span className="ui-badge neutral"><GitBranch size={12} />{status.branch ?? (status.head ? `Detached · ${status.head.slice(0, 8)}` : 'No branch')}</span>{!samePath(status.root, repository.directory) && <code title={status.root}>Git root: {status.root}</code>}{!status.head && <span className="ui-badge warning">Initial commit pending</span>}</div>{status.limited && <div className="ui-banner info"><Info size={16} /><span>Showing the first 1,000 changed paths. Use your local Git tools for the complete list.</span></div>}{!status.changes.length ? <div className="repository-empty repository-message ui-card ui-empty clean-worktree"><CircleCheck size={36} /><h2>Working tree is clean</h2><p>No staged, unstaged, or untracked changes in this repository.</p></div> : <div className="repository-workbench diff-workbench ui-card"><aside className="repository-sidebar"><header><h2>Change review</h2><small>{status.changes.length} changed {status.changes.length === 1 ? 'path' : 'paths'}</small></header><label className="change-filter"><Search size={13} aria-hidden="true" /><input aria-label="Filter changed files" placeholder="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} /></label><div className="repository-list-scroll">{groups.map(({ area, title }) => {
    const changes = status.changes.filter((item) => includes(item, area) && (!filter.trim() || item.path.toLowerCase().includes(filter.trim().toLowerCase())));
    // What this group's button and each row's button do, and the files the delivery reading can act on (it lists the same paths).
    const stage = area !== 'staged'; const ready = delivery?.state ? (stage ? delivery.state.unstaged : delivery.state.staged) : [];
    const actionable = changes.filter((item) => ready.includes(item.path)).map((item) => item.path);
    const act = (paths: string[]) => void delivery?.run({ action: stage ? 'stage' : 'unstage', paths });
    if (filter.trim() && !changes.length) return null;
    return <section className="change-group" key={area}><h3>{title}<span className="ui-count neutral">{changes.length}</span>{delivery && actionable.length > 0 && <button type="button" className="quiet-button small change-group-action" disabled={delivery.busy} onClick={() => act(actionable)}>{stage ? 'Stage all' : 'Unstage all'}</button>}</h3><div className="ui-list">{changes.map((item) => { const letter = item.conflicted ? '!' : area === 'untracked' ? '?' : area === 'staged' ? item.indexStatus : item.worktreeStatus;
      return <div className="change-item" key={item.path}><button className={`change-entry ui-row ${selected?.path === item.path && selected.area === area ? 'selected' : ''}`} aria-label={`${title} ${item.path}`} aria-pressed={selected?.path === item.path && selected.area === area} onClick={() => setSelected({ path: item.path, area })} title={item.originalPath ? `${item.originalPath} → ${item.path}` : item.path}><span className={`change-letter ui-badge ${letterTone(letter)}`}>{letter}</span><span className="ui-row-main"><strong>{item.path}</strong><small>{statusLabel(item, area)}{item.submodule ? ' · Submodule' : ''}</small></span></button>{delivery && ready.includes(item.path) && <button type="button" className="icon-button change-stage" aria-label={`${stage ? 'Stage' : 'Unstage'} ${item.path}`} title={stage ? 'Stage' : 'Unstage'} disabled={delivery.busy} onClick={() => act([item.path])}>{stage ? <Plus size={14} /> : <Minus size={14} />}</button>}</div>; })}</div></section>;
  })}</div><footer className="ui-hint">Refresh for the latest agent edits</footer></aside><article className="file-preview"><ReviewBar root={status.root} comments={comments} onSent={() => setComments([])} onClear={() => setComments([])} /><header className="code-heading"><h2 title={selected?.path}><GitCompareArrows size={16} />{selected?.path ?? 'Select a change'}</h2>{diff && !diff.binary && !parsed.combined && <span className="diff-counts"><span>+{parsed.additions}</span><span>−{parsed.deletions}</span></span>}<span className="review-badge ui-badge neutral">{selected?.area === 'working' ? 'Unstaged' : selected?.area === 'staged' ? 'Staged' : 'Untracked'}</span>{diff && !diff.binary && !parsed.combined && <span className="diff-view-controls"><span className="tr-seg" role="group" aria-label="Diff layout"><button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button><button type="button" aria-pressed={split} onClick={() => setSplit(true)}>Split</button></span><button type="button" className="quiet-button small" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button></span>}</header>{change?.originalPath && <div className="rename-detail"><span>{change.originalPath}</span><ArrowRight size={12} /><span>{change.path}</span></div>}{diff?.conflicted && <div className="ui-banner warning"><TriangleAlert aria-hidden="true" /><span>Merge conflict. Resolve the conflict markers in your repository before committing.</span></div>}{(diff?.truncated || parsed.rows.length > 4000 || parsed.combined) && <div className="ui-banner info"><Info size={16} /><span>{diff?.truncated && 'Untracked preview limited to the first 1 MiB. '}{parsed.rows.length > 4000 && 'Showing the first 4,000 diff rows. '}{parsed.combined && 'Combined merge diff: raw parent prefixes are preserved.'}</span></div>}{diffError ? <div className="repository-empty ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Diff unavailable</h2><p className="error-message">{diffError}</p></div> : !diff ? <div className="repository-empty ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Loading diff…</p></div> : diff.binary ? <div className="repository-empty ui-empty"><FileBox size={34} /><h2>Binary file changed</h2><p>A text diff is unavailable for this file.</p></div> : !diff.patch ? <div className="repository-empty ui-empty"><FileBox size={34} /><h2>No text differences</h2><p>This entry may represent metadata or an empty file.</p></div> : <div className={`diff-code${wrap ? ' wrap' : ''}${split ? ' split' : ''}`} role="region" aria-label="Git diff">{split
    // Split: what was on the left, what is now on the right, a removed line beside the line that took its place.
    ? splitRows(parsed.rows.slice(0, 4000)).map((pair, index) => 'full' in pair ? <div className={`diff-line ${pair.full.kind}`} key={index}><code>{pair.full.text || ' '}</code></div>
      : <div className="diff-pair" key={index}>{[pair.left, pair.right].map((row, side) => <div className={`diff-line ${row ? row.kind : 'empty'}`} key={side}><span className="line-number">{row ? (side ? row.newLine : row.oldLine) : ''}</span><span className="diff-prefix">{row?.kind === 'addition' ? '+' : row?.kind === 'deletion' ? '−' : ''}</span><code>{row ? row.text || ' ' : ' '}</code></div>)}</div>)
    // Unified: each line can take a comment for the agent, kept under it until sent (1.32.2).
    : parsed.rows.slice(0, 4000).map((row, index) => { const at = anchor(row); const here = at ? comments.filter((comment) => comment.path === selected?.path && comment.line === at.line && comment.removed === at.removed) : [];
      return <Fragment key={index}><div className={`diff-line ${row.kind}`}>{at ? <CommentButton label={labelOf(at.line, at.removed)} onClick={() => setDrafting(at.key)} /> : <span className="diff-comment-gap" />}<span className="line-number">{row.oldLine}</span><span className="line-number">{row.newLine}</span><span className="diff-prefix">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span><code>{row.text || ' '}</code></div>
        {here.map((comment) => <CommentNote key={comment.id} comment={comment} onRemove={() => setComments(comments.filter((item) => item.id !== comment.id))} />)}
        {at && drafting === at.key && <CommentForm label={labelOf(at.line, at.removed)} onCancel={() => setDrafting(null)} onAdd={(note) => { setComments([...comments, { id: crypto.randomUUID(), path: selected!.path, line: at.line, removed: at.removed, code: row.text, note }]); setDrafting(null); }} />}</Fragment>; })}</div>}</article></div>}</>;
}
