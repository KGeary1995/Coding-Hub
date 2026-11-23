import type { ConversationLabel } from '../../shared/productivity';
import { createElement, useEffect, useState } from 'react';
import { History, Search, SearchX, CircleAlert } from 'lucide-react';
import { ENGINE_ICONS } from './tile/engine-icons';
import type { NativeConversation, NativeResume } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { createSession, arrangeTiles, resumeConfig, RESUMED_TITLE, useWorkspaceStore } from '../state/workspace-store';
import { MAX_CHANNELS } from '../../shared/schemas';
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' } as const;
export function NativeHistory({ onBack }: { onBack: () => void }) {
  const [labels, setLabels] = useState<ConversationLabel[]>([]);
  const [items, setItems] = useState<NativeConversation[]>([]); const [search, setSearch] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(true); /* The list is read on opening, so the page starts out looking, not empty. */
  async function refresh() { setBusy(true); setError(''); try { const [conversations, saved] = await Promise.all([workbench<NativeConversation[]>({ action: 'native-list' }), workbench<ConversationLabel[]>({ action: 'flow-conversations' })]); setItems(conversations); setLabels(saved); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  useEffect(() => { void refresh(); }, []);
  async function resume(item: NativeConversation, chooseDirectory: boolean) {
    setBusy(true); setError(''); try {
      if (useWorkspaceStore.getState().sessions.length >= MAX_CHANNELS) throw new Error('Close an idle channel to make room for a resumed conversation.');
      const directory = chooseDirectory ? await window.codingHub?.pickDirectory() : undefined; if (chooseDirectory && !directory) return;
      const prepared = await workbench<NativeResume>({ action: 'native-resume', key: item.key, ...(directory ? { directory } : {}) });
      const session = createSession(item.engine, { mode: 'independent', cwd: prepared.directory });
      session.config = resumeConfig(item.engine, item.id, item.profileId);
      session.title = labels.find((label) => label.key === item.key)?.name || RESUMED_TITLE[item.engine];
      const state = useWorkspaceStore.getState(); if (state.sessions.length >= MAX_CHANNELS) throw new Error('The workspace is now full. Close an idle channel.'); const sessions = [...state.sessions, session]; useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid'), activeView: 'workspace', layoutMode: 'grid', focusedSessionId: null });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // The agent's name is searched too ("codex" finds Codex's conversations).
  const shown = items.filter((item) => `${labels.find((label) => label.key === item.key)?.name ?? item.title} ${item.directory} ${item.id} ${AGENT_NAME[item.engine]}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(labels.find((label) => label.key === b.key)?.pinned ?? false) - Number(labels.find((label) => label.key === a.key)?.pinned ?? false));
  return <section className="ui-page wide native-history">
    <header className="ui-page-head"><span className="ui-page-icon" aria-hidden="true"><History /></span><div><h1>CLI conversation history</h1><p>Conversations Claude Code and Codex saved on this computer, named profiles included.</p></div>
      <div className="ui-page-actions"><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh native conversations</button><button className="quiet-button" onClick={onBack}>Back to recorded output</button></div></header>
    <div className="native-history-search"><Search aria-hidden="true" /><input aria-label="Search native conversations" placeholder="Search project, engine, ID…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <p className="ui-hint">Not claude.ai or Claude desktop chats. Scans up to 4,000 entries and 500 conversations; incomplete files may be skipped.</p></div>
    {error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
    <div className="ui-stack">{shown.map((item) => <article className="ui-card" key={item.key}>
      <div className="ui-card-head"><span className={`ui-avatar small ${item.engine}`} aria-hidden="true">{createElement(ENGINE_ICONS[item.engine])}</span><h2>{labels.find((label) => label.key === item.key)?.pinned ? '★ ' : ''}{labels.find((label) => label.key === item.key)?.name ?? item.title}</h2><span className="ui-card-actions native-history-date">{new Date(item.modifiedAt).toLocaleString()}</span></div>
      <code className="native-history-path">{item.directory ?? 'Folder not found in metadata'}</code><p className="native-history-meta">{item.profileId ? 'Named Claude profile' : 'Default local CLI account'} · Conversation {item.id}</p>
      <div className="ui-actions"><button className="button primary" disabled={busy} onClick={() => void resume(item, false)}>Resume in new channel</button><button className="button secondary" disabled={busy} onClick={() => void resume(item, true)}>Choose folder and resume</button></div>
      <ConversationPreferences key={item.key} conversation={item} saved={labels.find((label) => label.key === item.key)} onSave={(label) => setLabels([...labels.filter((item) => item.key !== label.key), label])} /></article>)}
      {!items.length && <div className="ui-card ui-empty"><History aria-hidden="true" /><h3>{busy ? 'Looking for conversations…' : 'No native CLI conversations found'}</h3><p>{busy ? 'Reading the Claude Code and Codex logs on this computer.' : 'Conversations appear here once Claude Code or Codex has saved one on this computer.'}</p></div>}
      {items.length > 0 && !shown.length && <div className="ui-card ui-empty"><SearchX aria-hidden="true" /><h3>No conversations match</h3><p>Search by name, folder or conversation ID.</p></div>}</div>
  </section>;
}

function ConversationPreferences({conversation,saved,onSave}:{conversation:NativeConversation;saved?:ConversationLabel;onSave:(label:ConversationLabel)=>void}) {
 const [name,setName]=useState(saved?.name??conversation.title);const [pinned,setPinned]=useState(saved?.pinned??false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 return <details className="native-history-prefs"><summary>Name and pin conversation</summary><form className="ui-actions" onSubmit={(e)=>{e.preventDefault();setBusy(true);void workbench<ConversationLabel>({action:'flow-conversation-save',key:conversation.key,name,pinned}).then(onSave).catch((e)=>setError(e.message)).finally(()=>setBusy(false));}}><input aria-label="Conversation name" value={name} required maxLength={100} onChange={(e)=>setName(e.target.value)}/><label className="update-checkbox"><input type="checkbox" checked={pinned} onChange={(e)=>setPinned(e.target.checked)}/>Pin conversation</label><button className="button secondary" disabled={busy}>Save conversation preferences</button></form>{error&&<p className="error-message">{error}</p>}</details>;
}
