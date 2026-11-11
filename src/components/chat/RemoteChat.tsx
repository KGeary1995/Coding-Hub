import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Send, Square, Users, X } from 'lucide-react';
import type { ChatEnvelope, ChatImage, ChatRequest } from '../../../shared/chat';
import type { ChatReplay } from '../../../shared/remote';
import { applyChatEvent, chatAnswered, chatStarted, useChatStore } from '../../state/chat-store';
import { AGENT, ChainBar, EMPTY, Item, readImage, TableBar } from './ChatParts';

/**
 * A chat channel that runs on another device's computer: on the phone, and in another computer's tab on the desktop. The
 * same thread, tool cards, approvals and Round Table bar as a local chat (ChatParts), fed by a stream of chat events
 * instead of this window's own runs. `keyOf` keeps each computer's threads apart in the shared chat store.
 */

/** Every message the person sent, from any device, is shown: on the phone none of them was sent from this thread. */
const asSeen = (envelope: ChatEnvelope): ChatEnvelope => envelope.event.type === 'user' ? { ...envelope, event: { ...envelope.event, remote: true } } : envelope;
/** A chat event from the stream, into the shared chat state (a new run starts a new thread). */
export function receiveChat(envelope: ChatEnvelope, keyOf: (sessionId: string) => string = (id) => id) {
  const key = keyOf(envelope.sessionId); const keyed = { ...asSeen(envelope), sessionId: key };
  if (useChatStore.getState().threads[key]?.runId !== envelope.runId) chatStarted(key, envelope.runId, false);
  applyChatEvent(keyed);
}
/** A chat's recent events, sent once when the phone starts following it: the thread is rebuilt from them. */
export function receiveReplay(replay: ChatReplay, keyOf: (sessionId: string) => string = (id) => id) {
  if (!replay.runId) return;
  const key = keyOf(replay.sessionId); chatStarted(key, replay.runId, false);
  for (const event of replay.events) applyChatEvent({ ...asSeen({ sessionId: replay.sessionId, runId: replay.runId, event }), sessionId: key });
}

/** Another computer's channels share this window's chat store, so their threads are kept by computer and channel. */
export const linkedChatKey = (computerId: string) => (sessionId: string) => `${computerId}:${sessionId}`;

export interface RemoteChatProps {
  sessionId: string; runId: string | null; engine: 'claude' | 'codex'; running: boolean;
  send: (request: ChatRequest) => Promise<void>;
  /** Follows another channel's chat events (a Round Table's partner) until the returned function is called; none when they all arrive anyway. */
  follow?: (sessionId: string) => () => void;
  keyOf?: (sessionId: string) => string;
  className?: string;
  /** Opens a Round Table on this chat (the phone, when it may start agents); the error message, or null. */
  openTable?: () => Promise<string | null>;
}

