import { memo, useCallback, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronRight, Square, X } from 'lucide-react';
import type { Finding } from '../../../shared/findings';
import { HIERARCHY_MODELS, late, waitingImageCount, type ChatBlock, type ChatImage, type PlanChallenge, type RoundTableState } from '../../../shared/chat';
import type { ChatItem, ChatThread, ToolResult } from '../../state/chat-store';
import type { Session } from '../../../shared/types';
import { Markdown } from './Markdown';
import { isAgentConfig } from '../../../shared/types';
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

export const AGENT = { claude: 'Claude', codex: 'Codex' } as const;
const PHASE: Record<RoundTableState['phase'], string> = { joining: 'Catching the other agent up', answering: 'Both answering', discussing: 'Discussing', idle: 'Your turn' };

export interface ItemProps { item: ChatItem; results: Record<string, ToolResult>; agent: string; author?: 'claude' | 'codex' | 'planner'; answer: (requestId: string) => (allow: boolean, allowEdits?: boolean) => void; view: (url: string) => void; role?: string }
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

/** One message, approval or notice in a thread; `author` labels it in a Round Table. */
/** At a Round Table: `role` labels an agent's messages (driver or reviewer), and the person's messages say YOU. */
export const Item = memo(function Item({ item, results, agent, author, answer, view, role }: ItemProps) {
  if (item.kind === 'user') return <div className={`chat-message user ${author ? 'table-you' : ''}`}>
    {author && <p className="chat-author"><i className="seat-hex seat-you" aria-hidden="true" />You</p>}
    {item.images.length > 0 && <div className="chat-images">{item.images.map((url, index) => <button key={index} className="chat-image" aria-label={`Enlarge image ${index + 1}`} onClick={() => view(url)}><img src={url} alt="" /></button>)}</div>}
    {item.text && <p className="chat-user-text">{item.text}</p>}
  </div>;
  if (item.kind === 'assistant') return <div className={`chat-message assistant ${author ? `table-${author}` : ''}`}>
    {author && <p className="chat-author"><i className={`seat-hex seat-${author}`} aria-hidden="true" />{agent}{role ? ` · ${role === 'driver' ? 'Driver' : role === 'reviewer' ? 'Review' : role}` : ''}</p>}
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

/** The controls of a Round Table: who drives, how many rounds, where it is, stop and close. */
export type TableAction = { action: 'table-waiting'; send: boolean } | { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
const short = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
/**
 * `tokens`: each agent's new tokens today, when the caller has them (the desktop does). `partnerState` (seatState) and
 * `onShow` come from the desktop, where the partner has no tile: how it is doing, and a switch to its own conversation.
 */
export function TableBar({ leadEngine, table, busy, onRequest, tokens, partnerState, showing = false, onShow }: { leadEngine: 'claude' | 'codex'; table: RoundTableState; busy: boolean; onRequest: (request: TableAction) => void; tokens?: { lead: number; partner: number }; partnerState?: string; showing?: boolean; onShow?: () => void }) {
  const reviewer = table.driver === 'claude' ? 'codex' : 'claude';
  const run = onRequest; const images = waitingImageCount(table);
  const status = table.phase === 'discussing' ? `Round ${table.round} of ${table.rounds}` : table.phase === 'idle' && table.agreed ? 'They agree. Your turn' : PHASE[table.phase];
  return <div className="table-bar" role="group" aria-label="Round Table">
    <span className="table-seats" aria-hidden="true"><i className="seat-you" /><i className={`seat-${leadEngine}`} /><i className={`seat-${table.partner.engine}`} /></span>
    <strong>Round Table</strong>
    <span className="table-roles">{AGENT[table.driver]} drives · {AGENT[reviewer]} reviews</span>
    {partnerState && <span className={`table-partner ${partnerState === 'needs approval' ? 'waiting' : ''}`} title={`${AGENT[table.partner.engine]} runs in the background in this channel`}><b className={`seat-text-${table.partner.engine}`}>{AGENT[table.partner.engine]}</b> {partnerState}</span>}
    {tokens && <span className="table-tokens tnum" title="New tokens today in each agent's channel"><b className={`seat-text-${leadEngine}`}>{AGENT[leadEngine]} {short(tokens.lead)}</b> · <b className={`seat-text-${table.partner.engine}`}>{AGENT[table.partner.engine]} {short(tokens.partner)}</b></span>}
    <button className="quiet-button" title={`Let ${AGENT[reviewer]} edit files and make ${AGENT[table.driver]} the reviewer`} onClick={() => run({ action: 'table-driver', driver: reviewer })}><ArrowLeftRight size={13} />Swap</button>
    <label className="table-rounds">Rounds<select value={table.rounds} onChange={(event) => run({ action: 'table-rounds', rounds: Number(event.target.value) })}>{[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
    <span className="table-status" aria-live="polite">{status}</span>
    {busy && <button className="quiet-button" onClick={() => run({ action: 'table-stop' })}><Square size={12} />Stop both</button>}
    {onShow && <button className="quiet-button" aria-pressed={showing} title={showing ? 'Back to the Round Table thread' : `${AGENT[table.partner.engine]}'s own conversation, with what Trace passed to it`} onClick={onShow}>{showing ? 'Back to the table' : `Show ${AGENT[table.partner.engine]}`}</button>}
    <button className="quiet-button" aria-label="Close the Round Table" title={`Close the Round Table and stop ${AGENT[table.partner.engine]}`} onClick={() => run({ action: 'table-close' })}><X size={13} /></button>
    {(table.waiting !== undefined) && <span className="table-waiting" role="status">{table.waitingKept ? 'Kept from before Trace restarted: ' : 'Waiting to go: '}<q>{table.waiting.length > 80 ? table.waiting.slice(0, 80) + '…' : table.waiting}</q>{images ? ` + ${images} ${images === 1 ? 'image' : 'images'}` : ''}{table.waitingImagesDropped ? ` (its ${table.waitingImagesDropped} ${table.waitingImagesDropped === 1 ? 'image is' : 'images are'} too large to keep through a restart)` : ''}{table.waitingKept && <><button className="quiet-button" onClick={() => run({ action: 'table-waiting', send: true })}>Send now</button><button className="quiet-button" onClick={() => run({ action: 'table-waiting', send: false })}>Drop it</button></>}</span>}
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
/** Codex's challenges to the plan, each with the planner's answer: open while the plan waits for the person. */
function ChallengeList({ challenges, plannerName, open }: { challenges: PlanChallenge[]; plannerName: string; open: boolean }) {
  return <details className="chain-challenges" open={open}><summary>Codex's challenges · {challenges.length}{challenges.some((item) => item.answer === 'accepted') ? ` · ${challenges.filter((item) => item.answer === 'accepted').length} accepted` : ''}</summary>
    <ol>{challenges.map((challenge) => <li key={challenge.id} className={challenge.answer ?? 'unanswered'}><strong>{challenge.id} · {challenge.severity}</strong> {challenge.text}
      <small>{challenge.answer ? `${plannerName}: ${ANSWER_LABEL[challenge.answer]}${challenge.reason ? `, ${challenge.reason}` : ''}` : `${plannerName} did not answer it`}</small></li>)}</ol>
  </details>;
}
/**
 * The bar of a hierarchy Round Table: where the task is among plan, (Codex's) challenge, approve, build, review, fix and
 * final review; the plan approval with Codex's challenges and the planner's answers; Stop, Continue and Continue without
 * the challenge; each seat's model (used when that seat starts); findings and a kept message.
 */
/**
 * Where a message waiting at a hierarchy table (one not kept from before a restart) will go, as review-chain.ts sends it:
 * with the next step, or to the planner once the final review is reached.
 */
export function waitingLabel(table: RoundTableState): string {
  const chain = table.chain; const step = chain?.step ?? 'idle'; const finalRound = chain?.finalRound ?? 0;
  if (step === 'needs-you') return 'Waiting (Send now sends it to the planner): ';
  if (step === 'stopped') return late({ finalRound }, chain?.stoppedAt) ? 'Goes to the planner when you continue: ' : 'Goes with the step when you continue: ';
  if (step === 'final') return 'Goes to the planner after the final review, or starts the next task if it approves: ';
  if (late({ finalRound }, step)) return 'Goes to the planner as a follow-up: ';
  if (step === 'reviewing' || step === 'fixing') return 'Goes with the next step, or to the planner if the final review is next: ';
  return 'Goes with the next step: ';
}
/** A seat's Models field: what was last refused in it stays beside it until that field is left again, whatever the other fields do. */
type SeatField = 'planner' | 'builder' | 'reviewer';
/**
 * Each seat's model, used when that seat starts. onModel saves it, or returns why it did not (the caller checks it, so
 * this file, which the phone also loads, needs no schemas).
 */
function ChainModels({ lead, planner, reviewer, locked, onModel, maxLength }: { lead: Session; planner?: Session | null; reviewer?: Session | null; locked: boolean; onModel: (session: Session, model: string) => string | void; maxLength?: number }) {
  const model = (session: Session | null | undefined, fallback: string) => session && isAgentConfig(session.config) ? session.config.model || fallback : fallback;
  const [refused, setRefused] = useState<Partial<Record<SeatField, string>>>({});
  const setModel = (field: SeatField, session: Session | null | undefined, value: string) => { const reason = session && isAgentConfig(session.config) ? onModel(session, value.trim()) || '' : ''; setRefused((current) => ({ ...current, [field]: reason })); };
  const field = (key: SeatField, label: string, aria: string, session: Session | null | undefined, fallback: string) => <><label>{label}<input aria-label={aria} aria-invalid={refused[key] ? true : undefined} disabled={locked} maxLength={maxLength} defaultValue={model(session, fallback)} onBlur={(e) => setModel(key, session, e.target.value)} spellCheck={false} /></label>{refused[key] && <small role="alert">{refused[key]}</small>}</>;
  return <details className="chain-models"><summary>Models</summary>
      {field('planner', 'Planner and final review', 'Planner model', planner, HIERARCHY_MODELS.planner)}
      {field('builder', 'Builder', 'Builder model', lead, HIERARCHY_MODELS.builder)}
      {reviewer && field('reviewer', 'Reviewer (Codex)', 'Reviewer model', reviewer, HIERARCHY_MODELS.reviewer)}
      <small>{locked ? 'A running seat keeps its model: stop this channel (which stops all three), change them here, then start it again.' : 'Used when the channel starts again.'}</small>
  </details>;
}
export function ChainBar({ table, busy, plannerName, builderName, lead, planner, reviewer, onRequest, onModel, modelMaxLength, detached, seats }: { table: RoundTableState; busy: boolean; plannerName: string; builderName: string; /** Each seat: who, its role, what it is doing now, and its tokens today. */ seats?: ChainSeat[]; lead?: Session; planner?: Session | null; /** The Codex reviewer (hidden), for its model. */ reviewer?: Session | null; onRequest: (request: ChainAction) => void; /** Saves a seat's model as typed (trimmed), or returns why it did not. */ onModel?: (session: Session, model: string) => string | void; /** The longest model the Models fields take. */ modelMaxLength?: number; /** The builder runs but the table is not open: why, and Reopen when its seats can be started again. */ detached?: { note: string; onReopen?: () => void } }) {
  const chain = table.chain; const step = chain?.step ?? 'idle'; const at = step === 'stopped' ? chain?.stoppedAt : step;
  const steps = CHAIN_STEPS;
  const current = steps.findIndex((item) => at && item.of.includes(at));
  const challengeStopped = step === 'stopped' && chain?.stoppedAt === 'challenging';
  const status = step === 'challenging' ? 'Codex challenging the plan…' : step === 'plan-responding' ? `${plannerName} answering Codex's challenges…` : step === 'plan-review' && chain?.challenged && !chain.challenges?.length && !chain.note ? `${plannerName}'s plan is ready (Codex raised no challenges): approve it, or write what to change` : step === 'idle' ? 'Give it a task' : step === 'plan-review' ? `${plannerName}'s plan is ready: approve it, or write what to change${chain?.note ? ` (${chain.note})` : ''}` : step === 'done' ? `Approved by ${plannerName}` : step === 'needs-you' ? (chain?.note || 'Needs you') : step === 'stopped' ? (table.stopping ? 'Stopping…' : `Stopped${chain?.note ? `: ${chain.note}` : ''}`) : step === 'reviewing' ? `Codex reviewing (round ${chain?.reviewRound} of ${table.rounds})` : step === 'fixing' && chain?.verdict === 'changes' ? `${builderName} fixing what the final review found` : step === 'final-fixing' ? `${builderName} making the final review's changes` : step === 'planning' ? `${plannerName} writing the plan…` : step === 'implementing' ? `${builderName} building…` : step === 'fixing' ? `${builderName} fixing the review's findings…` : step === 'final' ? `${plannerName} giving the final review…` : `${steps[current]?.label ?? ''}…`;
  /** A running seat's launch settings are locked (as anywhere in Trace), so models change only while the channel is stopped. */
  const locked = [lead, planner, reviewer].some((session) => session?.status === 'running' || session?.status === 'starting');
  return <div className="table-bar chain-bar" role="group" aria-label="Round Table">
    <span className="table-seats" aria-hidden="true"><i className="seat-you" /><i className="seat-planner" /><i className="seat-claude" /><i className="seat-codex" /></span>
    <strong>Round Table · hierarchy</strong>
    <ol className="chain-steps" aria-label="Steps">{steps.map((item, index) => <li key={item.step} className={index === current ? 'current' : index < current || step === 'done' ? 'past' : ''} aria-current={index === current ? 'step' : undefined}>{item.label}</li>)}</ol>
    <span className="table-status" aria-live="polite">{detached ? detached.note : status}</span>
    {detached?.onReopen && <button className="button primary" onClick={detached.onReopen}>Reopen</button>}
    {step === 'plan-review' && <button className="button primary" onClick={() => onRequest({ action: 'table-plan', approve: true, note: '' })}>Approve plan</button>}
    {!detached && step === 'stopped' && chain?.stoppedAt && !table.stopping && <button className="quiet-button" onClick={() => onRequest({ action: 'table-continue' })}>Continue</button>}
    {!detached && challengeStopped && !table.stopping && <button className="quiet-button" title="Show the plan to you without Codex's challenge" onClick={() => onRequest({ action: 'table-continue', skipChallenge: true })}>Continue without the challenge</button>}
    {busy && <button className="quiet-button" onClick={() => onRequest({ action: 'table-stop' })}><Square size={12} />Stop</button>}
    {onModel && lead && <ChainModels lead={lead} planner={planner} reviewer={reviewer} locked={locked} onModel={onModel} maxLength={modelMaxLength} />}
    <button className="quiet-button" aria-label="Close the Round Table" title="Close the Round Table and stop its planner and reviewer" onClick={() => onRequest({ action: 'table-close' })}><X size={13} /></button>
    {chain?.challenges && chain.challenges.length > 0 && <ChallengeList challenges={chain.challenges} plannerName={plannerName} open={step === 'plan-review'} />}
    {table.waiting !== undefined && <span className="table-waiting" role="status">{table.waitingKept ? 'Kept from before Trace restarted: ' : waitingLabel(table)}<q>{table.waiting.length > 80 ? table.waiting.slice(0, 80) + '…' : table.waiting}</q>{table.waitingKept && <><button className="quiet-button" onClick={() => onRequest({ action: 'table-waiting', send: true })}>Send now</button><button className="quiet-button" onClick={() => onRequest({ action: 'table-waiting', send: false })}>Drop it</button></>}{chain?.held && <> ({chain.held})</>}{!table.waitingKept && step === 'needs-you' && <button className="quiet-button" onClick={() => onRequest({ action: 'table-waiting', send: true })}>Send now</button>}{!table.waitingKept && (step === 'needs-you' || (step === 'stopped' && !table.stopping)) && <button className="quiet-button" onClick={() => onRequest({ action: 'table-waiting', send: false })}>Drop it</button>}</span>}
    {chain?.nextTasks?.length ? <div className="table-waiting" role="status">{chain.nextTasks.length === 1 ? 'From Tasks, starts once this task is approved:' : `${chain.nextTasks.length} tasks from Tasks, starting one by one as each task before is approved:`}
      <ol className="chain-next-tasks">{chain.nextTasks.map((task, index) => { const shown = task.replace(SIGNAL_INSTRUCTION, '').trim(); return <li key={`${index}:${task.slice(0, 40)}`}><q>{shown.length > 80 ? shown.slice(0, 80) + '…' : shown}</q>{!detached && <button className="quiet-button" aria-label={`Drop it: ${shown.slice(0, 60)}`} onClick={() => onRequest({ action: 'table-next-drop', index, head: task.slice(0, 200) })}>Drop it</button>}</li>; })}</ol></div> : null}
    {seats && <ul className="chain-seats" aria-label="Seats">{seats.map((seat) => <li key={seat.role} className={seat.state === 'working' ? 'working' : ''}><i className={`seat-hex seat-${seat.colour}`} aria-hidden="true" /><strong>{seat.name}</strong>{seat.role} · {seat.state}{seat.tokens ? ` · ${short(seat.tokens)} tok today` : ''}</li>)}</ul>}
    {table.findings && table.findings.length > 0 && <FindingsList findings={table.findings} />}
  </div>;
}
/** One seat at a hierarchy table, for its bar. */
export interface ChainSeat { role: 'Planner' | 'Builder' | 'Reviewer'; name: string; colour: 'planner' | 'claude' | 'codex'; state: string; tokens: number }
export type ChainAction = { action: 'table-plan'; approve: boolean; note: string } | { action: 'table-continue'; skipChallenge?: boolean } | { action: 'table-stop' } | { action: 'table-close' } | { action: 'table-waiting'; send: boolean } | { action: 'table-next-drop'; index: number; head: string };
