import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ChevronRight, ImagePlus, Send, Square, X } from 'lucide-react';
import type { ChatBlock, ChatImage } from '../../../shared/chat';
import type { Session } from '../../../shared/types';
import { chatAnswered, chatFailed, chatSent, useChatStore, type ChatItem, type ChatThread, type ToolResult } from '../../state/chat-store';
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

function ToolCard({ block, result }: { block: Extract<ChatBlock, { type: 'tool' }>; result?: ToolResult }) {
  const summary = toolSummary(block.name, block.input);
  const edit = block.name === 'Edit' && typeof block.input.old_string === 'string' ? block.input : null;
  return <details className={`chat-tool ${result?.isError ? 'error' : ''} ${result ? 'done' : 'running'}`}>
    <summary><ChevronRight size={13} className="chat-chevron" aria-hidden="true" /><strong>{block.name}</strong><span className="chat-tool-summary" title={summary}>{summary}</span><span className="chat-tool-state">{!result ? 'running…' : result.isError ? 'failed' : 'done'}</span></summary>
    {edit && <div className="chat-diff"><pre className="removed">{String(edit.old_string)}</pre><pre className="added">{String(edit.new_string ?? '')}</pre></div>}
    {!edit && block.name !== 'Bash' && <pre className="chat-tool-input">{JSON.stringify(block.input, null, 2).slice(0, 4000)}</pre>}
    {result && (result.text || result.image) && <pre className="chat-tool-output">{result.text || '(an image)'}</pre>}
  </details>;
}

function Permission({ item, answer }: { item: Extract<ChatItem, { kind: 'permission' }>; answer: (allow: boolean, allowEdits?: boolean) => void }) {
  const summary = toolSummary(item.toolName, item.input);
  return <div className={`chat-permission ${item.answer ?? 'open'}`} role={item.answer ? undefined : 'alert'}>
    <p><strong>Claude wants to use {item.toolName}</strong>{item.description && item.description !== summary ? ` · ${item.description}` : ''}</p>
    {summary && <pre>{summary}</pre>}
    {item.answer ? <p className="chat-permission-answer">{item.answer === 'allowed' ? 'Allowed' : item.answer === 'denied' ? 'Denied' : 'No longer waiting'}</p>
      : <div className="chat-permission-actions">
        <button className="button primary" onClick={() => answer(true)}>Allow</button>
        {item.canAllowEdits && <button className="button secondary" title="Let Claude edit files without asking for the rest of this run" onClick={() => answer(true, true)}>Allow edits this run</button>}
        <button className="button secondary" onClick={() => answer(false)}>Deny</button>
      </div>}
  </div>;
}

/**
 * A chat channel: Claude Code's conversation drawn by Trace, with the person's images in the thread, formatted
 * replies, tool calls as cards with their results, and approvals as buttons. The CLI runs in structured mode in the
 * channel's folder with the channel's account, rules, memory and tools, as a terminal channel does.
 */
