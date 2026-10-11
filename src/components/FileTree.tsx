import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link2, LoaderCircle } from 'lucide-react';
import type { DirectoryEntry, DirectoryListing, RepositoryContext } from '../../shared/types';

interface TreeProps { repository: RepositoryContext; selected: string | null; onSelect: (path: string) => void; revision: number }

export function FileTree(props: TreeProps) {
  return <DirectoryContents {...props} relative="" depth={0} />;
}

function DirectoryContents({ relative, depth, ...props }: TreeProps & { relative: string; depth: number }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false; setError(null);
    void window.codingHub!.listDirectory({ repositoryId: props.repository.id, path: relative }).then((result) => {
      if (cancelled) return;
      if (result.ok) setListing(result.value); else setError(result.error.message);
    }).catch(() => { if (!cancelled) setError('This directory could not be loaded.'); });
    return () => { cancelled = true; };
  }, [props.repository.id, props.revision, relative]);
  if (error) return <p className="tree-message error-message" role="alert">{error}</p>;
  if (!listing) return <div className="tree-message"><LoaderCircle size={12} className="spin" />Loading directory…</div>;
  return <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Project files' : undefined} className="file-tree">{listing.entries.map((entry) => <TreeEntry key={entry.path} {...props} entry={entry} depth={depth} />)}{!listing.entries.length && <li className="tree-message">Empty directory</li>}{listing.limited && <li className="tree-message">Showing the first 500 entries in this directory.</li>}</ul>;
}

function TreeEntry({ entry, depth, ...props }: TreeProps & { entry: DirectoryEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const folder = entry.kind === 'directory';
  const available = folder || entry.kind === 'file';
  const Icon = folder ? expanded ? FolderOpen : Folder : entry.kind === 'symlink' ? Link2 : File;
  return <li role="none"><button role="treeitem" className={`file-tree-entry ${props.selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + Math.min(depth, 16) * 15 }}
    aria-label={`${folder ? 'Folder' : 'File'} ${entry.path}`} aria-expanded={folder ? expanded : undefined} aria-selected={!folder ? props.selected === entry.path : undefined}
    disabled={!available} title={available ? entry.path : 'Symbolic links and special files are not opened.'}
    onClick={() => folder ? setExpanded((value) => !value) : props.onSelect(entry.path)}>
    {folder ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="tree-spacer" />}<Icon size={14} className={folder ? 'folder-icon' : ''} /><span>{entry.name}</span>{entry.kind === 'symlink' && <small>link</small>}
  </button>{folder && expanded && <DirectoryContents {...props} relative={entry.path} depth={depth + 1} />}</li>;
}
