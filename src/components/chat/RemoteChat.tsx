import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ImagePlus, MessagesSquare, Send, Square, Users, X } from 'lucide-react';
import type { ChatEnvelope, ChatImage, ChatRequest } from '../../../shared/chat';
import type { ChatReplay } from '../../../shared/remote';
import { applyChatEvent, chatAnswered, chatStarted, useChatStore } from '../../state/chat-store';
import { AGENT, ChainBar, EMPTY, readImage, type SeatThread, TableBar, ThreadItems, useHint, useMergedThread, useSeatAnswers, workingText } from './ChatParts';
import { followSeats, joinNames, seatRun, seatViews, tableSeatIds } from './seat-view';

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
  /** Follows another channel's chat events (every other seat of a Round Table) until the returned function is called; none when they all arrive anyway. */
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
  // A Round Table's other seats answer here too (as on the computer), each in its own thread: one selector for any number of them.
  const hierarchy = table?.kind === 'hierarchy'; const hiddenKey = table ? tableSeatIds(table, sessionId).join('|') : '';
  const hiddenIds = useMemo(() => hiddenKey ? hiddenKey.split('|') : [], [hiddenKey]);
  const threads = useChatStore(useShallow((state) => hiddenIds.map((id) => state.threads[keyOf(id)] ?? EMPTY)));
  const busy = chat.busy || (table !== null && threads.some((thread) => thread.busy));
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState(''); const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const file = useRef<HTMLInputElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  // Every seat's events are followed while the table is open.
  useEffect(() => follow && hiddenIds.length ? followSeats(follow, hiddenIds) : undefined, [hiddenKey, follow]);
  const views = useMemo(() => table ? seatViews(table, engine, { builderWorking: 'The builder', plannerWorking: 'The planner', plannerColour: 'claude' }, sessionId) : [], [table, engine, sessionId]);
  const sources: SeatThread[] = table ? views.map((seat) => ({ seat, thread: seat.lead ? chat : threads[hiddenIds.indexOf(seat.id)] ?? EMPTY })) : [{ seat: { id: sessionId, engine, lead: true, name: AGENT[engine], working: AGENT[engine], duties: [], driver: false, colour: engine }, thread: chat }];
  const entries = useMergedThread(sources);
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat, entries]);
  const live = running && runId !== null;
  const act = async (request: ChatRequest) => { setError(''); try { await send(request); return true; } catch (e) { setError((e as Error).message); return false; } };
  const submit = async () => {
    const message = text.trim(); if (!live || sending || (!message && !images.length) || (chat.busy && !table)) return;
    setSending(true); pinned.current = true;
    // The message appears when the computer passes it back, so the thread shows what the agent actually received.
    if (await act(table ? { action: 'table-send', sessionId, runId: runId!, text: message, images } : { action: 'send', sessionId, runId: runId!, text: message, images })) { setText(''); setImages([]); }
    setSending(false);
  };
  // Steady across renders, so a message that did not change is not drawn again (sameItem); an approval goes to the run of the seat it came from.
  const answerSeat = useSeatAnswers(async (seatId, requestId, allow, allowEdits) => {
    const target = seatId === sessionId ? runId : table ? seatRun(table, seatId) : undefined; if (!target) return;
    if (await act({ action: 'answer', sessionId: seatId, runId: target, requestId, allow, ...(allowEdits ? { allowEdits } : {}) })) chatAnswered(keyOf(seatId), requestId, allow);
  });
  /**
   * Enter sends, Shift+Enter is a new line, as in a chat on the computer; with a mouse only (another computer's tab):
   * on a phone's keyboard Enter stays a new line, as the Send button is beside it.
   */
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia?.('(pointer: fine)').matches) { event.preventDefault(); void submit(); } };
  // The box grows with what is written, up to a limit, as on the computer.
  useLayoutEffect(() => { const area = input.current; if (area) { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 220) + 'px'; } }, [text]);
  const stop = () => { if (!runId) return; void act(table ? { action: 'table-stop', sessionId, runId } : { action: 'interrupt', sessionId, runId }); };
  const attach = async (files: Blob[]) => { try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); } catch (e) { setError((e as Error).message); } };
  const agent = AGENT[engine];
  const workers = table ? views.filter((view) => view.lead ? chat.busy : threads[hiddenIds.indexOf(view.id)]?.busy).map((view) => view.working) : [agent];
  const everyone = views.length > 2 ? `all ${views.length} agents` : joinNames(views.map((view) => view.name));
  /** The message box's hint, then shorter forms for a narrow tile or the phone (useHint). */
  const placeholder = useHint(input, !live ? ['Not running'] : hierarchy ? (table?.chain?.step === 'plan-review' ? ['Say what to change in the plan, or Approve plan', 'What to change in the plan', 'Plan changes'] : ['Give the Round Table a task', 'Give it a task']) : table ? [`Message ${everyone}`, views.length > 2 ? 'Message all' : 'Message both'] : [`Message ${agent}`]);

  return <div className={`chat-view remote-chat ${className} ${table ? 'at-table' : ''}`}>
    {table && runId && hierarchy && <ChainBar table={table} busy={busy} plannerName="The planner" builderName="The builder" onRequest={(request) => void act({ ...request, sessionId, runId })} />}
    {table && runId && !hierarchy && <TableBar leadEngine={engine} table={table} busy={busy} onRequest={(request) => void act({ ...request, sessionId, runId })} />}
    <div className="chat-thread" ref={scroller} role="log" aria-label="Conversation" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
      {!entries.length && <div className="chat-empty"><MessagesSquare aria-hidden="true" />{live ? <><strong>No messages yet</strong><p>Ask {agent} anything. The conversation is the same one as on the computer.</p></> : <><strong>This chat is not running</strong><p>Start it to write to it.</p></>}</div>}
      <ThreadItems entries={entries} table={table !== null} answerFor={answerSeat} view={setViewing} />
      {busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{workingText(workers)}</p>}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button type="button" className="chat-icon" aria-label="Attach images or take a photo" disabled={!live} onClick={() => file.current?.click()}><ImagePlus size={18} /></button>
        {openTable && !table && live && <button type="button" className="chat-icon" aria-label={`Round Table: add ${engine === 'claude' ? 'Codex' : 'Claude'}`} title={opening ? 'Adding the other agent…' : `Round Table: bring ${engine === 'claude' ? 'Codex' : 'Claude Code'} into this conversation`} disabled={opening} onClick={() => { setOpening(true); setError(''); void openTable().then((failure) => { setOpening(false); if (failure) setError(failure); }); }}><Users size={18} /></button>}
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea ref={input} rows={1} value={text} disabled={!live} placeholder={placeholder} aria-label={table ? 'Message to the Round Table' : `Message to ${agent}`} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} />
        {busy && !text.trim()
          ? <button type="button" className="chat-icon stop" aria-label={table ? `Stop ${views.length > 2 ? 'all' : 'both'} agents` : `Stop ${agent}'s reply`} onClick={stop}><Square size={16} /></button>
          : <button type="submit" className="chat-icon send" aria-label="Send" disabled={!live || sending || (!text.trim() && !images.length) || (chat.busy && !table)}><Send size={18} /></button>}
      </div>
    </form>
    {viewing && <div className="phone-image" role="dialog" aria-label="Image"><button type="button" className="button secondary" onClick={() => setViewing(null)}>Close</button><img src={viewing} alt="" /></div>}
  </div>;
}