export function ChatView({ session }: { session: Session }) {
  const chat = useChatStore((state) => state.threads[session.id] ?? EMPTY);
  const running = session.status === 'running' && session.runId !== null && chat.runId === session.runId;
  const [text, setText] = useState(''); const [images, setImages] = useState<ChatImage[]>([]); const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const pinned = useRef(true); const input = useRef<HTMLTextAreaElement>(null); const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (viewing) dialog.current?.showModal(); else dialog.current?.close(); }, [viewing]);
  // Follow new content while the person is at the bottom; scrolling up to read stops that.
  useLayoutEffect(() => { const element = scroller.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [chat]);
  useLayoutEffect(() => { const area = input.current; if (area) { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 220) + 'px'; } }, [text]);

  const attach = async (files: Blob[]) => {
    setError('');
    try { const read = await Promise.all(files.filter((item) => item.type.startsWith('image/')).map(readImage)); setImages((current) => [...current, ...read].slice(0, 10)); }
    catch (e) { setError((e as Error).message); }
  };
  const send = async () => {
    if (!running || chat.busy || (!text.trim() && !images.length) || !window.codingHub) return;
    const message = text.trim(); const attached = images;
    chatSent(session.id, message, attached); setText(''); setImages([]); pinned.current = true;
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId: session.runId!, text: message, images: attached }).catch(() => null);
    if (!result?.ok) chatFailed(session.id, result?.error.message ?? 'The message could not be delivered.');
  };
  const answer = (requestId: string) => async (allow: boolean, allowEdits?: boolean) => {
    if (!session.runId || !window.codingHub) return;
    const result = await window.codingHub.chat({ action: 'answer', sessionId: session.id, runId: session.runId, requestId, allow, ...(allowEdits ? { allowEdits } : {}) }).catch(() => null);
    if (result?.ok) chatAnswered(session.id, requestId, allow); else setError(result?.error.message ?? 'The answer could not be delivered.');
  };
  const interrupt = () => { if (session.runId) void window.codingHub?.chat({ action: 'interrupt', sessionId: session.id, runId: session.runId }); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } };
  const onPaste = (event: ClipboardEvent) => { const files = [...event.clipboardData.files].filter((item) => item.type.startsWith('image/')); if (files.length) { event.preventDefault(); void attach(files); } };
  const onDrop = (event: DragEvent) => { const files = [...event.dataTransfer.files]; if (files.some((item) => item.type.startsWith('image/'))) { event.preventDefault(); void attach(files); } };

  return <div className="chat-view" data-chat-session={session.id} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
    <div className="chat-thread" ref={scroller} onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }} role="log" aria-label="Conversation" aria-live="polite">
      {!chat.items.length && <p className="chat-empty">{running ? 'Ask Claude anything about this project. Paste or drop screenshots to include them.' : 'Start the channel to chat with Claude in this folder.'}</p>}
      {chat.items.map((item) => item.kind === 'user'
        ? <div key={item.id} className="chat-message user">
          {item.images.length > 0 && <div className="chat-images">{item.images.map((url, index) => <button key={index} className="chat-image" aria-label={`Enlarge image ${index + 1}`} onClick={() => setViewing(url)}><img src={url} alt="" /></button>)}</div>}
          {item.text && <p className="chat-user-text">{item.text}</p>}
        </div>
        : item.kind === 'assistant'
          ? <div key={item.id} className="chat-message assistant">
            {item.blocks.map((block, index) => block.type === 'text' ? <Markdown key={index} text={block.text} />
              : block.type === 'thinking' ? <details key={index} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>
                : <ToolCard key={block.id} block={block} result={chat.results[block.id]} />)}
            {item.streaming && <div className="chat-streaming"><Markdown text={item.streaming} /></div>}
          </div>
          : item.kind === 'permission' ? <Permission key={item.id} item={item} answer={answer(item.id)} />
            : <p key={item.id} className={`chat-notice ${item.error ? 'error' : ''}`}>{item.text}</p>)}
      {chat.busy && <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>Claude is working</p>}
    </div>
    <div className="chat-composer">
      {images.length > 0 && <ul className="chat-attachments" aria-label="Attached images">{images.map((image, index) => <li key={index}><img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} /><button aria-label={`Remove image ${index + 1}`} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X size={11} /></button></li>)}</ul>}
      {error && <p className="chat-notice error" role="alert">{error}</p>}
      <div className="chat-input-row">
        <button className="chat-icon" aria-label="Attach images" title="Attach images (or paste or drop them)" disabled={!running} onClick={() => file.current?.click()}><ImagePlus size={16} /></button>
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <textarea ref={input} rows={1} value={text} disabled={!running} placeholder={running ? (chat.busy ? 'Claude is working. You can write your next message.' : 'Message Claude (Enter to send, Shift+Enter for a new line)') : 'Start the channel to chat'} aria-label="Message to Claude" onChange={(event) => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        {chat.busy
          ? <button className="chat-icon stop" aria-label="Stop Claude's reply" title="Stop the reply (Claude keeps what it has done)" onClick={interrupt}><Square size={14} /></button>
          : <button className="chat-icon send" aria-label="Send" disabled={!running || (!text.trim() && !images.length)} onClick={() => void send()}><Send size={16} /></button>}
      </div>
    </div>
    <dialog ref={dialog} className="pasted-viewer" onClose={() => setViewing(null)} onClick={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
      {viewing && <><header><span>Image</span><button className="quiet-button" aria-label="Close image" onClick={() => setViewing(null)}><X size={14} /></button></header><img src={viewing} alt="" /></>}
    </dialog>
  </div>;
}
