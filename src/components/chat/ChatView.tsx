import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ImagePlus, MessagesSquare, Send, Settings2, Square, Users, X } from 'lucide-react';
import { type ChatImage } from '../../../shared/chat';
import { MAX_CHANNELS } from '../../../shared/schemas';
import type { Session } from '../../../shared/types';
import { hiddenSeatIds } from '../../../shared/table-seats';
import { chatAnswered, chatFailed, chatSent, useChatStore } from '../../state/chat-store';
import { seatsOf, useWorkspaceStore } from '../../state/workspace-store';
import { seatLabels } from '../../state/hierarchy-state';
import { useHubStore } from '../../state/hub-store';
import { channelToday } from '../../state/channel-state';
import { archiveFindings, forgetTable, hierarchyDetached, reopenTable, TABLE_FULL, tableRequest } from '../../runtime/round-table';
import { PERMISSION_LABEL, PERMISSION_LEVELS, permissionHelp, setPermissions } from '../../runtime/permissions';
import type { PermissionLevel } from '../../../shared/types';
import { permissionLevel } from '../../../shared/schemas';
import { AGENT, type BarSeat, ChainBar, type ChainSeat, EMPTY, modelName, readImage, seatState, type SeatThread, TableBar, ThreadItems, useHint, useMergedThread, useSeatAnswers, workingText } from './ChatParts';
import { isAgentConfig } from '../../../shared/types';
import { joinNames, seatViews, tableSeatIds, type SeatView } from './seat-view';
import { TableSetup } from './TableSetup';
import type { SetupMode } from './table-setup-model';

const live = (session: Session | null | undefined) => session?.status === 'running' || session?.status === 'starting';
/** The seats of a saved table that is not open, the lead first, named as the table names them. */
function savedViews(sessions: Session[], leadId: string): SeatView[] {
  const hierarchy = sessions.find((item) => item.id === leadId)?.roundTable?.kind === 'hierarchy'; const labels = seatLabels(sessions, leadId);
  return seatsOf(sessions, leadId).map(({ seat, session }, index) => {
    const engine = session?.config.engine === 'codex' ? 'codex' as const : 'claude' as const; const duties = hierarchy ? seat.duties ?? [] : []; const name = labels[index].name;
    return { id: seat.session, engine, lead: seat.session === leadId, name, working: name, duties, driver: false, colour: duties.includes('plan') ? 'planner' as const : engine };
  });
}

/**
 * A chat channel: Claude Code's or Codex's conversation drawn by Trace, with the person's images in the thread, formatted
 * replies, tool calls as cards with their results, and approvals as buttons. The CLI runs in structured mode in the
 * channel's folder with the channel's account, rules, memory and tools, as a terminal channel does. A chat that leads a
 * Round Table shows every agent at it in one thread, each labelled, and sends the person's messages to all of them. Its
 * other seats have no tile: this one shows how each is doing, starts them again when they stopped, can show a seat's own
 * conversation, and opens the setup panel to change the seats.
 */