const same = (id: string) => id;
export function RemoteChat({ sessionId, runId, engine, running, send, follow, keyOf = same, className = '', openTable }: RemoteChatProps) {
  const [opening, setOpening] = useState(false);
  const chat = useChatStore((state) => state.threads[keyOf(sessionId)] ?? EMPTY);
  const table = chat.table ?? null;
  const partner = useChatStore((state) => table ? state.threads[keyOf(table.partner.sessionId)] ?? EMPTY : EMPTY);
  // A hierarchy table's planner (and final reviewer) answers here too, as on the computer.
  const hierarchy = table?.kind === 'hierarchy'; const plannerId = table?.planner?.sessionId ?? null;
  const planner = useChatStore((state) => plannerId ? state.threads[keyOf(plannerId)] ?? EMPTY : EMPTY);
  // And its Gemini seat (challenger and second reviewer), when it has one.
  const challengerId = hierarchy ? table?.challenger?.sessionId ?? null : null;
  const challenger = useChatStore((state) => challengerId ? state.threads[keyOf(challengerId)] ?? EMPTY : EMPTY);
  const busy = chat.busy || (table !== null && (partner.busy || planner.busy || challenger.busy));
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState(''); const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const file = useRef<HTMLInputElement>(null);
  // A Round Table's partner answers here too, so its events are followed while the table is open.
  useEffect(() => table && follow ? follow(table.partner.sessionId) : undefined, [table?.partner.sessionId, follow]);
  useEffect(() => plannerId && follow ? follow(plannerId) : undefined, [plannerId, follow]);
  useEffect(() => challengerId && follow ? follow(challengerId) : undefined, [challengerId, follow]);
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat, partner, planner, challenger]);
  const items = useMemo(() => {
    const own = chat.items.map((item) => ({ item, from: 'lead' as const }));
    if (!table) return own;
    return [...own, ...partner.items.filter((item) => item.kind !== 'user').map((item) => ({ item, from: 'partner' as const })), ...(hierarchy ? planner.items.filter((item) => item.kind !== 'user').map((item) => ({ item, from: 'planner' as const })) : []), ...(hierarchy ? challenger.items.filter((item) => item.kind !== 'user').map((item) => ({ item, from: 'challenger' as const })) : [])].sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
  }, [chat.items, partner.items, planner.items, challenger.items, table, hierarchy]);
  const live = running && runId !== null;
  const act = async (request: ChatRequest) => { setError(''); try { await send(request); return true; } catch (e) { setError((e as Error).message); return false; } };
  const submit = async () => {
    const message = text.trim(); if (!live || sending || (!message && !images.length) || (chat.busy && !table)) return;
    setSending(true); pinned.current = true;
    // The message appears when the computer passes it back, so the thread shows what the agent actually received.
    if (await act(table ? { action: 'table-send', sessionId, runId: runId!, text: message, images } : { action: 'send', sessionId, runId: runId!, text: message, images })) { setText(''); setImages([]); }
    setSending(false);
  };
  const answer = (from: 'lead' | 'partner' | 'planner' | 'challenger') => (requestId: string) => async (allow: boolean, allowEdits?: boolean) => {
    const target = from === 'lead' ? { sessionId, runId } : from === 'planner' ? { sessionId: table!.planner!.sessionId, runId: table!.planner!.runId } : from === 'challenger' ? { sessionId: table!.challenger!.sessionId, runId: table!.challenger!.runId } : { sessionId: table!.partner.sessionId, runId: table!.partner.runId };
    if (!target.runId) return;
    if (await act({ action: 'answer', sessionId: target.sessionId, runId: target.runId, requestId, allow, ...(allowEdits ? { allowEdits } : {}) })) chatAnswered(keyOf(target.sessionId), requestId, allow);
  };
  const stop = () => { if (!runId) return; void act(table ? { action: 'table-stop', sessionId, runId } : { action: 'interrupt', sessionId, runId }); };
  const attach = async (files: Blob[]) => { try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); } catch (e) { setError((e as Error).message); } };
  const agent = AGENT[engine];
  const workers = table ? [chat.busy ? (hierarchy ? 'The builder' : agent) : null, partner.busy ? AGENT[table.partner.engine] : null, planner.busy ? 'The planner' : null, challenger.busy ? 'Gemini' : null].filter(Boolean) : [agent];

  return <div className={`chat-view remote-chat ${className} ${table ? 'at-table' : ''}`}>
    {table && runId && hierarchy && <ChainBar table={table} busy={busy} plannerName="The planner" builderName="The builder" onRequest={(request) => void act({ ...request, sessionId, runId })} />}
    {table && runId && !hierarchy && <TableBar leadEngine={engine} table={table} busy={busy} onRequest={(request) => void act({ ...request, sessionId, runId })} />}
    <div className="chat-thread" ref={scroller} role="log" aria-label="Conversation" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
      {!items.length && <p className="chat-empty">{live ? `Ask ${agent} anything. The conversation is the same one as on the computer.` : 'This chat is not running. Start it to write to it.'}</p>}
      {items.map(({ item, from }) => from === 'lead'
        ? <Item key={item.id} item={item} results={chat.results} agent={agent} author={table ? engine : undefined} role={table ? (hierarchy ? 'Builder' : table.driver === engine ? 'driver' : 'reviewer') : undefined} answer={answer('lead')} view={setViewing} />
        : from === 'planner' ? <Item key={`planner-${item.id}`} item={item} results={planner.results} agent="Claude" author="claude" role="Planner" answer={answer('planner')} view={setViewing} />
        : from === 'challenger' ? <Item key={`challenger-${item.id}`} item={item} results={challenger.results} agent="Gemini" author="gemini" role="Challenger" answer={answer('challenger')} view={setViewing} />
        : <Item key={`partner-${item.id}`} item={item} results={partner.results} agent={AGENT[table!.partner.engine]} author={table!.partner.engine} role={hierarchy ? 'Reviewer' : table!.driver === table!.partner.engine ? 'driver' : 'reviewer'} answer={answer('partner')} view={setViewing} />)}
      {busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{workers.join(' and ')} {workers.length > 1 ? 'are' : 'is'} working</p>}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button type="button" className="chat-icon" aria-label="Attach images or take a photo" disabled={!live} onClick={() => file.current?.click()}><ImagePlus size={18} /></button>
        {openTable && !table && live && <button type="button" className="chat-icon" aria-label={`Round Table: add ${engine === 'claude' ? 'Codex' : 'Claude'}`} title={opening ? 'Adding the other agent…' : `Round Table: bring ${engine === 'claude' ? 'Codex' : 'Claude Code'} into this conversation`} disabled={opening} onClick={() => { setOpening(true); setError(''); void openTable().then((failure) => { setOpening(false); if (failure) setError(failure); }); }}><Users size={18} /></button>}
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea rows={1} value={text} disabled={!live} placeholder={!live ? 'Not running' : hierarchy ? (table?.chain?.step === 'plan-review' ? 'Say what to change in the plan, or Approve plan' : 'Give the Round Table a task') : table ? `Message ${agent} and ${AGENT[table.partner.engine]}` : `Message ${agent}`} aria-label={table ? 'Message to the Round Table' : `Message to ${agent}`} onChange={(event) => setText(event.target.value)} />
        {busy && !text.trim()
          ? <button type="button" className="chat-icon stop" aria-label={table ? 'Stop both agents' : `Stop ${agent}'s reply`} onClick={stop}><Square size={16} /></button>
          : <button type="submit" className="chat-icon send" aria-label="Send" disabled={!live || sending || (!text.trim() && !images.length) || (chat.busy && !table)}><Send size={18} /></button>}
      </div>
    </form>
    {viewing && <div className="phone-image" role="dialog" aria-label="Image"><button type="button" className="quiet" onClick={() => setViewing(null)}>Close</button><img src={viewing} alt="" /></div>}
  </div>;
}
