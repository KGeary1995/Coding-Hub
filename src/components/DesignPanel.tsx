import { useEffect, useRef, useState } from 'react';
import { Columns2, FileImage, History, PanelsTopLeft, Plus, RefreshCw, Search, TerminalSquare } from 'lucide-react';
import type { DesignPreview, DesignRequest, DesignResponse, DesignSnapshot } from '../../shared/design';
import { useWorkspaceStore } from '../state/workspace-store';
import { SessionGrid } from './SessionGrid';
async function call(request: DesignRequest): Promise<DesignResponse> {
  if (!window.codingHub) throw new Error('Design archives require the desktop app.');
  const result = await window.codingHub.designs(request); if (!result.ok) throw new Error(result.error.message); return result.value;
}
/** Static previews have an opaque origin, no scripts, forms, navigation, or network. */
export function designDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,base,meta,link,form,audio,video,source').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => {
    if (/^on/i.test(attribute.name) || ['href', 'srcdoc', 'action', 'formaction', 'srcset', 'background', 'ping'].includes(attribute.localName.toLowerCase()) || attribute.name.toLowerCase() === 'src' && !(node.tagName === 'IMG' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(attribute.value))) node.removeAttribute(attribute.name);
  }));
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  doc.head.prepend(policy); return '<!doctype html>' + doc.documentElement.outerHTML;
}
function Preview({ value, width }: { value: DesignPreview; width: number }) {
  return <div className="design-preview"><header><strong>{value.snapshot.title}</strong><span>v{value.snapshot.version} · {value.snapshot.sourceName}</span></header><div className="design-preview-scroll"><div className="design-device" style={{ width }}>{value.snapshot.kind === 'html' ? <iframe title={`${value.snapshot.title} version ${value.snapshot.version}`} sandbox="" referrerPolicy="no-referrer" srcDoc={designDocument(value.content)} /> : <img src={`data:${value.mime};base64,${value.content}`} alt={`${value.snapshot.title} version ${value.snapshot.version}`} />}</div></div>{value.snapshot.notes && <p className="design-notes">{value.snapshot.notes}</p>}</div>;
}
export function DesignPanel() {
  const rootDirectory = useWorkspaceStore((s) => s.rootDirectory);
  const [snapshots, setSnapshots] = useState<DesignSnapshot[]>([]);
  const [selected, setSelected] = useState<DesignPreview | null>(null);
  const [previous, setPrevious] = useState<DesignPreview | null>(null);
  const [search, setSearch] = useState(''); const [title, setTitle] = useState(''); const [notes, setNotes] = useState('');
  const [newDesign, setNewDesign] = useState(true); const [width, setWidth] = useState(1024);
  const [compare, setCompare] = useState(false); const [agents, setAgents] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const generation = useRef(0); const mounted = useRef(true);
  async function refresh() { try { const items = await call({ action: 'list' }) as DesignSnapshot[]; if (mounted.current) setSnapshots(items); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Archive unavailable.'); } }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; ++generation.current; }; }, []);
  async function select(snapshot: DesignSnapshot) {
    const current = ++generation.current; setError('');
    try {
      const value = await call({ action: 'read', id: snapshot.id }) as DesignPreview;
      const older = snapshots.filter((item) => item.designId === snapshot.designId && item.version < snapshot.version).sort((a, b) => b.version - a.version)[0];
      const before = older ? await call({ action: 'read', id: older.id }) as DesignPreview : null;
      if (mounted.current && generation.current === current) { setSelected(value); setPrevious(before); setTitle(snapshot.title); setNotes(''); setNewDesign(false); }
    } catch (e) { if (mounted.current && generation.current === current) setError(e instanceof Error ? e.message : 'Preview unavailable.'); }
  }
  async function save() {
    if (busy || !title.trim()) return; setBusy(true); setError('');
    const current = ++generation.current;
    try {
      const result = await call({ action: 'import', title: title.trim(), notes, projectDirectory: rootDirectory, ...(!newDesign && selected ? { designId: selected.snapshot.designId } : {}) }) as DesignPreview | null;
      if (mounted.current && current === generation.current && result) { setPrevious(!newDesign ? selected : null); setSelected(result); setNewDesign(false); setNotes(''); await refresh(); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Could not import preview.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const filtered = snapshots.filter((item) => `${item.title} ${item.notes} ${item.projectDirectory ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="design-panel"><div className="design-heading"><div><span className="eyebrow">LOCAL DESIGN ARCHIVE</span><h1><PanelsTopLeft size={25} />Design workspace</h1><p>Save previews from your design work. Compare versions and keep coding sessions beside them.</p></div><button className="button secondary" onClick={() => { ++generation.current; setNewDesign(true); setTitle(''); setNotes(''); setSelected(null); setPrevious(null); }} disabled={busy}><Plus size={14} />New design</button></div>
    <form className="design-import" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Design title<input aria-label="Design title" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} placeholder="Checkout flow, Dashboard, Landing page…" /></label><label>Version notes<input aria-label="Design version notes" maxLength={4000} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={busy} placeholder="What changed or needs review?" /></label><button className="button primary" disabled={busy || !title.trim()}><FileImage size={14} />{busy ? 'Saving…' : newDesign ? 'Import preview' : 'Save next version'}</button></form>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="design-toolbar"><span><History size={14} />{snapshots.length} saved versions</span><div><select aria-label="Design preview viewport" value={width} onChange={(event) => setWidth(Number(event.target.value))}><option value={1024}>Desktop · 1024 px</option><option value={768}>Tablet · 768 px</option><option value={390}>Mobile · 390 px</option></select><button className="button secondary" aria-pressed={compare} disabled={!previous} onClick={() => setCompare(!compare)}><Columns2 size={14} />Compare versions</button><button className="button secondary" aria-pressed={agents} onClick={() => setAgents(!agents)}><TerminalSquare size={14} />{agents ? 'Hide sessions' : 'Show sessions'}</button></div></div>
    <div className={`design-workbench ${agents ? 'with-agents' : ''}`}><aside className="design-history"><div className="design-search"><Search size={14} /><input aria-label="Search saved designs" placeholder="Search designs…" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="icon-button" aria-label="Refresh design archive" onClick={() => void refresh()}><RefreshCw size={13} /></button></div><div className="design-history-list">{filtered.map((item) => <button key={item.id} aria-label={`${item.title} version ${item.version}`} aria-pressed={selected?.snapshot.id === item.id} onClick={() => void select(item)} disabled={busy}><strong>{item.title}</strong><span>v{item.version} · {new Date(item.createdAt).toLocaleDateString()}</span><small>{item.notes || item.sourceName}</small></button>)}{!filtered.length && <p>No saved previews found.</p>}</div></aside><div className={`design-previews ${compare && previous ? 'comparing' : ''}`}>{selected ? <>{compare && previous && <Preview value={previous} width={width} />}<Preview value={selected} width={width} /></> : <div className="design-empty"><PanelsTopLeft size={38} /><h2>Your design history starts here</h2><p>Enter a title and import self-contained HTML or a PNG, JPEG, or WebP screenshot. Save another version after your next iteration.</p><small>HTML is a static preview. Scripts, external assets, forms, and network access are disabled. Exports from other design tools can be imported; cloud project history is not synced.</small></div>}</div>{agents && <div className="design-agents"><SessionGrid /></div>}</div>
  </section>;
}
