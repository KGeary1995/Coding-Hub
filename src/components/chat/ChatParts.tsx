import { ArrowLeftRight, ChevronRight, Square, X } from 'lucide-react';
import type { ChatBlock, ChatImage, RoundTableState } from '../../../shared/chat';
import type { ChatItem, ChatThread, ToolResult } from '../../state/chat-store';
import type { Session } from '../../../shared/types';
import { Markdown } from './Markdown';

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
function toolSummary(name: string, input: Record<string, unknown>) {
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
  const summary = toolSummary(block.name, block.input);
  const edit = block.name === 'Edit' && typeof block.input.old_string === 'string' ? block.input : null;
  return <details className={`chat-tool ${result?.isError ? 'error' : ''} ${result ? 'done' : 'running'}`}>
    <summary><ChevronRight size={13} className="chat-chevron" aria-hidden="true" /><strong>{block.name}</strong><span className="chat-tool-summary" title={summary}>{summary}</span><span className="chat-tool-state">{!result ? 'running…' : result.isError ? 'failed' : 'done'}</span></summary>
    {edit && <div className="chat-diff"><pre className="removed">{String(edit.old_string)}</pre><pre className="added">{String(edit.new_string ?? '')}</pre></div>}
    {!edit && block.name !== 'Bash' && <pre className="chat-tool-input">{JSON.stringify(block.input, null, 2).slice(0, 4000)}</pre>}
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

/** One message, approval or notice in a thread; `author` labels it in a Round Table. */
/** At a Round Table: `role` labels an agent's messages (driver or reviewer), and the person's messages say YOU. */
export function Item({ item, results, agent, author, answer, view, role }: { item: ChatItem; results: Record<string, ToolResult>; agent: string; author?: 'claude' | 'codex'; answer: (requestId: string) => (allow: boolean, allowEdits?: boolean) => void; view: (url: string) => void; role?: 'driver' | 'reviewer' }) {
  if (item.kind === 'user') return <div className={`chat-message user ${author ? 'table-you' : ''}`}>
    {author && <p className="chat-author"><i className="seat-hex seat-you" aria-hidden="true" />You</p>}
    {item.images.length > 0 && <div className="chat-images">{item.images.map((url, index) => <button key={index} className="chat-image" aria-label={`Enlarge image ${index + 1}`} onClick={() => view(url)}><img src={url} alt="" /></button>)}</div>}
    {item.text && <p className="chat-user-text">{item.text}</p>}
  </div>;
  if (item.kind === 'assistant') return <div className={`chat-message assistant ${author ? `table-${author}` : ''}`}>
    {author && <p className="chat-author"><i className={`seat-hex seat-${author}`} aria-hidden="true" />{agent}{role ? ` · ${role === 'driver' ? 'Driver' : 'Review'}` : ''}</p>}
    {item.blocks.map((block, index) => block.type === 'text' ? <Markdown key={index} text={block.text} />
      : block.type === 'thinking' ? <details key={index} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>
        : <ToolCard key={block.id} block={block} result={results[block.id]} />)}
    {item.streaming && <div className="chat-streaming"><Markdown text={item.streaming} /></div>}
  </div>;
  if (item.kind === 'permission') return <Permission item={item} agent={agent} answer={answer(item.id)} />;
  return <p className={`chat-notice ${item.error ? 'error' : ''}`}>{author ? `${agent}: ` : ''}{item.text}</p>;
}

/** How a Round Table's hidden partner is doing, in a few words for the table bar (it has no tile of its own). */
export function seatState(partner: Pick<Session, 'status' | 'error'> & { attention?: Session['attention'] }, busy: boolean) {
  if (partner.status === 'running') return partner.attention ? 'needs approval' : busy ? 'working' : 'running';
  if (partner.status === 'starting') return 'starting';
  return partner.status === 'error' || partner.error ? 'stopped with an error' : 'stopped';
}

/** The controls of a Round Table: who drives, how many rounds, where it is, stop and close. */
export type TableAction = { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
const short = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
/**
 * `tokens`: each agent's new tokens today, when the caller has them (the desktop does). `partnerState` (seatState) and
 * `onShow` come from the desktop, where the partner has no tile: how it is doing, and a switch to its own conversation.
 */
export function TableBar({ leadEngine, table, busy, onRequest, tokens, partnerState, showing = false, onShow }: { leadEngine: 'claude' | 'codex'; table: RoundTableState; busy: boolean; onRequest: (request: TableAction) => void; tokens?: { lead: number; partner: number }; partnerState?: string; showing?: boolean; onShow?: () => void }) {
  const reviewer = table.driver === 'claude' ? 'codex' : 'claude';
  const run = onRequest;
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
  </div>;
}

