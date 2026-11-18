import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, MessagesSquare, RefreshCw } from 'lucide-react';
import type { ChannelTranscript } from '../../../shared/remote';
import { ToolCard } from './ChatParts';
import { Markdown } from './Markdown';

/**
 * A terminal channel's whole conversation, read from its CLI's own transcript. The terminal shows only the current
 * run (each restart begins a new one, and Claude Code draws a full screen with no scrollback), so this is where what
 * was said before a restart can be read again. Read-only: the terminal stays the place to answer.
 */
export function TranscriptView({ agent, load, where }: { agent: string; load: () => Promise<ChannelTranscript>; where?: string }) {
  const [transcript, setTranscript] = useState<ChannelTranscript | undefined>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const read = () => { setLoading(true); setError(''); load().then(setTranscript, (e: Error) => setError(e.message)).finally(() => setLoading(false)); };
  useEffect(read, []);
  // Opens at the latest message, like the terminal.
  useLayoutEffect(() => { const element = scroller.current; if (element) element.scrollTop = element.scrollHeight; }, [transcript]);
  return <div className="chat-view transcript-view">
    <div className="transcript-bar"><span>Whole conversation{where ? ` on ${where}` : ''}, across restarts{transcript?.messages.length === 200 ? ' (latest 200 messages)' : ''}</span>
      <button className="tr-detail-button" disabled={loading} onClick={read}><RefreshCw size={12} className="tr-detail-icon" /><span className="tr-detail-label">{loading ? 'Reading' : 'Refresh'}</span></button></div>
    <div className="chat-thread" ref={scroller} role="log" aria-label={`${agent} conversation`}>
      {/* Until the first read is back: a line saying so, not a blank thread. A failed read is an error state; Refresh tries again. */}
      {transcript === undefined && !error && <div className="chat-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" /><strong>Reading the conversation…</strong></div>}
      {error && transcript?.messages.length ? <p className="chat-notice error" role="alert">{error}</p> : null}
      {error && !transcript?.messages.length && <div className="chat-empty error" role="alert"><AlertCircle aria-hidden="true" /><strong>The conversation could not be read</strong><p>{error}</p></div>}
      {/* A transcript with nothing in it yet reads the same as none: the sentence, not a blank thread. */}
      {!error && (transcript === null || transcript?.messages.length === 0) && <div className="chat-empty"><MessagesSquare aria-hidden="true" /><strong>No saved conversation yet</strong><p>It appears once {agent} has answered in this channel.</p></div>}
      {transcript?.messages.map((message, index) => message.role === 'user'
        ? <div key={index} className="chat-message user">{message.images > 0 && <p className="chat-notice">{message.images === 1 ? '1 image' : `${message.images} images`}</p>}{message.text && <p className="chat-user-text">{message.text}</p>}</div>
        : <div key={index} className="chat-message assistant">{message.blocks.map((block, part) => block.type === 'text' ? <Markdown key={part} text={block.text} />
          : block.type === 'thinking' ? <details key={part} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>
            : <ToolCard key={block.id || part} block={block} result={transcript.results[block.id] ?? { text: '', isError: false, image: false }} />)}</div>)}
    </div>
  </div>;
}
