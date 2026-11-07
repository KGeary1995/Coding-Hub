import '../src/tile.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImagePlus, Send, Square, X } from 'lucide-react';
import type { ChatEnvelope, ChatImage, ChatRequest } from '../shared/chat';
import type { ChatReplay } from '../shared/remote';
import { applyChatEvent, chatAnswered, chatStarted, useChatStore } from '../src/state/chat-store';
import { AGENT, EMPTY, Item, readImage, TableBar } from '../src/components/chat/ChatParts';

/**
 * Chat channels on the phone: the same thread, tool cards, approvals and Round Table bar as on the desktop
 * (src/components/chat/ChatParts), fed by the computer's stream instead of a window.
 */

/** Every message the person sent, from any device, is shown: on the phone none of them was sent from this thread. */
const asSeen = (envelope: ChatEnvelope): ChatEnvelope => envelope.event.type === 'user' ? { ...envelope, event: { ...envelope.event, remote: true } } : envelope;
/** A chat event from the stream, into the shared chat state (a new run starts a new thread). */
export function receiveChat(envelope: ChatEnvelope) {
  if (useChatStore.getState().threads[envelope.sessionId]?.runId !== envelope.runId) chatStarted(envelope.sessionId, envelope.runId, false);
  applyChatEvent(asSeen(envelope));
}
/** A chat's recent events, sent once when the phone starts following it: the thread is rebuilt from them. */
export function receiveReplay(replay: ChatReplay) {
  if (!replay.runId) return;
  chatStarted(replay.sessionId, replay.runId, false);
  for (const event of replay.events) applyChatEvent(asSeen({ sessionId: replay.sessionId, runId: replay.runId, event }));
}

export interface PhoneChatProps {
  sessionId: string; runId: string | null; engine: 'claude' | 'codex'; running: boolean;
  send: (request: ChatRequest) => Promise<void>;
  /** Follows another channel's chat events (a Round Table's partner) until the returned function is called. */
  follow: (sessionId: string) => () => void;
}

function PhoneChat({ sessionId, runId, engine, running, send, follow }: PhoneChatProps) {
  const chat = useChatStore((state) => state.threads[sessionId] ?? EMPTY);
  const table = chat.table ?? null;
  const partner = useChatStore((state) => table ? state.threads[table.partner.sessionId] ?? EMPTY : EMPTY);
  const busy = chat.busy || (table !== null && partner.busy);
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState(''); const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const file = useRef<HTMLInputElement>(null);
  // A Round Table's partner answers here too, so its events are followed while the table is open.
  useEffect(() => table ? follow(table.partner.sessionId) : undefined, [table?.partner.sessionId, follow]);
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat, partner]);
  const items = useMemo(() => {
    const own = chat.items.map((item) => ({ item, from: 'lead' as const }));
    if (!table) return own;
    return [...own, ...partner.items.filter((item) => item.kind !== 'user').map((item) => ({ item, from: 'partner' as const }))].sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
  }, [chat.items, partner.items, table]);
  const live = running && runId !== null;
  const act = async (request: ChatRequest) => { setError(''); try { await send(request); return true; } catch (e) { setError((e as Error).message); return false; } };
  const submit = async () => {
    const message = text.trim(); if (!live || sending || (!message && !images.length) || (chat.busy && !table)) return;
    setSending(true); pinned.current = true;
    // The message appears when the computer passes it back, so the thread shows what the agent actually received.
    if (await act(table ? { action: 'table-send', sessionId, runId: runId!, text: message, images } : { action: 'send', sessionId, runId: runId!, text: message, images })) { setText(''); setImages([]); }
    setSending(false);
  };
  const answer = (from: 'lead' | 'partner') => (requestId: string) => async (allow: boolean, allowEdits?: boolean) => {
    const target = from === 'lead' ? { sessionId, runId } : { sessionId: table!.partner.sessionId, runId: table!.partner.runId };
    if (!target.runId) return;
    if (await act({ action: 'answer', sessionId: target.sessionId, runId: target.runId, requestId, allow, ...(allowEdits ? { allowEdits } : {}) })) chatAnswered(target.sessionId, requestId, allow);
  };
  const stop = () => { if (!runId) return; void act(table ? { action: 'table-stop', sessionId, runId } : { action: 'interrupt', sessionId, runId }); };
  const attach = async (files: Blob[]) => { try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); } catch (e) { setError((e as Error).message); } };
  const agent = AGENT[engine];
  const workers = table ? [chat.busy ? agent : null, partner.busy ? AGENT[table.partner.engine] : null].filter(Boolean) : [agent];

  return <div className={`chat-view phone-chat ${table ? 'at-table' : ''}`}>
    {table && runId && <TableBar leadEngine={engine} table={table} busy={busy} onRequest={(request) => void act({ ...request, sessionId, runId })} />}
    <div className="chat-thread" ref={scroller} role="log" aria-label="Conversation" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
      {!items.length && <p className="chat-empty">{live ? `Ask ${agent} anything. The conversation is the same one as on the computer.` : 'This chat is not running. Start it to write to it.'}</p>}
      {items.map(({ item, from }) => from === 'lead'
        ? <Item key={item.id} item={item} results={chat.results} agent={agent} author={table ? engine : undefined} answer={answer('lead')} view={setViewing} />
        : <Item key={`partner-${item.id}`} item={item} results={partner.results} agent={AGENT[table!.partner.engine]} author={table!.partner.engine} answer={answer('partner')} view={setViewing} />)}
      {busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{workers.join(' and ')} {workers.length > 1 ? 'are' : 'is'} working</p>}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button type="button" className="chat-icon" aria-label="Attach images or take a photo" disabled={!live} onClick={() => file.current?.click()}><ImagePlus size={18} /></button>
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea rows={1} value={text} disabled={!live} placeholder={!live ? 'Not running' : table ? `Message ${agent} and ${AGENT[table.partner.engine]}` : `Message ${agent}`} aria-label={table ? 'Message to the Round Table' : `Message to ${agent}`} onChange={(event) => setText(event.target.value)} />
        {busy && !text.trim()
          ? <button type="button" className="chat-icon stop" aria-label={table ? 'Stop both agents' : `Stop ${agent}'s reply`} onClick={stop}><Square size={16} /></button>
          : <button type="submit" className="chat-icon send" aria-label="Send" disabled={!live || sending || (!text.trim() && !images.length) || (chat.busy && !table)}><Send size={18} /></button>}
      </div>
    </form>
    {viewing && <div className="phone-image" role="dialog" aria-label="Image"><button type="button" className="quiet" onClick={() => setViewing(null)}>Close</button><img src={viewing} alt="" /></div>}
  </div>;
}

/** Shows a chat channel in `container`; returns the function that removes it. */
export function mountChat(container: HTMLElement, props: PhoneChatProps) {
  const root = createRoot(container); root.render(<PhoneChat {...props} />);
  return () => root.unmount();
}
