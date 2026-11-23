import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeftRight, Asterisk, ChevronDown, ChevronRight, MessagesSquare, Settings2, Sparkle, Square, TerminalSquare, User, X } from 'lucide-react';
import type { Finding } from '../../../shared/findings';
import { isTracePrompt, late, waitingImageCount, type ChatBlock, type ChatImage, type PlanChallenge, type RoundTableState } from '../../../shared/chat';
import type { ChatItem, ChatThread, ToolResult } from '../../state/chat-store';
import type { Session } from '../../../shared/types';
import { Markdown } from './Markdown';
import type { SeatDuty } from '../../../shared/table-seats';
import { joinNames, seatViews, type SeatColour, type SeatView } from './seat-view';
import { SIGNAL_INSTRUCTION } from '../../../shared/task-signal';

/**
 * The parts of a chat thread shared by the desktop's chat channels and the phone: messages, tool cards, approvals and
 * a Round Table's bar. They draw what they are given and report what the person does; sending it is the caller's.
 */
export const EMPTY: ChatThread = { runId: null, items: [], results: {}, busy: false, model: null };
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Claude accepts images up to about 5 MB; larger ones (and other formats) are redrawn as JPEG, at most 2000 px. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

export function readImage(file: Blob): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => {
      const url = String(reader.result); const data = url.slice(url.indexOf(',') + 1);
      if (SUPPORTED.includes(file.type) && data.length * 0.75 <= MAX_IMAGE_BYTES) { resolve({ mediaType: file.type as ChatImage['mediaType'], data }); return; }
      const image = new Image();
      image.onerror = () => reject(new Error('That file is not an image Trace can send.'));
      image.onload = () => {
        const scale = Math.min(1, 2000 / Math.max(image.width, image.height)); const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
        const jpeg = canvas.toDataURL('image/jpeg', 0.85); resolve({ mediaType: 'image/jpeg', data: jpeg.slice(jpeg.indexOf(',') + 1) });
      };
      image.src = url;
    };
    reader.readAsDataURL(file);
  });
}

/** One line saying what a tool call does: the command, the file, the search, the address. */
/** `input` may be missing or not an object in an event from a linked computer on another version: read as none. */
function toolSummary(name: string, given: unknown) {
  const input: Record<string, unknown> = given && typeof given === 'object' ? given as Record<string, unknown> : {};
  const value = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  const short = (path: string) => path.split(/[\\/]/).slice(-3).join('/');
  if (name === 'Bash') return value('command');
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return short(value('file_path') || value('notebook_path'));
  if (name === 'Grep') return `${value('pattern')}${value('path') ? ` in ${short(value('path'))}` : ''}`;
  if (name === 'Glob') return value('pattern');
  if (name === 'WebFetch') return value('url');
  if (name === 'WebSearch') return value('query');
  if (name === 'Task' || name === 'Agent') return value('description');
  if (name === 'TodoWrite') return 'updates the task list';
  return Object.values(input).find((item): item is string => typeof item === 'string')?.slice(0, 120) ?? '';
}

export function ToolCard({ block, result }: { block: Extract<ChatBlock, { type: 'tool' }>; result?: ToolResult }) {
  // A block from a linked computer on another version may come without its input: shown as none rather than failing.
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const summary = toolSummary(block.name, input);
  const edit = block.name === 'Edit' && typeof input.old_string === 'string' ? input : null;
  return <details className={`chat-tool ${result?.isError ? 'error' : ''} ${result ? 'done' : 'running'}`}>
    <summary><ChevronRight size={13} className="chat-chevron" aria-hidden="true" /><strong>{block.name}</strong><span className="chat-tool-summary" title={summary}>{summary}</span><span className="chat-tool-state">{!result ? 'running…' : result.isError ? 'failed' : 'done'}</span></summary>
    {edit && <div className="chat-diff"><pre className="removed">{String(edit.old_string)}</pre><pre className="added">{String(edit.new_string ?? '')}</pre></div>}
    {!edit && block.name !== 'Bash' && <pre className="chat-tool-input">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>}
    {result && (result.text || result.image) && <pre className="chat-tool-output">{result.text || '(an image)'}</pre>}
  </details>;
}

export function Permission({ item, agent, answer }: { item: Extract<ChatItem, { kind: 'permission' }>; agent: string; answer: (allow: boolean, allowEdits?: boolean) => void }) {
  const summary = toolSummary(item.toolName, item.input);
  return <div className={`chat-permission ${item.answer ?? 'open'}`} role={item.answer ? undefined : 'alert'}>
    <p><strong>{agent} wants to use {item.toolName}</strong>{item.description && item.description !== summary ? ` · ${item.description}` : ''}</p>
    {summary && <pre>{summary}</pre>}
    {item.answer ? <p className="chat-permission-answer">{item.answer === 'allowed' ? 'Allowed' : item.answer === 'denied' ? 'Denied' : 'No longer waiting'}</p>
      : <div className="chat-permission-actions">
        <button className="button primary" onClick={() => answer(true)}>Allow</button>
        {item.canAllowEdits && (agent === 'Codex'
          ? <button className="button secondary" title="Allow this kind of action without asking for the rest of this session" onClick={() => answer(true, true)}>Allow for this session</button>
          : <button className="button secondary" title="Let Claude edit files without asking for the rest of this run" onClick={() => answer(true, true)}>Allow edits this run</button>)}
        <button className="button secondary" onClick={() => answer(false)}>Deny</button>
      </div>}
  </div>;
}

