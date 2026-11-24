import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, CircleAlert, GitBranch, GitCommitHorizontal, History, Info, LoaderCircle } from 'lucide-react';
import type { GitCommit, GitCommitDetail, GitLog, GitRef, RepositoryContext } from '../../shared/types';
import { layoutGraph, type GraphRow } from '../../shared/commit-graph';
import { ago } from './workspace/EmptyWorkspace';

/** Matches `.commit-row`'s height in changes.css: a lane's lines meet the next row's exactly. */
export const ROW_HEIGHT = 44;
const LANE = 14; const MIDDLE = ROW_HEIGHT / 2;
const x = (column: number) => LANE / 2 + column * LANE;
/** Eight lane colours from the existing tokens (`.commit-lane-N` in changes.css); a ninth lane repeats the first. */
const LANE_COLOURS = 8;

/**
 * One row's slice of the graph: lines into and out of the dot, then the dot (hollow for a merge, ringed for HEAD). `slice`:
 * a cell narrowed by CSS (many lanes) cuts off the right-hand lanes instead of shrinking the drawing off the row's edges.
 */
export function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const span = Math.max(1, width) * LANE;
  return <svg className="commit-graph" width={span} height={ROW_HEIGHT} viewBox={`0 0 ${span} ${ROW_HEIGHT}`} preserveAspectRatio="xMinYMid slice" aria-hidden="true" focusable="false">
    {row.lines.map((line, index) => { const [y1, y2] = line.half === 'top' ? [0, MIDDLE] : [MIDDLE, ROW_HEIGHT]; const bend = (y1 + y2) / 2;
      return <path key={index} className={`commit-lane-${line.colour % LANE_COLOURS}`} d={line.from === line.to ? `M${x(line.from)} ${y1}V${y2}` : `M${x(line.from)} ${y1}C${x(line.from)} ${bend} ${x(line.to)} ${bend} ${x(line.to)} ${y2}`} />; })}
    <circle className={`commit-dot commit-lane-${row.colour % LANE_COLOURS}${row.merge ? ' merge' : ''}${head ? ' head' : ''}`} cx={x(row.column)} cy={MIDDLE} r={head ? 5 : 4} />
  </svg>;
}

/** "3 days ago" for the last month, then the date: "400 days ago" says less than the day itself. */
export function commitWhen(iso: string, now = Date.now()) { return now - new Date(iso).getTime() < 30 * 86_400_000 ? ago(iso, now) : new Date(iso).toLocaleDateString(); }
const refTone = (ref: GitRef) => ref.current ? 'accent' : ref.kind === 'branch' ? 'success' : ref.kind === 'tag' ? 'warning' : 'neutral';
/** Read out with the row: what points here, then the subject, author and when. */
export function commitLabel(commit: GitCommit, head: boolean, now = Date.now()) {
  const refs = [...head ? ['HEAD'] : [], ...commit.refs.map((ref) => ref.kind === 'tag' ? `tag ${ref.name}` : ref.name)];
  return `${refs.length ? refs.join(', ') + ': ' : ''}${commit.subject || '(no subject)'}, ${commit.sha.slice(0, 7)} by ${commit.author}, ${commitWhen(commit.date, now)}`;
}

