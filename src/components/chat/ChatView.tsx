import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowLeftRight, ChevronRight, ImagePlus, Send, Square, Users, X } from 'lucide-react';
import type { ChatBlock, ChatImage, RoundTableState } from '../../../shared/chat';
import { MAX_CHANNELS } from '../../../shared/schemas';
import type { Session } from '../../../shared/types';
import { chatAnswered, chatFailed, chatSent, useChatStore, type ChatItem, type ChatThread, type ToolResult } from '../../state/chat-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { openRoundTable, tableRequest } from '../../runtime/round-table';
import { Markdown } from './Markdown';

const EMPTY: ChatThread = { runId: null, items: [], results: {}, busy: false, model: null };
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Claude accepts images up to about 5 MB; larger ones (and other formats) are redrawn as JPEG, at most 2000 px. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

function readImage(file: Blob): Promise<ChatImage> {
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

function Permission({ item, agent, answer }: { item: Extract<ChatItem, { kind: 'permission' }>; agent: string; answer: (allow: boolean, allowEdits?: boolean) => void }) {
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

const AGENT = { claude: 'Claude', codex: 'Codex' } as const;
const PHASE: Record<RoundTableState['phase'], string> = { joining: 'Catching the other agent up', answering: 'Both answering', discussing: 'Discussing', idle: 'Your turn' };

/** One message, approval or notice in a thread; `author` labels it in a Round Table. */
function Item({ item, results, agent, author, answer, view }: { item: ChatItem; results: Record<string, ToolResult>; agent: string; author?: 'claude' | 'codex'; answer: (requestId: string) => (allow: boolean, allowEdits?: boolean) => void; view: (url: string) => void }) {
  if (item.kind === 'user') return <div className="chat-message user">
    {item.images.length > 0 && <div className="chat-images">{item.images.map((url, index) => <button key={index} className="chat-image" aria-label={`Enlarge image ${index + 1}`} onClick={() => view(url)}><img src={url} alt="" /></button>)}</div>}
    {item.text && <p className="chat-user-text">{item.text}</p>}
  </div>;
  if (item.kind === 'assistant') return <div className={`chat-message assistant ${author ? `table-${author}` : ''}`}>
    {author && <p className="chat-author">{agent}</p>}
    {item.blocks.map((block, index) => block.type === 'text' ? <Markdown key={index} text={block.text} />
      : block.type === 'thinking' ? <details key={index} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>
        : <ToolCard key={block.id} block={block} result={results[block.id]} />)}
    {item.streaming && <div className="chat-streaming"><Markdown text={item.streaming} /></div>}
  </div>;
  if (item.kind === 'permission') return <Permission item={item} agent={agent} answer={answer(item.id)} />;
  return <p className={`chat-notice ${item.error ? 'error' : ''}`}>{author ? `${agent}: ` : ''}{item.text}</p>;
}

/** The controls of a Round Table: who drives, how many rounds, where it is, stop and close. */
function TableBar({ lead, table, busy, onError }: { lead: Session; table: RoundTableState; busy: boolean; onError: (message: string) => void }) {
  const leadEngine = lead.config.engine === 'codex' ? 'codex' : 'claude';
  const reviewer = table.driver === 'claude' ? 'codex' : 'claude';
  const run = (request: Parameters<typeof tableRequest>[1]) => void tableRequest(lead.id, request).then((error) => { if (error) onError(error); });
  const status = table.phase === 'discussing' ? `Round ${table.round} of ${table.rounds}` : table.phase === 'idle' && table.agreed ? 'They agree. Your turn' : PHASE[table.phase];
  return <div className="table-bar" role="group" aria-label="Round Table">
    <span className="table-seats" aria-hidden="true"><i className="seat-you" /><i className={`seat-${leadEngine}`} /><i className={`seat-${table.partner.engine}`} /></span>
    <strong>Round Table</strong>
    <span className="table-roles">{AGENT[table.driver]} drives · {AGENT[reviewer]} reviews</span>
    <button className="quiet-button" title={`Let ${AGENT[reviewer]} edit files and make ${AGENT[table.driver]} the reviewer`} onClick={() => run({ action: 'table-driver', driver: reviewer })}><ArrowLeftRight size={13} />Swap</button>
    <label className="table-rounds">Rounds<select value={table.rounds} onChange={(event) => run({ action: 'table-rounds', rounds: Number(event.target.value) })}>{[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
    <span className="table-status" aria-live="polite">{status}</span>
    {busy && <button className="quiet-button" onClick={() => run({ action: 'table-stop' })}><Square size={12} />Stop both</button>}
    <button className="quiet-button" aria-label="Close the Round Table" title={`Close the Round Table (${AGENT[table.partner.engine]} stays as its own chat)`} onClick={() => run({ action: 'table-close' })}><X size={13} /></button>
  </div>;
}

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
    {table && <TableBar lead={session} table={table} busy={busy} onError={setError} />}
    {seatedAt && <p className="table-seated" role="note">At a Round Table: this chat answers there, and you write to it in that channel.</p>}
    <div className="chat-thread" ref={scroller} onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }} role="log" aria-label="Conversation" aria-live="polite">
      {!items.length && <p className="chat-empty">{running ? `Ask ${agent} anything about this project. Paste or drop screenshots to include them.` : `Start the channel to chat with ${agent} in this folder.`}</p>}
      {items.map(({ item, from }) => from === 'lead'
        ? <Item key={item.id} item={item} results={chat.results} agent={agent} author={table ? engine : undefined} answer={answerFor(session)} view={setViewing} />
        : <Item key={`partner-${item.id}`} item={item} results={partnerThread.results} agent={AGENT[table!.partner.engine]} author={table!.partner.engine} answer={answerFor(partnerSession)} view={setViewing} />)}
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