export const AGENT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const;
const PHASE = (many: boolean): Record<RoundTableState['phase'], string> => ({ joining: many ? 'Catching the others up' : 'Catching the other agent up', answering: many ? 'All answering' : 'Both answering', discussing: 'Discussing', acting: 'Making the changes', idle: 'Your turn' });

export interface ItemProps { item: ChatItem; results: Record<string, ToolResult>; agent: string; author?: 'claude' | 'codex' | 'gemini' | 'planner'; answer: (requestId: string) => (allow: boolean, allowEdits?: boolean) => void; view: (url: string) => void; role?: string }
/**
 * Whether a message would draw the same: the store keeps a settled item's object while another streams, and the tool
 * results that matter are its own tool calls'. So a streamed piece, a keystroke in the message box or another channel's
 * change draws again only the message it touches, not every message's Markdown.
 */
export function sameItem(before: ItemProps, after: ItemProps) {
  if (before.item !== after.item || before.agent !== after.agent || before.author !== after.author || before.role !== after.role || before.answer !== after.answer || before.view !== after.view) return false;
  const item = after.item;
  return before.results === after.results || item.kind !== 'assistant' || item.blocks.every((block) => block.type !== 'tool' || before.results[block.id] === after.results[block.id]);
}
/**
 * A function whose identity never changes and which calls the latest `fn`: answer handlers built in render stay the
 * same for sameItem, and still use the run that is current when the person answers.
 */
export function useSteady<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn); latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}

/** One seat's conversation, as the thread merges it. */
export interface SeatThread { seat: SeatView; thread: ChatThread }
export interface ThreadEntry { item: ChatItem; seat: SeatView; thread: ChatThread }
/**
 * A table's thread: the lead's items with every other seat's, in the order they came. Trace's prompts to the other seats
 * stay out (their `user` items); `hideTracePrompts` keeps them out of the lead's items too (a hierarchy: the person's own
 * messages show, at their order).
 */
export function mergeThread(sources: SeatThread[], hideTracePrompts = false): ThreadEntry[] {
  return sources.flatMap(({ seat, thread }) => thread.items.filter((item) => seat.lead ? !hideTracePrompts || item.kind !== 'user' || !isTracePrompt(item.text) : item.kind !== 'user').map((item) => ({ item, seat, thread })))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
}
/** mergeThread, kept while no seat's items changed: a keystroke or a status change does not merge and sort the whole thread again. */
export function useMergedThread(sources: SeatThread[], hideTracePrompts = false): ThreadEntry[] {
  const last = useRef<{ key: unknown[]; value: ThreadEntry[] } | null>(null);
  const key = [hideTracePrompts, ...sources.flatMap(({ seat, thread }) => [thread.items, seat.id, seat.name, seat.role, seat.colour, seat.lead])];
  if (!last.current || last.current.key.length !== key.length || last.current.key.some((value, index) => !Object.is(value, key[index]))) last.current = { key, value: mergeThread(sources, hideTracePrompts) };
  return last.current.value;
}
/** What answers an approval card: the seat it came from, the request and the person's choice. */
export type SeatAnswer = (seatId: string, requestId: string, allow: boolean, allowEdits?: boolean) => unknown;
/**
 * Each seat's answer handler (ItemProps.answer), the same function for a seat every time and calling the latest `answer`,
 * so sameItem still holds while the approval of any seat is answerable.
 */
export function seatAnswers(latest: { current: SeatAnswer }) {
  const made = new Map<string, ItemProps['answer']>();
  return (seatId: string): ItemProps['answer'] => { let handler = made.get(seatId); if (!handler) { handler = (requestId) => (allow, allowEdits) => { void latest.current(seatId, requestId, allow, allowEdits); }; made.set(seatId, handler); } return handler; };
}
export function useSeatAnswers(answer: SeatAnswer) {
  const latest = useRef(answer); latest.current = answer;
  const getter = useRef<ReturnType<typeof seatAnswers>>(); getter.current ??= seatAnswers(latest);
  return getter.current;
}
/** A table's messages, each labelled with its seat's name and what it does there; the person's own say You. */
export function ThreadItems({ entries, table, answerFor, view }: { entries: ThreadEntry[]; table: boolean; answerFor: (seatId: string) => ItemProps['answer']; view: (url: string) => void }) {
  return <>{entries.map(({ item, seat, thread }) => <Item key={seat.lead ? item.id : `${seat.id}-${item.id}`} item={item} results={thread.results} agent={seat.name} author={table ? seat.colour : undefined} role={table ? seat.role : undefined} answer={answerFor(seat.id)} view={view} />)}</>;
}
/** The "… is working" line: who works now, from the seats that are busy. */
export const workingText = (names: readonly string[]) => `${joinNames(names)} ${names.length > 1 ? 'are' : 'is'} working`;

