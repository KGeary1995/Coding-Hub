import { useEffect, useState } from 'react';
import { CircleAlert, History, LoaderCircle, RotateCcw } from 'lucide-react';
import type { LinkedComputer, RemoteHistoryItem } from '../../../shared/remote';
import { workbench } from '../../runtime/workbench';
import { EngineAvatar } from '../tile/EngineAvatar';
import { ago } from '../workspace/EmptyWorkspace';

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' } as const;

/** The conversations one item matches when filtering: its title, folder or agent, ignoring case. */
export const matchesHistory = (item: RemoteHistoryItem, query: string) => { const words = query.trim().toLowerCase(); return !words || `${item.title} ${item.folder} ${ENGINE_NAME[item.engine]}`.toLowerCase().includes(words); };

/**
 * Another computer's Claude Code, Codex and Gemini conversations (the list its phones' History shows). A conversation
 * stays with the CLI that keeps it, on that computer, so Resume continues it there: that computer adds it as a channel,
 * which then shows on its tab here.
 */
export function LinkedHistory({ computer, onChannels }: { computer: LinkedComputer; onChannels: () => void }) {
  const [items, setItems] = useState<RemoteHistoryItem[] | null>(null); const [error, setError] = useState(''); const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null); const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const load = () => { setError(''); setItems(null); void workbench<RemoteHistoryItem[]>({ action: 'linked-history', id: computer.id }).then(setItems).catch((reason: Error) => setError(reason.message)); };
  useEffect(load, [computer.id]);
  async function resume(item: RemoteHistoryItem) {
    setBusy(item.key); setNote(null);
    try { await workbench({ action: 'linked-history-resume', id: computer.id, key: item.key }); setNote({ text: `Resumed on ${computer.name} as a new channel. Start it there from Channels.`, error: false }); }
    catch (reason) { setNote({ text: (reason as Error).message, error: true }); }
    finally { setBusy(null); }
  }
  const shown = items?.filter((item) => matchesHistory(item, query)) ?? [];
  return <section className="linked-history" aria-label={`Conversations on ${computer.name}`}>
    <div className="linked-history-head">
      <input className="ui-input" type="search" aria-label={`Filter ${computer.name}'s conversations`} placeholder="Filter by title, folder or agent" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="tr-detail-button" title="Read the list again" disabled={items === null && !error} onClick={load}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">Refresh</span></button>
    </div>
    {note && <div className={`ui-banner ${note.error ? 'danger' : ''}`} role="status">{note.error && <CircleAlert aria-hidden="true" />}<span>{note.text}</span>{!note.error && <button className="button secondary small" onClick={onChannels}>Show channels</button>}</div>}
    {error && <div className="ui-banner danger" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
    {!error && items === null && <div className="ui-empty linked-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" /><h3>Reading {computer.name}'s conversations…</h3></div>}
    {items !== null && !items.length && <div className="ui-empty linked-empty"><History aria-hidden="true" /><h3>No conversations on {computer.name}</h3><p>Claude Code, Codex and Gemini conversations there show here.</p></div>}
    {items !== null && items.length > 0 && !shown.length && <p className="muted">No conversation matches “{query.trim()}”.</p>}
    {shown.length > 0 && <ul className="ui-list linked-history-list">{shown.map((item) => <li key={item.key} className="ui-row">
      <EngineAvatar engine={item.engine} />
      <span className="ui-row-main"><strong>{item.title || 'Untitled conversation'}</strong><small>{ENGINE_NAME[item.engine]} · <span className="mono">{item.folder || 'no folder'}</span> · {ago(item.modified)}</small></span>
      <button className="button secondary small" disabled={busy !== null || !computer.connected} aria-label={`Resume ${item.title || 'this conversation'} on ${computer.name}`} onClick={() => void resume(item)}>{busy === item.key ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}Resume</button>
    </li>)}</ul>}
  </section>;
}