/** A commit's list row: the graph, its badges and subject, then short id, author and when. */
export function CommitRow({ commit, row, width, head, selected, onSelect }: { commit: GitCommit; row: GraphRow; width: number; head: boolean; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={`commit-row${selected ? ' selected' : ''}`} aria-pressed={selected} aria-label={commitLabel(commit, head)} title={commit.subject} data-sha={commit.sha} onClick={onSelect}>
    <GraphCell row={row} width={width} head={head} />
    <span className="commit-main"><span className="commit-subject">{head && <span className="ui-badge accent">HEAD</span>}{commit.refs.slice(0, 3).map((ref) => <span key={ref.kind + ref.name} className={`ui-badge ${refTone(ref)}`} title={ref.kind === 'tag' ? `Tag ${ref.name}` : ref.kind === 'remote' ? `Remote branch ${ref.name}` : `Branch ${ref.name}`}>{ref.name}</span>)}{commit.refs.length > 3 && <span className="ui-badge neutral" title={commit.refs.slice(3).map((ref) => ref.name).join(', ')}>+{commit.refs.length - 3}</span>}<strong>{commit.subject || '(no subject)'}</strong></span>
      <small><code>{commit.sha.slice(0, 7)}</code> · {commit.author} · <time dateTime={commit.date} title={new Date(commit.date).toLocaleString()}>{commitWhen(commit.date)}</time></small></span>
  </button>;
}

/**
 * Changes → History: the commits of HEAD, the local branches and their upstreams with a lane graph, and the chosen commit's
 * message and files. Read-only on purpose: nothing here checks out, merges or rewrites; that stays with the agents and Git.
 */
export function CommitHistory({ repository, revision }: { repository: RepositoryContext; revision: number }) {
  const [log, setLog] = useState<GitLog | null>(null); const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null); const [detailError, setDetailError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    let cancelled = false; setError(null);
    void window.codingHub!.gitLog({ repositoryId: repository.id }).then((result) => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error.message); return; }
      setLog(result.value); setSelected((current) => current && result.value.commits.some((item) => item.sha === current) ? current : result.value.commits[0]?.sha ?? null);
    }).catch(() => { if (!cancelled) setError('The commit history could not be loaded.'); });
    return () => { cancelled = true; };
  }, [repository.id, revision]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false; setDetail(null); setDetailError(null);
    void window.codingHub!.gitCommit({ repositoryId: repository.id, sha: selected }).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetail(result.value); else setDetailError(result.error.message);
    }).catch(() => { if (!cancelled) setDetailError('This commit could not be loaded.'); });
    return () => { cancelled = true; };
  }, [repository.id, selected, log]);
  const graph = useMemo(() => layoutGraph(log?.commits ?? []), [log]);
  /** Up and Down move through the commits, Home and End to either end, as in a list. */
  function move(event: KeyboardEvent) {
    if (!log || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const at = log.commits.findIndex((item) => item.sha === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? log.commits.length - 1 : Math.min(log.commits.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault(); setSelected(log.commits[next].sha);
    list.current?.querySelector<HTMLButtonElement>(`[data-sha="${log.commits[next].sha}"]`)?.focus();
  }
  if (error) return <div className="repository-empty repository-message ui-card ui-empty danger" role="alert"><CircleAlert size={34} /><h2>History unavailable</h2><p className="error-message">{error}</p></div>;
  if (!log) return <div className="repository-empty repository-message ui-card ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Reading the commit history…</p></div>;
  const context = <div className="git-context"><span className="ui-badge neutral"><GitBranch size={12} />{log.branch ?? (log.head ? `Detached · ${log.head.slice(0, 8)}` : 'No branch')}</span><small className="commit-count">{log.limited ? `The latest ${log.commits.length} commits` : `${log.commits.length} ${log.commits.length === 1 ? 'commit' : 'commits'}`}</small></div>;
  if (!log.commits.length) return <>{context}<div className="repository-empty repository-message ui-card ui-empty"><History size={34} /><h2>No commits yet</h2><p>The history appears here after the first commit.</p></div></>;
  const shown = log.commits.find((item) => item.sha === selected);
  return <>{context}<div className="repository-workbench commit-workbench ui-card">
    <aside className="repository-sidebar commit-list"><header><h2>History</h2><small>HEAD, local branches and their upstreams</small></header>
      <ol ref={list} className="commit-scroll" aria-label="Commits" onKeyDown={move}>{log.commits.map((commit, index) => <li key={commit.sha}><CommitRow commit={commit} row={graph.rows[index]} width={graph.width} head={commit.sha === log.head} selected={commit.sha === selected} onSelect={() => setSelected(commit.sha)} /></li>)}</ol>
      {log.limited && <footer className="ui-hint">Showing the latest {log.commits.length}. Use your local Git tools for older history.</footer>}</aside>
    <article className="file-preview commit-detail" aria-label="Commit details">
      <header className="code-heading"><h2 title={selected ?? undefined}><GitCommitHorizontal size={16} />{selected ? selected.slice(0, 12) : 'Select a commit'}</h2>{shown && <span className="review-badge ui-badge neutral">{shown.parents.length > 1 ? 'Merge' : shown.parents.length ? 'Commit' : 'First commit'}</span>}</header>
      {detailError ? <div className="repository-empty ui-empty danger" role="alert"><CircleAlert size={34} /><h2>Commit unavailable</h2><p className="error-message">{detailError}</p></div>
        : !detail ? <div className="repository-empty ui-empty" role="status"><LoaderCircle size={34} className="spin" /><p>Loading commit…</p></div>
        : <div className="commit-body">
          <p className="code-metadata commit-meta"><span>{detail.author}</span><time dateTime={detail.date}>{new Date(detail.date).toLocaleString()}</time>{detail.parents.length > 0 && <span>{detail.parents.length > 1 ? 'Parents' : 'Parent'} {detail.parents.map((sha) => sha.slice(0, 7)).join(', ')}</span>}</p>
          <pre className="commit-message">{detail.message || '(no message)'}</pre>
          {detail.parents.length > 1 && <div className="ui-banner info"><Info size={16} /><span>A merge: the files it changed on its first parent’s branch.</span></div>}
          <h3 className="commit-files-title">{detail.files.length} changed {detail.files.length === 1 ? 'file' : 'files'}{detail.limited ? ' (list cut short)' : ''}</h3>
          <ul className="commit-files">{detail.files.map((file) => <li key={(file.originalPath ?? '') + file.path} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
            <span className="commit-file-path">{file.originalPath && <><span>{file.originalPath}</span><ArrowRight size={12} aria-label="renamed to" /></>}<span>{file.path}</span></span>
            {file.additions === null ? <span className="ui-badge neutral">Binary</span> : <span className="diff-counts"><span>+{file.additions}</span><span>−{file.deletions}</span></span>}</li>)}</ul>
        </div>}
    </article>
  </div></>;
}
