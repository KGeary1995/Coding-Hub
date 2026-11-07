import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ImagePlus, Send, Square, Users, X } from 'lucide-react';
import type { ChatImage } from '../../../shared/chat';
import { MAX_CHANNELS } from '../../../shared/schemas';
import type { Session } from '../../../shared/types';
import { chatAnswered, chatFailed, chatSent, useChatStore } from '../../state/chat-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { channelToday } from '../../state/channel-state';
import { forgetTable, openRoundTable, tableRequest } from '../../runtime/round-table';
import { AGENT, EMPTY, Item, readImage, TableBar } from './ChatParts';

/**
 * A chat channel: Claude Code's or Codex's conversation drawn by Trace, with the person's images in the thread, formatted
 * replies, tool calls as cards with their results, and approvals as buttons. The CLI runs in structured mode in the
 * channel's folder with the channel's account, rules, memory and tools, as a terminal channel does. A chat that leads a
 * Round Table shows both agents in one thread, each labelled, and sends the person's messages to both.
 */
export function ChatView({ session }: { session: Session }) {
  const chat = useChatStore((state) => state.threads[session.id] ?? EMPTY);
  const table = chat.table ?? null;
  const partnerThread = useChatStore((state) => table ? state.threads[table.partner.sessionId] ?? EMPTY : EMPTY);
  const partnerSession = useWorkspaceStore((state) => table ? state.sessions.find((item) => item.id === table.partner.sessionId) ?? null : null);
  /** This chat sits at another channel's table: it is written to from there. */
  const seatedAt = useChatStore((state) => Object.entries(state.threads).find(([, thread]) => thread.table?.partner.sessionId === session.id)?.[0] ?? null);
  const channels = useWorkspaceStore((state) => state.sessions.length);
  const engine = session.config.engine === 'codex' ? 'codex' as const : 'claude' as const;
  const agent = AGENT[engine];
  const running = session.status === 'running' && session.runId !== null && chat.runId === session.runId;
  const busy = chat.busy || (table !== null && partnerThread.busy);
  const leadTokens = useHubStore((state) => channelToday(session.id, state.usage).tokens);
  const partnerTokens = useHubStore((state) => table ? channelToday(table.partner.sessionId, state.usage).tokens : 0);
  const tableTokens = table ? { lead: leadTokens, partner: partnerTokens } : undefined;
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null); const [opening, setOpening] = useState(false);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const input = useRef<HTMLTextAreaElement>(null); const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (viewing) dialog.current?.showModal(); else dialog.current?.close(); }, [viewing]);
  // Follow new content while the person is at the bottom; scrolling up to read stops that.
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat, partnerThread]);
  useLayoutEffect(() => { const area = input.current; if (area) { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 220) + 'px'; } }, [text]);

  /** At a table, the partner's replies, approvals and notices join this thread in the order they came; Trace's prompts to it stay out. */
  const items = useMemo(() => {
    const own = chat.items.map((item) => ({ item, from: 'lead' as const }));
    if (!table) return own;
    return [...own, ...partnerThread.items.filter((item) => item.kind !== 'user').map((item) => ({ item, from: 'partner' as const }))]
      .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
  }, [chat.items, partnerThread.items, table]);

  const attach = async (files: Blob[]) => {
    setError('');
    try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); }
    catch (e) { setError((e as Error).message); }
  };
  const send = async () => {
    // At a table a message may be written while the agents work: both stop, and it goes to both.
    if (!running || seatedAt || (chat.busy && !table) || (!text.trim() && !images.length) || !window.codingHub) return;
    const message = text.trim(); const attached = images;
    chatSent(session.id, message, attached); setText(''); setImages([]); pinned.current = true;
    if (table) { const failure = await tableRequest(session.id, { action: 'table-send', text: message, images: attached }); if (failure) chatFailed(session.id, failure); return; }
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId: session.runId!, text: message, images: attached }).catch(() => null);
    if (!result?.ok) chatFailed(session.id, result?.error.message ?? 'The message could not be delivered.');
  };
  const answerFor = (target: Session | null) => (requestId: string) => async (allow: boolean, allowEdits?: boolean) => {
    if (!target?.runId || !window.codingHub) return;
    const result = await window.codingHub.chat({ action: 'answer', sessionId: target.id, runId: target.runId, requestId, allow, ...(allowEdits ? { allowEdits } : {}) }).catch(() => null);
    if (result?.ok) chatAnswered(target.id, requestId, allow); else setError(result?.error.message ?? 'The answer could not be delivered.');
  };
  const interrupt = () => { if (table) void tableRequest(session.id, { action: 'table-stop' }); else if (session.runId) void window.codingHub?.chat({ action: 'interrupt', sessionId: session.id, runId: session.runId }); };
  const openTable = async () => { setOpening(true); setError(''); const failure = await openRoundTable(session.id); setOpening(false); if (failure) setError(failure); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } };
  const onPaste = (event: ClipboardEvent) => { const files = [...event.clipboardData.files].filter((item) => item.type.startsWith('image/')); if (files.length) { event.preventDefault(); void attach(files); } };
  const onDrop = (event: DragEvent) => { const files = [...event.dataTransfer.files]; if (files.some((item) => item.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } };
  const other = AGENT[engine === 'claude' ? 'codex' : 'claude'];
  const workers = table ? [chat.busy ? agent : null, partnerThread.busy ? AGENT[table.partner.engine] : null].filter(Boolean) : [agent];
  const placeholder = !running ? 'Start the channel to chat' : seatedAt ? 'This chat is at a Round Table: write in the Round Table channel' : table ? `Message ${agent} and ${AGENT[table.partner.engine]} (Enter to send)` : chat.busy ? `${agent} is working. You can write your next message.` : `Message ${agent} (Enter to send, Shift+Enter for a new line)`;

  return <div className={`chat-view ${table ? 'at-table' : ''}`} data-chat-session={session.id} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
 {table && <TableBar leadEngine={engine} table={table} busy={busy} tokens={tableTokens} onRequest={(request) => { if (request.action === 'table-close') forgetTable(session.id); void tableRequest(session.id, request).then((failure) => { if (failure) setError(failure); }); }} />}
    {seatedAt && <p className="table-seated" role="note">At a Round Table: this chat answers there, and you write to it in that channel.</p>}
    <div className="chat-thread" ref={scroller} onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }} role="log" aria-label="Conversation" aria-live="polite">
      {!items.length && <p className="chat-empty">{running ? `Ask ${agent} anything about this project. Paste or drop screenshots to include them.` : `Start the channel to chat with ${agent} in this folder.`}</p>}
      {items.map(({ item, from }) => from === 'lead'
        ? <Item key={item.id} item={item} results={chat.results} agent={agent} author={table ? engine : undefined} role={table ? (table.driver === engine ? 'driver' : 'reviewer') : undefined} answer={answerFor(session)} view={setViewing} />
        : <Item key={`partner-${item.id}`} item={item} results={partnerThread.results} agent={AGENT[table!.partner.engine]} author={table!.partner.engine} role={table!.driver === table!.partner.engine ? 'driver' : 'reviewer'} answer={answerFor(partnerSession)} view={setViewing} />)}
      {busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{workers.join(' and ')} {workers.length > 1 ? 'are' : 'is'} working</p>}
    </div>
    <div className="chat-composer">
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button className="chat-icon" aria-label="Attach images" title="Attach images (or paste or drop them)" disabled={!running || Boolean(seatedAt)} onClick={() => file.current?.click()}><ImagePlus size={16} /></button>
        {!table && !seatedAt && <button className="chat-icon" aria-label={`Round Table: add ${other}`} title={channels >= MAX_CHANNELS ? 'Close a channel first: a Round Table adds one' : `Round Table: bring ${other} into this conversation`} disabled={!running || opening || channels >= MAX_CHANNELS} onClick={() => void openTable()}><Users size={16} /></button>}
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea ref={input} rows={1} value={text} disabled={!running || Boolean(seatedAt)} placeholder={placeholder} aria-label={table ? 'Message to the Round Table' : `Message to ${agent}`} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        {busy && !text.trim()
          ? <button className="chat-icon stop" aria-label={table ? 'Stop both agents' : `Stop ${agent}'s reply`} title={table ? 'Stop both agents and the discussion' : `Stop the reply (${agent} keeps what it has done)`} onClick={interrupt}><Square size={14} /></button>
          : <button className="chat-icon send" aria-label="Send" disabled={!running || Boolean(seatedAt) || (!text.trim() && !images.length) || (chat.busy && !table)} onClick={() => void send()}><Send size={16} /></button>}
      </div>
    </div>
    <dialog ref={dialog} className="pasted-viewer" onClose={() => setViewing(null)} onClick={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
      {viewing && <><header><span>Image</span><button className="quiet-button" aria-label="Close image" onClick={() => setViewing(null)}><X size={14} /></button></header><img src={viewing} alt="" /></>}
    </dialog>
  </div>;
}