export function ChatView({ session }: { session: Session }) {
  const chat = useChatStore((state) => state.threads[session.id] ?? EMPTY);
  const table = chat.table ?? null; const record = session.roundTable;
  /** A hierarchy table's seats take their steps in one thread: the planner and reviewers' messages join the builder's. */
  const hierarchy = table?.kind === 'hierarchy' || record?.kind === 'hierarchy';
  /** Every other seat while the table is open, or saved (after a restart, or while a seat is stopped), each once. */
  const hiddenKey = (table ? tableSeatIds(table, session.id) : record ? hiddenSeatIds(record, session.id) : []).join('|');
  const hiddenIds = useMemo(() => hiddenKey ? hiddenKey.split('|') : [], [hiddenKey]);
  // One selector for a variable number of seats (hooks cannot be called in a loop): arrays compared element by element, so only a seat that changed draws this again.
  const threads = useChatStore(useShallow((state) => hiddenIds.map((id) => state.threads[id] ?? EMPTY)));
  const hidden = useWorkspaceStore(useShallow((state) => hiddenIds.map((id) => state.sessions.find((item) => item.id === id && item.id !== session.id) ?? null)));
  const tokens = useHubStore(useShallow((state) => [session.id, ...hiddenIds].map((id) => channelToday(id, state.usage).tokens)));
  /** Whether each seat has any usage recorded: a Gemini CLI seat has none until its conversation's first request is read. */
  const measured = useHubStore(useShallow((state) => [session.id, ...hiddenIds].map((id) => state.usage.some((record) => record.sessionId === id))));
  /** This chat sits at another channel's table: it is written to from there. */
  const seatedAt = useChatStore((state) => Object.entries(state.threads).find(([, thread]) => thread.table?.partner.sessionId === session.id || thread.table?.planner?.sessionId === session.id || thread.table?.seats?.some((seat, index) => index > 0 && seat.sessionId === session.id))?.[0] ?? null);
  const channels = useWorkspaceStore((state) => state.sessions.length);
  const engine = session.config.engine === 'codex' ? 'codex' as const : 'claude' as const;
  const permissions: PermissionLevel = isAgentConfig(session.config) ? permissionLevel(session.config) : 'ask';
  const agent = AGENT[engine];
  const running = session.status === 'running' && session.runId !== null && chat.runId === session.runId;
  const busy = chat.busy || (table !== null && threads.some((thread) => thread.busy));
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  /** The seat whose own conversation the thread shows instead of the table's; the setup panel, when open. */
  const [shown, setShown] = useState<string | null>(null); const [setup, setSetup] = useState<SetupMode | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const input = useRef<HTMLTextAreaElement>(null); const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (viewing) dialog.current?.showModal(); else dialog.current?.close(); }, [viewing]);
  useLayoutEffect(() => { const area = input.current; if (area) { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 220) + 'px'; } }, [text]);

  const showable = hidden.some(Boolean);
  const plannerId = table?.planner?.sessionId ?? record?.planner ?? null; const plannerSession = hidden.find((item) => item?.id === plannerId) ?? null;
  const builderName = hierarchy ? modelName(isAgentConfig(session.config) ? session.config.model : '') : agent; const plannerName = modelName(plannerSession && isAgentConfig(plannerSession.config) ? plannerSession.config.model : '');
  /** Who sits at the table: from the open table, or as saved; a table from before 1.26 reads as its partner (and planner). */
  const views = useMemo(() => table ? seatViews(table, engine, { builder: builderName, planner: plannerName }, session.id) : record ? savedViews(useWorkspaceStore.getState().sessions, session.id) : [],
    [table, record, hidden, engine, builderName, plannerName, session.id]);
  const bySeat = new Map(hiddenIds.map((id, index) => [id, { thread: threads[index], session: hidden[index], tokens: tokens[index + 1], measured: measured[index + 1] }]));
  const leadSeat: SeatView = useMemo(() => (table ? views.find((view) => view.lead) : undefined) ?? { id: session.id, engine, lead: true, name: builderName, working: builderName, duties: [], driver: false, colour: engine }, [table, views, session.id, engine, builderName]);
  const seatSources: SeatThread[] = table ? views.map((view) => ({ seat: view, thread: view.lead ? chat : bySeat.get(view.id)?.thread ?? EMPTY })) : [{ seat: leadSeat, thread: chat }];
  /** At a table, every other seat's replies, approvals and notices join this thread in the order they came; Trace's prompts to it stay out. */
  const merged = useMergedThread(seatSources, hierarchy);
  // "Show a seat": its own conversation, Trace's messages to it included.
  const shownSeat = shown ? bySeat.get(shown) : undefined; const shownView = shown ? views.find((view) => view.id === shown) : undefined;
  const entries = useMemo(() => shownSeat?.session && shownView ? shownSeat.thread.items.map((item) => ({ item, seat: shownView, thread: shownSeat.thread })) : merged, [shownSeat?.thread.items, shownSeat?.session, shownView, merged]);
  // Follow new content while the person is at the bottom; scrolling up to read stops that.
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat, entries]);

  const attach = async (files: Blob[]) => {
    setError('');
    try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); }
    catch (e) { setError((e as Error).message); }
  };
  const send = async () => {
    // At a table a message may be written while the agents work: it goes to all of them once they finish their turn.
    if (!running || seatedAt || (chat.busy && !table) || (!text.trim() && !images.length) || !window.codingHub) return;
    // A hierarchy channel whose table is not open would send to the builder alone: the message stays in the box.
    const detachedWhy = hierarchyDetached(session.id); if (detachedWhy) { setError(detachedWhy); return; }
    const message = text.trim(); const attached = images;
    chatSent(session.id, message, attached, !hierarchy); setText(''); setImages([]); pinned.current = true;
    // A message that was not taken goes back in the box (unless something new was written meanwhile), so nothing is lost.
    const restore = () => { setText((current) => current || message); setImages((current) => current.length ? current : attached); };
    if (table) { const failure = await tableRequest(session.id, { action: 'table-send', text: message, images: attached }); if (failure) { chatFailed(session.id, failure); restore(); } return; }
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId: session.runId!, text: message, images: attached }).catch(() => null);
    if (!result?.ok) { chatFailed(session.id, result?.error.message ?? 'The message could not be delivered.'); restore(); }
  };
  const answerFor = (target: Session | null) => (requestId: string) => async (allow: boolean, allowEdits?: boolean) => {
    if (!target?.runId || !window.codingHub) return;
    const result = await window.codingHub.chat({ action: 'answer', sessionId: target.id, runId: target.runId, requestId, allow, ...(allowEdits ? { allowEdits } : {}) }).catch(() => null);
    if (result?.ok) chatAnswered(target.id, requestId, allow); else setError(result?.error.message ?? 'The answer could not be delivered.');
  };
  // Steady across renders, so a message that did not change is not drawn again (sameItem); an approval from any seat goes to that seat's run.
  const answerSeat = useSeatAnswers((seatId, requestId, allow, allowEdits) => answerFor(seatId === session.id ? session : hidden.find((item) => item?.id === seatId) ?? null)(requestId)(allow, allowEdits));
  const interrupt = () => { if (table) void tableRequest(session.id, { action: 'table-stop' }); else if (session.runId) void window.codingHub?.chat({ action: 'interrupt', sessionId: session.id, runId: session.runId }); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } };
  const onPaste = (event: ClipboardEvent) => { const files = [...event.clipboardData.files].filter((item) => item.type.startsWith('image/')); if (files.length) { event.preventDefault(); void attach(files); } };
  const onDrop = (event: DragEvent) => { const files = [...event.dataTransfer.files]; if (files.some((item) => item.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } };
  const others = views.filter((view) => !view.lead);
  /** A running hierarchy channel without its table open: why (and Reopen, when a seat can be started again). */
  const detached = running && !table && hierarchy && record ? hierarchyDetached(session.id) : null;
  /** The seats not running, which Reopen starts again (a seat whose channel is gone cannot be: the table must be closed). */
  const stopped = hidden.filter((item) => item && !live(item)); const missing = hiddenIds.length - hidden.filter(Boolean).length;
  const reopen = () => void reopenTable(session.id).then((failure) => { if (failure) setError(failure); });
  /** An open table is closed through the host, whose `closed` event forgets it (as from a phone); a saved one is forgotten here. */
  // The findings are saved to shared memory first; if that fails the table stays open, so nothing is lost.
  const closeTable = () => { void (async () => { const unsaved = await archiveFindings(session.id); if (unsaved) { setError(`${unsaved} The Round Table stays open; try Close again.`); return; } setShown(null); const failure = table ? await tableRequest(session.id, { action: 'table-close' }) : null; if (!table || failure) await forgetTable(session.id); })(); };
  const request = (action: Parameters<typeof tableRequest>[1]) => { if (action.action === 'table-close') { closeTable(); return; } void tableRequest(session.id, action).then((failure) => { if (failure) setError(failure); }); };
  const editSeats = running && !seatedAt ? () => setSetup({ type: 'edit', leadId: session.id }) : undefined;
  /** What each seat is doing (seatState) and its tokens today, for the bars. */
  const stateOf = (view: SeatView) => view.lead ? seatState(session, chat.busy) : bySeat.get(view.id)?.session ? seatState(bySeat.get(view.id)!.session!, bySeat.get(view.id)!.thread.busy) : 'not seated';
  const tokensOf = (view: SeatView) => view.lead ? tokens[0] : bySeat.get(view.id)?.tokens ?? 0;
  // Null: not measured. Gemini CLI's usage is read from its conversation's file, so a seat of its has nothing to show
  // until the first request is read (or ever, from a Trace before 1.30): that is "—" in the bar, and 0 is a counted zero.
  const barTokens = (view: SeatView) => view.engine === 'gemini' && !(view.lead ? measured[0] : bySeat.get(view.id)?.measured) ? null : tokensOf(view);
  const barSeats: BarSeat[] = views.map((view) => ({ ...view, ...(view.lead ? {} : { state: stateOf(view) }), tokens: barTokens(view) }));
  const seated = Boolean(table?.seats?.length || (!table && record?.seats?.length));
  /** The agent and model of a seat, when its name does not say it. */
  const detail = (view: SeatView) => { const config = (view.lead ? session : bySeat.get(view.id)?.session)?.config; const model = config && isAgentConfig(config) ? config.model : ''; return model ? (view.engine === 'claude' ? modelName(model) : model) : AGENT[view.engine]; };
  /** Who sits at a hierarchy table and what each is doing, so the bar shows every seat at work, not only the builder's tile. */
  const chainSeats: ChainSeat[] | undefined = hierarchy && views.length ? [...views.filter((view) => view.duties.includes('plan')), ...views.filter((view) => view.duties.includes('build')), ...views.filter((view) => !view.duties.includes('plan') && !view.duties.includes('build'))]
    .map((view) => ({ id: view.id, role: view.role ?? '', ...(seated ? { detail: detail(view) } : {}), name: view.name, colour: view.colour, state: stateOf(view), tokens: tokensOf(view) })) : undefined;
  const workers = table ? views.filter((view) => view.lead ? chat.busy : bySeat.get(view.id)?.thread.busy).map((view) => view.working) : [agent];
  /** The permission select's title: the same level at every seat of the table; only the builder or driver edits. */
  const driverName = views.find((view) => view.driver)?.name;
  const tableNote = !table ? '' : !table.seats?.length
    ? ` The same for ${AGENT[table.partner.engine]}${table.planner ? ' and the planner' : ''} at this table; ${table.planner ? 'the reviewer and planner stay' : 'the reviewer stays'} read-only.${table.planner ? ' At Full access they run commands without asking.' : ''}`
    : ` The same for every agent at this table (${joinNames(others.map((view) => view.name))}); ${hierarchy ? 'only the builder edits and the others stay read-only. At Full access they run commands without asking.' : `only ${driverName ?? 'the driver'} edits and the others stay read-only.`}`;
  const everyone = views.length > 2 ? `all ${views.length} agents` : joinNames(views.map((view) => view.name));
  /**
   * The message box's hint, then shorter forms for a narrow tile (useHint). The last of each fits the box of the
   * smallest four-tile grid: about 110 px beside the Round Table button, 158 px at a table.
   */
  const hints = !running ? ['Start the channel to chat', 'Start to chat'] : seatedAt ? ['This chat is at a Round Table: write in the Round Table channel', 'Write in the Round Table channel', 'At a Round Table'] : table && hierarchy ? (table.chain?.step === 'plan-review' ? ['Say what to change in the plan, or Approve plan', 'What to change in the plan', 'Plan changes'] : (table.chain?.step === 'stopped' || table.chain?.step === 'needs-you') && table.chain.task ? ['Reply to go on with this task (a new task starts once it is done)', 'Reply to go on with this task', 'Reply to go on'] : ['Give the Round Table a task (Enter to send)', 'Give the Round Table a task', 'Give it a task']) : table ? [`Message ${everyone} (Enter to send)`, `Message ${everyone}`, views.length > 2 ? 'Message all' : 'Message both'] : chat.busy ? [`${agent} is working. You can write your next message.`, 'Write your next message', 'Next message'] : [`Message ${agent} (Enter to send, Shift+Enter for a new line)`, `Message ${agent} (Enter to send)`, `Message ${agent}`, 'Message'];
  const placeholder = useHint(input, hints);
  /** A saved table's stub, drawn by the hierarchy bar with no host behind it: its seats as saved (a table before 1.26 as its partner and planner). */
  const savedTable = !table && hierarchy && record ? { kind: 'hierarchy' as const, partner: { sessionId: record.partner, runId: '', engine: 'codex' as const }, driver: 'claude' as const, rounds: record.rounds, round: 0, phase: 'idle' as const, agreed: false,
    ...(record.seats?.length ? { seats: seatsOf(useWorkspaceStore.getState().sessions, session.id).map(({ seat, session: found }) => ({ sessionId: seat.session, runId: '', engine: found?.config.engine === 'codex' ? 'codex' as const : 'claude' as const, ...(seat.name ? { name: seat.name } : {}), ...(seat.duties ? { duties: seat.duties } : {}) })) } : {}),
    ...(record.chain ? { chain: record.chain } : {}), ...(record.findings ? { findings: record.findings } : {}) } : null;

  return <div className={`chat-view ${table ? 'at-table' : ''}`} data-chat-session={session.id} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
    {table && hierarchy && <ChainBar table={table} busy={busy} seats={chainSeats} plannerName={plannerName} builderName={builderName} onSeats={editSeats} onRequest={request} />}
    {table && !hierarchy && <TableBar leadEngine={engine} table={table} busy={busy} seats={barSeats} showing={shownSeat?.session ? shown : null} onShow={showable ? setShown : undefined} onSeats={editSeats} onRequest={request} />}
    {savedTable && <ChainBar table={savedTable} busy={false} seats={chainSeats} plannerName={plannerName} builderName={builderName} onSeats={editSeats} onRequest={(action) => { if (action.action === 'table-close') closeTable(); }} detached={detached ? { note: detached, ...(!missing && stopped.length ? { onReopen: reopen } : {}) } : undefined} />}
    {!table && !hierarchy && record && showable && <div className="table-bar" role="group" aria-label="Round Table">
      <span className="table-seats" aria-hidden="true"><i className="seat-you" />{views.map((view) => <i key={view.id} className={`seat-${view.colour}`} />)}</span>
      <strong>Round Table</strong>
      {others.map((view) => { const found = bySeat.get(view.id)?.session; return <span key={view.id} className="table-partner" title={found?.error ?? undefined}><b className={`seat-text-${view.colour}`}>{view.name}</b> {stateOf(view)}</span>; })}
      <span className="table-status" aria-live="polite">{!running ? `${joinNames(others.map((view) => view.name))} ${others.length === 1 ? 'starts' : 'start'} with this channel` : missing ? 'A seat is gone: close the Round Table to chat with this agent alone' : stopped.length ? `Reopen to talk to ${others.length === 1 ? 'both' : 'everyone'} again` : hidden.every((item) => item?.status === 'running') ? 'Seating again…' : ''}</span>
      {running && !missing && stopped.length > 0 && <button className="quiet-button small" onClick={reopen}>Reopen</button>}
      {editSeats && <button className="quiet-button small" title="Add or remove agents, and change their names, instructions and models" onClick={editSeats}><Settings2 size={13} /><span className="table-label">Seats</span></button>}
      {showable && others.length === 1 && bySeat.get(others[0].id)!.thread.items.length > 0 && <button className="quiet-button small" aria-pressed={shown !== null} title={shown !== null ? 'Back to the Round Table thread' : `${others[0].name}'s own conversation, with what Trace passed to it`} onClick={() => setShown(shown ? null : others[0].id)}><MessagesSquare size={13} /><span className="table-label">{shown ? 'Back to the table' : `Show ${others[0].name}`}</span></button>}
      {showable && others.length > 1 && <label className="table-rounds" title="One agent's own conversation, with what Trace passed to it"><span className="table-label">Show</span><select aria-label="Show an agent's own conversation" value={shownSeat?.session ? shown ?? '' : ''} onChange={(event) => setShown(event.target.value || null)}><option value="">Round Table thread</option>{others.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label>}
      <button className="quiet-button small" aria-label="Close the Round Table" title={`Close the Round Table and stop ${others.length === 1 ? others[0].name : 'its other agents'}`} onClick={closeTable}><X size={13} /></button>
    </div>}
    {shownSeat?.session && shownView && <p className="table-seated" role="note">{shownView.name}'s own conversation, with what Trace passed to it. Your messages still go to the Round Table.</p>}
    {seatedAt && <p className="table-seated" role="note">At a Round Table: this chat answers there, and you write to it in that channel.</p>}
    <div className="chat-thread" ref={scroller} onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }} role="log" aria-label="Conversation" aria-live="polite">
      {!entries.length && <div className="chat-empty"><MessagesSquare aria-hidden="true" />{running ? <><strong>No messages yet</strong><p>Ask {agent} about this project. Paste or drop screenshots to include them.</p></> : <><strong>{agent} is not running</strong><p>Start the channel to chat with {agent} in this folder.</p></>}</div>}
      <ThreadItems entries={entries} table={table !== null || Boolean(shownSeat?.session && shownView)} answerFor={answerSeat} view={setViewing} />
      {busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>{workingText(workers)}</p>}
    </div>
    <div className="chat-composer">
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button className="chat-icon" aria-label="Attach images" title="Attach images (or paste or drop them)" disabled={!running || Boolean(seatedAt)} onClick={() => file.current?.click()}><ImagePlus size={16} /></button>
        {!table && !seatedAt && !showable && <button className="chat-icon" aria-label="Round Table: add agents" title={channels >= MAX_CHANNELS ? TABLE_FULL : 'Round Table: bring other agents into this conversation, in this channel'} disabled={!running || channels >= MAX_CHANNELS} onClick={() => setSetup({ type: 'chat', leadId: session.id })}><Users size={16} /></button>}
        {!seatedAt && isAgentConfig(session.config) && <select className={`chat-permissions ${permissions}`} aria-label="Permissions" title={`${permissionHelp(engine, permissions)}${tableNote}`} value={permissions} onChange={(event) => void setPermissions(session.id, event.target.value as PermissionLevel).then((failure) => setError(failure ?? ''))}>
          {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
        </select>}
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea ref={input} rows={1} value={text} disabled={!running || Boolean(seatedAt)} placeholder={placeholder} aria-label={table ? 'Message to the Round Table' : `Message to ${agent}`} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        {busy && !text.trim()
          ? <button className="chat-icon stop" aria-label={table ? `Stop ${views.length > 2 ? 'all' : 'both'} agents` : `Stop ${agent}'s reply`} title={table ? `Stop ${views.length > 2 ? 'all' : 'both'} agents and the discussion` : `Stop the reply (${agent} keeps what it has done)`} onClick={interrupt}><Square size={14} /></button>
          : <button className="chat-icon send" aria-label="Send" disabled={!running || Boolean(seatedAt) || (!text.trim() && !images.length) || (chat.busy && !table)} onClick={() => void send()}><Send size={16} /></button>}
      </div>
    </div>
    <dialog ref={dialog} className="pasted-viewer" onClose={() => setViewing(null)} onClick={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
      {viewing && <><header><span>Image</span><button className="icon-button" aria-label="Close image" onClick={() => setViewing(null)}><X size={14} /></button></header><img src={viewing} alt="" /></>}
    </dialog>
    {setup && <TableSetup mode={setup} onClose={() => setSetup(null)} />}
  </div>;
}
