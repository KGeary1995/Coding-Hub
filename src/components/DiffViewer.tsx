import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, FileBox, GitBranch, GitCompareArrows, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { DiffArea, GitChange, GitFileDiff, GitStatus, RepositoryContext } from '../../shared/types';
import { parseDiff } from '../../shared/diff-parser';

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

export function DiffViewer({ repository, revision }: { repository: RepositoryContext; revision: number }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
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
  if (error) return <div className="repository-empty repository-message ui-card ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Git review unavailable</h2><p className="error-message">{error}</p></div>;
  if (!status) return <div className="repository-empty repository-message ui-card ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Reading Git status…</p></div>;
  return <><div className="git-context"><span className="ui-badge neutral"><GitBranch size={12} />{status.branch ?? (status.head ? `Detached · ${status.head.slice(0, 8)}` : 'No branch')}</span>{!samePath(status.root, repository.directory) && <code title={status.root}>Git root: {status.root}</code>}{!status.head && <span className="ui-badge warning">Initial commit pending</span>}</div>{status.limited && <div className="ui-banner info"><Info size={16} /><span>Showing the first 1,000 changed paths. Use your local Git tools for the complete list.</span></div>}{!status.changes.length ? <div className="repository-empty repository-message ui-card ui-empty clean-worktree"><CircleCheck size={36} /><h2>Working tree is clean</h2><p>No staged, unstaged, or untracked changes in this repository.</p></div> : <div className="repository-workbench diff-workbench ui-card"><aside className="repository-sidebar"><header><h2>Change review</h2><small>{status.changes.length} changed {status.changes.length === 1 ? 'path' : 'paths'}</small></header><div className="repository-list-scroll">{groups.map(({ area, title }) => {
    const changes = status.changes.filter((item) => includes(item, area));
    return <section className="change-group" key={area}><h3>{title}<span className="ui-count neutral">{changes.length}</span></h3><div className="ui-list">{changes.map((item) => { const letter = item.conflicted ? '!' : area === 'untracked' ? '?' : area === 'staged' ? item.indexStatus : item.worktreeStatus;
      return <button key={item.path} className={`change-entry ui-row ${selected?.path === item.path && selected.area === area ? 'selected' : ''}`} aria-label={`${title} ${item.path}`} aria-pressed={selected?.path === item.path && selected.area === area} onClick={() => setSelected({ path: item.path, area })} title={item.originalPath ? `${item.originalPath} → ${item.path}` : item.path}><span className={`change-letter ui-badge ${letterTone(letter)}`}>{letter}</span><span className="ui-row-main"><strong>{item.path}</strong><small>{statusLabel(item, area)}{item.submodule ? ' · Submodule' : ''}</small></span></button>; })}</div></section>;
  })}</div><footer className="ui-hint">Refresh for the latest agent edits</footer></aside><article className="file-preview"><header className="code-heading"><h2 title={selected?.path}><GitCompareArrows size={16} />{selected?.path ?? 'Select a change'}</h2>{diff && !diff.binary && !parsed.combined && <span className="diff-counts"><span>+{parsed.additions}</span><span>−{parsed.deletions}</span></span>}<span className="review-badge ui-badge neutral">{selected?.area === 'working' ? 'Unstaged' : selected?.area === 'staged' ? 'Staged' : 'Untracked'}</span></header>{change?.originalPath && <div className="rename-detail"><span>{change.originalPath}</span><ArrowRight size={12} /><span>{change.path}</span></div>}{diff?.conflicted && <div className="ui-banner warning"><TriangleAlert aria-hidden="true" /><span>Merge conflict. Resolve the conflict markers in your repository before committing.</span></div>}{(diff?.truncated || parsed.rows.length > 4000 || parsed.combined) && <div className="ui-banner info"><Info size={16} /><span>{diff?.truncated && 'Untracked preview limited to the first 1 MiB. '}{parsed.rows.length > 4000 && 'Showing the first 4,000 diff rows. '}{parsed.combined && 'Combined merge diff: raw parent prefixes are preserved.'}</span></div>}{diffError ? <div className="repository-empty ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Diff unavailable</h2><p className="error-message">{diffError}</p></div> : !diff ? <div className="repository-empty ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Loading diff…</p></div> : diff.binary ? <div className="repository-empty ui-empty"><FileBox size={34} /><h2>Binary file changed</h2><p>A text diff is unavailable for this file.</p></div> : !diff.patch ? <div className="repository-empty ui-empty"><FileBox size={34} /><h2>No text differences</h2><p>This entry may represent metadata or an empty file.</p></div> : <div className="diff-code" role="region" aria-label="Git diff">{parsed.rows.slice(0, 4000).map((row, index) => <div className={`diff-line ${row.kind}`} key={index}><span className="line-number">{row.oldLine}</span><span className="line-number">{row.newLine}</span><span className="diff-prefix">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span><code>{row.text || ' '}</code></div>)}</div>}</article></div>}</>;
}