/**
 * The message box's hint, longest first: the first that fits the box's width, else the last. A text area's hint is cut
 * mid-letter with no ellipsis, so a narrow tile or the phone gets a shorter wording instead. Without ResizeObserver
 * (tests) the first stays.
 */
export function useHint(field: RefObject<HTMLTextAreaElement>, hints: string[]) {
  const key = hints.join('\n'); const [shown, setShown] = useState(0);
  useLayoutEffect(() => {
    const area = field.current; setShown(0); if (!area || hints.length < 2 || typeof ResizeObserver === 'undefined') return;
    const context = document.createElement('canvas').getContext('2d'); if (!context) return; let live = true;
    const measure = () => {
      if (!live) return; const style = getComputedStyle(area); const room = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // Hidden (a tab not shown): nothing to measure yet.
      if (room <= 0) return;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const fits = hints.findIndex((hint) => context.measureText(hint).width <= room); setShown(fits < 0 ? hints.length - 1 : fits);
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(area);
    // The interface font may arrive after the first measure.
    void document.fonts?.ready.then(measure);
    return () => { live = false; observer.disconnect(); };
  }, [key]);
  return hints[Math.min(shown, hints.length - 1)];
}

/** A seat's avatar glyph: the person, or the engine's mark as on its tile (a planner is a Claude model). */
const SEAT_ICON = { you: User, claude: Asterisk, planner: Asterisk, codex: TerminalSquare, gemini: Sparkle } as const;
function SeatAvatar({ seat }: { seat: keyof typeof SEAT_ICON }) { const Icon = SEAT_ICON[seat]; return <i className={`seat-hex seat-${seat}`} aria-hidden="true"><Icon /></i>; }

/** One message, approval or notice in a thread; `author` labels it in a Round Table. */
/** At a Round Table: `role` labels an agent's messages (driver or reviewer), and the person's messages say You. */
export const Item = memo(function Item({ item, results, agent, author, answer, view, role }: ItemProps) {
  if (item.kind === 'user') return <div className={`chat-message user ${author ? 'table-you' : ''}`}>
    {author && <p className="chat-author"><SeatAvatar seat="you" />You</p>}
    {item.images.length > 0 && <div className="chat-images">{item.images.map((url, index) => <button key={index} className="chat-image" aria-label={`Enlarge image ${index + 1}`} onClick={() => view(url)}><img src={url} alt="" /></button>)}</div>}
    {item.text && <p className="chat-user-text">{item.text}</p>}
  </div>;
  if (item.kind === 'assistant') return <div className={`chat-message assistant ${author ? `table-${author}` : ''}`}>
    {author && <p className="chat-author"><SeatAvatar seat={author} />{agent}{role ? ` · ${role === 'driver' ? 'Driver' : role === 'reviewer' ? 'Review' : role}` : ''}</p>}
    {item.blocks.map((block, index) => block.type === 'text' ? <Markdown key={index} text={block.text} />
      : block.type === 'thinking' ? <details key={index} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>
        // Only tool calls are drawn as cards: a kind of block this version does not know (a newer linked computer's) is left out.
        : block.type === 'tool' ? <ToolCard key={block.id ?? index} block={block} result={results[block.id]} /> : null)}
    {item.streaming && <div className="chat-streaming"><Markdown text={item.streaming} /></div>}
  </div>;
  // Resolved at the click, so the handler (steady, see useSteady) uses the run current then, not at this draw.
  if (item.kind === 'permission') return <Permission item={item} agent={agent} answer={(allow, allowEdits) => answer(item.id)(allow, allowEdits)} />;
  return <p className={`chat-notice ${item.error ? 'error' : ''}`}>{author ? `${agent}: ` : ''}{item.text}</p>;
}, sameItem);

/** How a Round Table's hidden partner is doing, in a few words for the table bar (it has no tile of its own). */
export function seatState(partner: Pick<Session, 'status' | 'error'> & { attention?: Session['attention'] }, busy: boolean) {
  if (partner.status === 'running') return partner.attention ? 'needs approval' : busy ? 'working' : 'running';
  if (partner.status === 'starting') return 'starting';
  return partner.status === 'error' || partner.error ? 'stopped with an error' : 'stopped';
}

/** The controls of a Round Table: who sits there and who drives, how many rounds, where it is, Seats, stop and close. */
export type TableAction = { action: 'table-waiting'; send: boolean } | { action: 'table-driver'; driver: 'claude' | 'codex'; seat?: string } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
const short = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
/** A seat as the bar shows it: `state` (seatState) for a seat that has no tile, and its new tokens today, when the caller has them (the desktop does). */
export interface BarSeat extends SeatView { state?: string; tokens?: number }
/**
 * `seats`: who sits there, with how each is doing and its tokens (the desktop); without them the bar reads the table (a
 * phone, a linked computer). `onShow` (the desktop, where hidden seats have no tile) switches the thread to a seat's own
 * conversation, `showing` is that seat's id; `onSeats` opens the seat editor (not on a phone or linked computer).
 */
export function TableBar({ leadEngine, table, busy, onRequest, seats: given, showing = null, onShow, onSeats }: { leadEngine: 'claude' | 'codex'; table: RoundTableState; busy: boolean; onRequest: (request: TableAction) => void; seats?: BarSeat[]; showing?: string | null; onShow?: (seat: string | null) => void; onSeats?: () => void }) {
  const seats: BarSeat[] = given ?? seatViews(table, leadEngine); const many = seats.length > 2;
  const driver = seats.find((seat) => seat.driver) ?? seats[0]; const others = seats.filter((seat) => seat !== driver); const hidden = seats.filter((seat) => !seat.lead);
  const run = onRequest; const images = waitingImageCount(table); const counted = seats.filter((seat) => seat.tokens !== undefined);
  const status = table.phase === 'discussing' ? `Round ${table.round} of ${table.rounds}` : table.phase === 'acting' ? `${driver.name} making the changes` : table.phase === 'idle' && table.agreed ? (many ? 'They all agree. Your turn' : 'They agree. Your turn') : PHASE(many)[table.phase];
  // In a narrow tile the token counts, then who drives, leave the bar (chat.css): there they are this tooltip, and still read out.
  // Narrower still, Rounds, Stop and Show keep only their field or icon, and then the title leaves: their words stay their names,
  // and each has a tooltip, as every control that shows only an icon has.
  const roles = `${driver.name} drives · ${joinNames(others.map((seat) => seat.name))} ${others.length === 1 ? 'reviews' : 'review'}`;
  const about = counted.length ? `${roles}. New tokens today: ${counted.map((seat) => `${seat.name} ${short(seat.tokens!)}`).join(' · ')}` : roles;
  const swap = others[0]; const swapEngine = swap && swap.engine !== 'gemini' ? swap.engine : null; const stopAll = many ? 'all' : 'both';
  // Grouped, so a narrow tile wraps whole groups (who sits there; how the others are doing; who drives and Rounds; where it is and its buttons), never one control alone.
  return <div className="table-bar" role="group" aria-label="Round Table">
    <span className="table-group" title={about}>
      <span className="table-seats" aria-hidden="true"><i className="seat-you" />{seats.map((seat, index) => <i key={index} className={`seat-${seat.colour}`} />)}</span>
      <strong>Round Table</strong>
      <span className="table-roles">{roles}</span></span>
    {(hidden.some((seat) => seat.state) || counted.length > 0) && <span className="table-group">
      {hidden.map((seat) => seat.state && <span key={seat.id} className={`table-partner ${seat.state === 'needs approval' ? 'waiting' : ''}`} title={`${seat.name} runs in the background in this channel`}><b className={`seat-text-${seat.colour}`}>{seat.name}</b> {seat.state}</span>)}
      {counted.length > 0 && <span className="table-tokens tnum" title="New tokens today in each agent's channel">{counted.map((seat, index) => <Fragment key={seat.id || index}>{index > 0 && ' · '}<b className={`seat-text-${seat.colour}`}>{seat.name} {short(seat.tokens!)}</b></Fragment>)}</span>}</span>}
    <span className="table-group">
      {!many && swap && swapEngine && <button className="quiet-button small" title={`Let ${swap.name} edit files and make ${driver.name} the reviewer`} onClick={() => run({ action: 'table-driver', driver: swapEngine, ...(table.seats && swap.id ? { seat: swap.id } : {}) })}><ArrowLeftRight size={13} /><span className="table-swap">Swap</span></button>}
      {many && <label className="table-rounds" title="The agent that edits files; the others review and stay read-only"><span className="table-label">Edits files</span><select aria-label="Agent that edits files" value={driver.id} onChange={(event) => { const next = seats.find((seat) => seat.id === event.target.value); if (next && next.engine !== 'gemini') run({ action: 'table-driver', driver: next.engine, seat: next.id }); }}>{seats.filter((seat) => seat.engine !== 'gemini').map((seat) => <option key={seat.id} value={seat.id}>{seat.name}</option>)}</select></label>}
      <label className="table-rounds" title={`Rounds: how many times each agent replies to the ${many ? 'others' : 'other'}`}><span className="table-label">Rounds</span><select value={table.rounds} onChange={(event) => run({ action: 'table-rounds', rounds: Number(event.target.value) })}>{[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
      {onSeats && <button className="quiet-button small" disabled={busy} title={busy ? 'Seats can be changed when the Round Table is not working' : 'Add or remove agents, and change their names, instructions and models'} onClick={onSeats}><Settings2 size={13} /><span className="table-label">Seats</span></button>}</span>
    <span className="table-group table-end">
      {/* Who is making the changes leaves a narrow bar (chat.css), so the status still fits its second line; it is still read out. */}
      <span className="table-status" aria-live="polite">{table.phase === 'acting' ? <><span className="table-acting-who">{driver.name} </span><span className="table-acting-what">making the changes</span></> : status}</span>
      {busy && <button className="button danger small" title={`Stop ${stopAll} agents and the discussion`} onClick={() => run({ action: 'table-stop' })}><Square size={12} /><span className="table-label">Stop {stopAll}</span></button>}
      {onShow && hidden.length === 1 && <button className="quiet-button small" aria-pressed={showing !== null} title={showing !== null ? 'Back to the Round Table thread' : `${hidden[0].name}'s own conversation, with what Trace passed to it`} onClick={() => onShow(showing !== null ? null : hidden[0].id)}><MessagesSquare size={13} /><span className="table-label">{showing !== null ? 'Back to the table' : `Show ${hidden[0].name}`}</span></button>}
      {onShow && hidden.length > 1 && <label className="table-rounds" title="One agent's own conversation, with what Trace passed to it"><span className="table-label">Show</span><select aria-label="Show an agent's own conversation" value={showing ?? ''} onChange={(event) => onShow(event.target.value || null)}><option value="">Round Table thread</option>{hidden.map((seat) => <option key={seat.id} value={seat.id}>{seat.name}</option>)}</select></label>}
      <button className="quiet-button small" aria-label="Close the Round Table" title={`Close the Round Table and stop ${hidden.length === 1 ? hidden[0].name : 'its other agents'}`} onClick={() => run({ action: 'table-close' })}><X size={13} /></button></span>
    {(table.waiting !== undefined) && <span className="table-waiting" role="status">{table.waitingKept ? 'Kept from before Trace restarted: ' : 'Waiting to go: '}<q>{table.waiting.length > 80 ? table.waiting.slice(0, 80) + '…' : table.waiting}</q>{images ? ` + ${images} ${images === 1 ? 'image' : 'images'}` : ''}{table.waitingImagesDropped ? ` (its ${table.waitingImagesDropped} ${table.waitingImagesDropped === 1 ? 'image is' : 'images are'} too large to keep through a restart)` : ''}{table.waitingKept && <><button className="quiet-button small" onClick={() => run({ action: 'table-waiting', send: true })}>Send now</button><button className="quiet-button small" onClick={() => run({ action: 'table-waiting', send: false })}>Drop it</button></>}</span>}
    {table.findings && table.findings.length > 0 && <FindingsList findings={table.findings} />}
  </div>;
}

const STATUS_LABEL: Record<Finding['status'], string> = { open: 'Open', fixed: 'Fixed, not checked', declined: 'Declined, not checked', verified: 'Verified' };
/** The review record: each finding, its evidence, the driver's answer and the reviewer's check, and the files it was reviewed and answered on. */
function FindingsList({ findings }: { findings: Finding[] }) {
  const open = findings.filter((finding) => finding.status === 'open').length; const unchecked = findings.filter((finding) => finding.status === 'fixed' || finding.status === 'declined').length;
  return <details className="table-findings"><summary>Findings · {open} open{unchecked ? ` · ${unchecked} to check` : ''} · {findings.length - open - unchecked} verified</summary>
    <ol>{findings.map((finding) => <li key={finding.id} className={`finding-${finding.status}`}><strong>{finding.id} · {finding.severity}</strong> {finding.text}{finding.evidence && <> <code>{finding.evidence}</code></>}
      <small>{STATUS_LABEL[finding.status]}{finding.response ? ` · Driver: ${finding.response}` : ''}{finding.check ? ` · Reviewer: ${finding.check}` : ''}{finding.reviewedAt ? ` · Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}` : ''}{finding.changedAt ? `, answered on ${finding.changedAt}` : ''}</small></li>)}</ol>
  </details>;
}


/** A Claude model as people call it: claude-fable-5-2 is Fable 5.2; anything else is shown as given, or as Claude. */
export function modelName(model: string) {
  const known = /^claude-(fable|opus|sonnet|haiku)-(\d+)-(\d+)/.exec(model.trim());
  return known ? `${known[1][0].toUpperCase()}${known[1].slice(1)} ${known[2]}.${known[3]}` : model.trim() || 'Claude';
}
const CHAIN_STEPS: { step: string; label: string; of: string[] }[] = [
  { step: 'plan', label: 'Plan', of: ['planning'] }, { step: 'challenge', label: 'Challenge', of: ['challenging', 'plan-responding'] }, { step: 'approve', label: 'Approve', of: ['plan-review'] }, { step: 'build', label: 'Build', of: ['implementing'] },
  { step: 'review', label: 'Review', of: ['reviewing'] }, { step: 'fix', label: 'Fix', of: ['fixing'] }, { step: 'final', label: 'Final review', of: ['final', 'final-fixing'] },
];
const ANSWER_LABEL = { accepted: 'Accepted', rejected: 'Rejected' } as const;
/** The challenges to the plan (Codex's, at the built-in table), each with the planner's answer: open while the plan waits for the person. */
function ChallengeList({ challenges, plannerName, label, open }: { challenges: PlanChallenge[]; plannerName: string; /** Whose challenges, when one seat challenges; null for several. */ label: string | null; open: boolean }) {
  return <details className="chain-challenges" open={open}><summary>{label ? `${label}'s challenges` : 'Challenges to the plan'} · {challenges.length}{challenges.some((item) => item.answer === 'accepted') ? ` · ${challenges.filter((item) => item.answer === 'accepted').length} accepted` : ''}</summary>
    <ol>{challenges.map((challenge) => <li key={challenge.id} className={challenge.answer ?? 'unanswered'}><strong>{challenge.id} · {challenge.severity}</strong> {challenge.text}
      <small>{challenge.answer ? `${plannerName}: ${ANSWER_LABEL[challenge.answer]}${challenge.reason ? `, ${challenge.reason}` : ''}` : `${plannerName} did not answer it`}</small></li>)}</ol>
  </details>;
}
/**
 * The bar of a hierarchy Round Table: where the task is among the steps this table has (plan, challenge, approve, build,
 * review, fix, final review; a table without challengers, reviewers or a final reviewer leaves those out) and, in a step
 * several seats take in turn, whose turn it is; the plan approval with the challenges and the planner's answers; Stop,
 * Continue and Continue without the challenge; the review rounds and Seats; findings and a kept message.
 */
/**
 * Where a message waiting at a hierarchy table (one not kept from before a restart) will go, as review-chain.ts sends it:
 * with the next step, or to the planner once the final review is reached.
 */
export function waitingLabel(table: RoundTableState, planner = 'the planner'): string {
  const chain = table.chain; const step = chain?.step ?? 'idle'; const finalRound = chain?.finalRound ?? 0;
  if (step === 'needs-you') return `Waiting (Send now sends it to ${planner}): `;
  if (step === 'stopped') return late({ finalRound }, chain?.stoppedAt) ? `Goes to ${planner} when you continue: ` : 'Goes with the step when you continue: ';
  if (step === 'final') return `Goes to ${planner} after the final review, or starts the next task if it approves: `;
  if (late({ finalRound }, step)) return `Goes to ${planner} as a follow-up: `;
  if (step === 'reviewing' || step === 'fixing') return `Goes with the next step, or to ${planner} if the final review is next: `;
  return 'Goes with the next step: ';
}
export function ChainBar({ table, busy, plannerName, builderName, onRequest, detached, seats, onSeats }: { table: RoundTableState; busy: boolean; plannerName: string; builderName: string; /** Each seat: who, what it does, what it is doing now, and its tokens today. */ seats?: ChainSeat[]; onRequest: (request: ChainAction) => void; /** Opens the seat editor (the desktop; not a phone or linked computer). */ onSeats?: () => void; /** The builder runs but the table is not open: why, and Reopen when its seats can be started again. */ detached?: { note: string; onReopen?: () => void } }) {
  const chain = table.chain; const step = chain?.step ?? 'idle'; const at = step === 'stopped' ? chain?.stoppedAt : step;
  // A table from before 1.26 has no seats: it is the fixed planner, builder and Codex reviewer, with every step.
  const full = !table.seats?.length; const views = seatViews(table, 'claude', { builder: builderName, planner: plannerName });
  const of = (duty: SeatDuty) => views.filter((view) => view.duties.includes(duty));
  const challengers = of('challenge'); const reviewers = of('review'); const finals = of('final');
  const plannerLabel = full ? plannerName : of('plan')[0]?.name ?? plannerName; const builderLabel = full ? builderName : of('build')[0]?.name ?? builderName;
  /** Whose turn a step is: the seat whose turn the host named, else every seat that takes it (they go one after another). */
  const turn = (list: SeatView[], fallback: string) => full ? fallback : list.find((view) => view.id === chain?.turnSeat)?.name ?? (list.length ? joinNames(list.map((view) => view.name)) : fallback);
  const challenger = turn(challengers, 'Codex'); const reviewer = turn(reviewers, 'Codex');
  const challengerLabel = full ? 'Codex' : challengers.length === 1 ? challengers[0].name : null; const finalName = full ? plannerName : finals[0]?.name;
  const steps = CHAIN_STEPS.filter((item) => full || (item.step === 'challenge' ? challengers.length > 0 : item.step === 'review' ? reviewers.length > 0 : item.step === 'fix' ? reviewers.length > 0 || at === 'fixing' : item.step === 'final' ? finals.length > 0 : true));
  const current = steps.findIndex((item) => at && item.of.includes(at));
  const challengeStopped = step === 'stopped' && chain?.stoppedAt === 'challenging';
  // A label, not instructions: at plan review, Approve plan sits beside it and the message box says to write what to change.
  const status = step === 'challenging' ? `${challenger} challenging the plan…` : step === 'plan-responding' ? `${plannerLabel} answering ${challengerLabel ? `${challengerLabel}'s` : 'the'} challenges…` : step === 'plan-review' && chain?.challenged && !chain.challenges?.length && !chain.note ? `${plannerLabel}'s plan is ready (${challengerLabel ?? 'the challengers'} raised no challenges)` : step === 'idle' ? 'Give it a task' : step === 'plan-review' ? `${plannerLabel}'s plan is ready${chain?.note ? ` (${chain.note})` : ''}` : step === 'done' ? (finalName ? `Approved by ${finalName}` : chain?.note || 'Done: the review rounds are over') : step === 'needs-you' ? (chain?.note || 'Needs you') : step === 'stopped' ? (table.stopping ? 'Stopping…' : `Stopped${chain?.note ? `: ${chain.note}` : ''}`) : step === 'reviewing' ? `${reviewer} reviewing (round ${chain?.reviewRound} of ${table.rounds})` : step === 'fixing' && chain?.verdict === 'changes' ? `${builderLabel} fixing what the final review found` : step === 'final-fixing' ? `${builderLabel} making the final review's changes` : step === 'planning' ? `${plannerLabel} writing the plan…` : step === 'implementing' ? `${builderLabel} building…` : step === 'fixing' ? `${builderLabel} fixing the review's findings…` : step === 'final' ? `${finalName ?? plannerLabel} giving the final review…` : `${steps[current]?.label ?? ''}…`;
  /** In a step several seats take in turn, the seat whose turn it is, beside the step's name. */
  const turnAt = (item: (typeof CHAIN_STEPS)[number]) => { const list = item.step === 'challenge' ? challengers : item.step === 'review' ? reviewers : []; return !full && list.length > 1 ? list.find((view) => view.id === chain?.turnSeat)?.name : undefined; };
  // Folded (ChainFold): what is running, then who sits at each level (planner first, then the builder, then the rest), on one line beside the step's buttons and Close (chain-act).
  const sitting = [...views.filter((view) => view.duties.includes('plan')), ...views.filter((view) => view.duties.includes('build')), ...views.filter((view) => !view.duties.includes('plan') && !view.duties.includes('build'))];
  const summary = <span className="chain-summary" aria-live="polite" title={`${detached ? detached.note : status} · ${full ? `planner ${plannerName}, builder ${builderName}, reviewer Codex` : sitting.map((view) => view.role ? `${view.name} (${view.role.toLowerCase()})` : view.name).join(', ')}`}>{detached ? detached.note : status}{sitting.map((view, index) => <Fragment key={view.id || index}><span aria-hidden="true">{index === 0 ? ' · ' : ' › '}</span><b className={`seat-text-${view.colour}`}>{view.name}</b></Fragment>)}</span>;
  return <ChainFold summary={summary}>
    <span className="table-seats" aria-hidden="true"><i className="seat-you" />{sitting.map((view, index) => <i key={index} className={`seat-${view.colour}`} />)}</span>
    <strong>Round Table · hierarchy</strong>
    <ol className="chain-steps" aria-label="Steps">{steps.map((item, index) => { const turnName = index === current ? turnAt(item) : undefined; return <li key={item.step} className={index === current ? 'current' : index < current || step === 'done' ? 'past' : ''} aria-current={index === current ? 'step' : undefined}>{turnName ? `${item.label} · ${turnName}` : item.label}</li>; })}</ol>
    <span className="table-status" aria-live="polite">{detached ? detached.note : status}</span>
    {detached?.onReopen && <button className="button primary small chain-act" onClick={detached.onReopen}>Reopen</button>}
    {step === 'plan-review' && <button className="button primary small chain-act" onClick={() => onRequest({ action: 'table-plan', approve: true, note: '' })}>Approve plan</button>}
    {!detached && step === 'stopped' && chain?.stoppedAt && !table.stopping && <button className="quiet-button small chain-act" onClick={() => onRequest({ action: 'table-continue' })}>Continue</button>}
    {!detached && challengeStopped && !table.stopping && <button className="quiet-button small chain-act" title={`Show the plan to you without ${challengerLabel ? `${challengerLabel}'s challenge` : 'the challenges'}`} onClick={() => onRequest({ action: 'table-continue', skipChallenge: true })}>Continue without the challenge</button>}
    {busy && <button className="button danger small chain-act" title="Stop the step that is running" onClick={() => onRequest({ action: 'table-stop' })}><Square size={12} /><span className="table-label">Stop</span></button>}
    {!full && reviewers.length > 0 && !detached && <label className="table-rounds" title="Review rounds: how many times the reviewers review and the builder fixes, before the final review"><span className="table-label">Review rounds</span><select aria-label="Review rounds" disabled={busy} value={table.rounds} onChange={(event) => onRequest({ action: 'table-rounds', rounds: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>}
    {onSeats && <button className="quiet-button small" disabled={busy} title={busy ? 'Seats can be changed when the Round Table is not working' : 'Add or remove agents, and change their names, duties, instructions and models'} onClick={onSeats}><Settings2 size={13} /><span className="table-label">Seats</span></button>}
    <button className="quiet-button small chain-act" aria-label="Close the Round Table" title={full ? 'Close the Round Table and stop its planner and reviewer' : 'Close the Round Table and stop its other agents'} onClick={() => onRequest({ action: 'table-close' })}><X size={13} /></button>
    {chain?.challenges && chain.challenges.length > 0 && <ChallengeList challenges={chain.challenges} plannerName={plannerLabel} label={challengerLabel} open={step === 'plan-review'} />}
    {table.waiting !== undefined && <span className="table-waiting" role="status">{table.waitingKept ? 'Kept from before Trace restarted: ' : waitingLabel(table, full ? undefined : plannerLabel)}<q>{table.waiting.length > 80 ? table.waiting.slice(0, 80) + '…' : table.waiting}</q>{table.waitingKept && <><button className="quiet-button small" onClick={() => onRequest({ action: 'table-waiting', send: true })}>Send now</button><button className="quiet-button small" onClick={() => onRequest({ action: 'table-waiting', send: false })}>Drop it</button></>}{chain?.held && <> ({chain.held})</>}{!table.waitingKept && step === 'needs-you' && <button className="quiet-button small" onClick={() => onRequest({ action: 'table-waiting', send: true })}>Send now</button>}{!table.waitingKept && (step === 'needs-you' || (step === 'stopped' && !table.stopping)) && <button className="quiet-button small" onClick={() => onRequest({ action: 'table-waiting', send: false })}>Drop it</button>}</span>}
    {chain?.nextTasks?.length ? <div className="table-waiting" role="status">{chain.nextTasks.length === 1 ? 'From Tasks, starts once this task is approved:' : `${chain.nextTasks.length} tasks from Tasks, starting one by one as each task before is approved:`}
      <ol className="chain-next-tasks">{chain.nextTasks.map((task, index) => { const shown = task.replace(SIGNAL_INSTRUCTION, '').trim(); return <li key={`${index}:${task.slice(0, 40)}`}><q>{shown.length > 80 ? shown.slice(0, 80) + '…' : shown}</q>{!detached && <button className="quiet-button small" aria-label={`Drop it: ${shown.slice(0, 60)}`} onClick={() => onRequest({ action: 'table-next-drop', index, head: task.slice(0, 200) })}>Drop it</button>}</li>; })}</ol></div> : null}
    {/* A seat's tokens leave the bar in a narrow tile too (chat.css): there they are its tooltip, and still read out. */}
    {seats && <ul className="chain-seats" aria-label="Seats">{seats.map((seat) => <li key={seat.id ?? seat.role} className={seat.state === 'working' ? 'working' : ''} title={seat.tokens ? `${short(seat.tokens)} new tokens today` : undefined}><i className={`seat-hex seat-${seat.colour}`} aria-hidden="true" /><strong>{seat.name}</strong><span>{[seat.role, seat.detail, seat.state].filter(Boolean).join(' · ')}{seat.tokens ? <span className="seat-tokens"> · {short(seat.tokens)} tok today</span> : null}</span></li>)}</ul>}
    {table.findings && table.findings.length > 0 && <FindingsList findings={table.findings} />}
  </ChainFold>;
}
/**
 * Whether a hierarchy bar folds to one line: when the whole bar (`full` px tall) would leave the conversation under it
 * less than half the tile. `room` is what the bar and the conversation take together now, folded or not.
 */
export function foldChainBar(full: number, room: number, tile: number) { return tile > 0 && room - full < tile / 2; }
/**
 * A hierarchy bar's box. In a channel tile too short for the whole bar (foldChainBar) it folds to the summary, the
 * step's buttons and Close, with a disclosure that opens the rest. Its height is measured unfolded on each draw and
 * resize, so it unfolds again when there is room. Not in a tile (the phone), it never folds.
 */
function ChainFold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null); const [folded, setFolded] = useState(false); const [open, setOpen] = useState(false);
  const parts = () => { const element = bar.current; const tile = element?.closest('.session-tile'); const thread = element?.parentElement?.querySelector(':scope > .chat-thread'); return element && tile && thread instanceof HTMLElement ? { element, tile, thread } : null; };
  const measure = useSteady(() => {
    const found = parts(); if (!found) return; const { element, tile, thread } = found;
    // The class is put back before anything is drawn, so the bar never shows unfolded for this.
    const now = element.offsetHeight; const was = element.classList.contains('folded'); element.classList.remove('folded'); const full = element.offsetHeight; if (was) element.classList.add('folded');
    const fold = foldChainBar(full, now + thread.offsetHeight, tile.getBoundingClientRect().height); setFolded(fold); if (!fold) setOpen(false);
  });
  useLayoutEffect(() => { measure(); });
  useLayoutEffect(() => { const found = parts(); if (!found || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(() => measure()); observer.observe(found.tile); observer.observe(found.thread); return () => observer.disconnect(); }, []);
  return <div ref={bar} className={`table-bar chain-bar${folded ? ' folded' : ''}${folded && open ? ' open' : ''}`} role="group" aria-label="Round Table">
    {folded && <span className="chain-fold">{summary}<button className="quiet-button small chain-fold-toggle" aria-expanded={open} aria-label="Round Table steps and controls" title="Round Table steps and controls" onClick={() => setOpen(!open)}><ChevronDown size={16} /></button></span>}
    {children}
  </div>;
}
/** One seat at a hierarchy table, for its bar. */
export interface ChainSeat { id?: string; role: string; /** The agent and model, when the seat's name does not say it. */ detail?: string; name: string; colour: SeatColour; state: string; tokens: number }
export type ChainAction = { action: 'table-plan'; approve: boolean; note: string } | { action: 'table-continue'; skipChallenge?: boolean } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' } | { action: 'table-waiting'; send: boolean } | { action: 'table-next-drop'; index: number; head: string };
