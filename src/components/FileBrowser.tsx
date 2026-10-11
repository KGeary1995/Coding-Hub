import { useEffect, useState } from 'react';
import { FileCode2, FileBox, FileSearch } from 'lucide-react';
import type { FilePreview, RepositoryContext } from '../../shared/types';
import { FileTree } from './FileTree';

const MAX_SOURCE_LINES = 4000;

export function FileBrowser({ repository, revision }: { repository: RepositoryContext; revision: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false; setError(null); setPreview(null);
    void window.codingHub!.readFile({ repositoryId: repository.id, path: selected }).then((result) => {
      if (cancelled) return;
      if (result.ok) setPreview(result.value); else setError(result.error.message);
    }).catch(() => { if (!cancelled) setError('The file preview could not be loaded.'); });
    return () => { cancelled = true; };
  }, [repository.id, selected, revision]);
  const lines = preview?.text?.split(/\r?\n/) ?? [];
  return <div className="repository-workbench"><aside className="repository-sidebar"><header><span className="eyebrow">EXPLORER</span><strong title={repository.directory}>{repository.directory.split(/[\\/]/).filter(Boolean).at(-1) || repository.directory}</strong></header><div className="repository-list-scroll"><FileTree repository={repository} selected={selected} onSelect={setSelected} revision={revision} /></div><footer>Read-only files · folders load on demand</footer></aside><article className="file-preview"><header className="code-heading"><h2 title={selected ?? undefined}><FileCode2 size={16} />{selected ?? 'File preview'}</h2><span className="review-badge">Read only</span></header>{preview && <div className="code-metadata"><span>{(preview.size / 1024).toFixed(1)} KiB</span><span>{preview.encoding ?? 'Binary / unsupported encoding'}</span></div>}{error ? <div className="repository-empty error-message" role="alert">{error}</div> : !selected ? <div className="repository-empty"><FileSearch size={34} /><h2>Explore your project</h2><p>Select a file to preview its contents.</p></div> : !preview ? <div className="repository-empty">Loading file…</div> : preview.binary ? <div className="repository-empty"><FileBox size={34} /><h2>Text preview unavailable</h2><p>This is a binary file or uses an unsupported text encoding.</p></div> : <>{(preview.truncated || lines.length > MAX_SOURCE_LINES) && <div className="preview-notice">{preview.truncated && 'Preview limited to the first 1 MiB. '}{lines.length > MAX_SOURCE_LINES && `Showing the first ${MAX_SOURCE_LINES.toLocaleString()} lines.`}</div>}<div className="source-code" role="region" aria-label="File contents">{lines.slice(0, MAX_SOURCE_LINES).map((line, index) => <div className="source-line" key={index}><span className="line-number">{index + 1}</span><code>{line || ' '}</code></div>)}</div></>}</article></div>;
}
