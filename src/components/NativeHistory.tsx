import { useEffect, useState } from 'react';
import type { NativeConversation, NativeResume } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { createSession, arrangeTiles, useWorkspaceStore } from '../state/workspace-store';
export function NativeHistory({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<NativeConversation[]>([]); const [search, setSearch] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(''); try { setItems(await workbench<NativeConversation[]>({ action: 'native-list' })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  useEffect(() => { void refresh(); }, []);
  async function resume(item: NativeConversation, chooseDirectory: boolean) {
    setBusy(true); setError(''); try {
      if (useWorkspaceStore.getState().sessions.length >= 4) throw new Error('Close an idle tile to make room for a resumed conversation.');
      const directory = chooseDirectory ? await window.codingHub?.pickDirectory() : undefined; if (chooseDirectory && !directory) return;
      const prepared = await workbench<NativeResume>({ action: 'native-resume', key: item.key, ...(directory ? { directory } : {}) });
      const session = createSession(item.engine, { mode: 'independent', cwd: prepared.directory });
      session.config = item.engine === 'claude' ? { engine: 'claude', resumeId: item.id, ...(item.profileId ? { accountProfileId: item.profileId } : {}), model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } : { engine: 'codex', resumeId: item.id, model: '', reasoningEffort: null };
      session.title = item.engine === 'claude' ? 'Claude · resumed' : 'Codex · resumed';
      const state = useWorkspaceStore.getState(); if (state.sessions.length >= 4) throw new Error('The workspace is now full. Close an idle tile.'); const sessions = [...state.sessions, session]; useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid'), activeView: 'workspace', layoutMode: 'grid', focusedSessionId: null });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="feature-panel hub-panel"><h1>CLI conversation history</h1><p>Discover conversations stored by Claude Code and Codex, including named Claude profiles. This does not include claude.ai or Claude desktop chat history. Scanning is limited to 4,000 entries and 500 conversations; incomplete files may be skipped.</p><div className="hub-toolbar"><button className="button secondary" onClick={onBack}>Back to recorded output</button><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh native conversations</button><input aria-label="Search native conversations" placeholder="Search project, engine, ID…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>{error && <p role="alert" className="error-message">{error}</p>}{items.filter((item) => `${item.title} ${item.directory} ${item.id}`.toLowerCase().includes(search.toLowerCase())).map((item) => <article className="storage-card" key={item.key}><header><h2>{item.title}</h2><span>{new Date(item.modifiedAt).toLocaleString()}</span></header><code>{item.directory ?? 'Directory not found in metadata'}</code><p>{item.profileId ? 'Named Claude profile' : 'Default local CLI account'} · Conversation {item.id}</p><div className="hub-toolbar"><button className="button primary" disabled={busy} onClick={() => void resume(item, false)}>Resume in new tile</button><button className="button secondary" disabled={busy} onClick={() => void resume(item, true)}>Choose folder and resume</button></div></article>)}{!items.length && !busy && <p>No native CLI conversations found.</p>}</section>;
}
