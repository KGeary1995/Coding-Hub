import { useState } from 'react';
import { MessageSquarePlus, Send, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { isChatRun } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspace-store';
import { reviewChannels, reviewMessage, type ReviewComment } from '../state/review-comments';
import { sendToChannel } from '../runtime/send-to-channel';
import { channelNameNow } from '../state/channel-names';

/** The button at the start of a diff line that opens a comment on it (1.32.2). */
export function CommentButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="diff-comment-add" aria-label={`Comment on ${label}`} title="Comment on this line, to send to the agent" onClick={onClick}><MessageSquarePlus size={12} aria-hidden="true" /></button>;
}

/** A comment being written, under its line: Enter with Ctrl (or Cmd) or Add keeps it, Escape or Cancel drops it. */
export function CommentForm({ label, onAdd, onCancel }: { label: string; onAdd: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const add = () => { if (note.trim()) onAdd(note.trim()); };
  return <div className="diff-comment-form"><textarea aria-label={`Comment on ${label}`} autoFocus rows={3} maxLength={2000} value={note} placeholder="What should change here?" onChange={(event) => setNote(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); add(); } }} />
    <div className="ui-actions"><button type="button" className="button primary small" disabled={!note.trim()} onClick={add}>Add comment</button><button type="button" className="button secondary small" onClick={onCancel}>Cancel</button></div></div>;
}

/** A kept comment under its line, with Remove. */
export function CommentNote({ comment, onRemove }: { comment: ReviewComment; onRemove: () => void }) {
  return <div className="diff-comment"><p>{comment.note}</p><button type="button" className="icon-button small" aria-label={`Remove the comment on ${comment.path} line ${comment.line ?? ''}`.trim()} onClick={onRemove}><X size={12} aria-hidden="true" /></button></div>;
}

/**
 * The comments kept on this repository's diffs, and where to send them: one message to a running agent channel working
 * in this repository, typed in as the person would (sendToChannel), and cleared once sent.
 */
export function ReviewBar({ root, comments, onSent, onClear }: { root: string; comments: ReviewComment[]; onSent: () => void; onClear: () => void }) {
  const sessions = useWorkspaceStore(useShallow((state) => state.sessions));
  const channels = reviewChannels(sessions, root);
  const [chosen, setChosen] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const target = channels.find(({ session }) => session.id === chosen) ?? channels[0];
  if (!comments.length && !note) return null;
  const send = async () => {
    if (!target) return; setNote(null);
    // A terminal waiting on an approval would take the message's Enter as the answer.
    if (!isChatRun(target.session.config) && target.session.attention) { setNote({ error: true, text: `CH${target.channel} is waiting for you. Answer it first, then send.` }); return; }
    setBusy(true);
    try {
      if (await sendToChannel(target.session, reviewMessage(comments))) { setNote({ error: false, text: `Sent ${comments.length === 1 ? 'the comment' : `${comments.length} comments`} to CH${target.channel}.` }); onSent(); }
      else setNote({ error: true, text: `The comments could not be typed into CH${target.channel}. They are kept here.` });
    } finally { setBusy(false); }
  };
  return <div className="review-bar" role="region" aria-label="Review comments">
    {comments.length > 0 && <><span className="ui-badge accent">{comments.length === 1 ? '1 comment' : `${comments.length} comments`}</span>
      {channels.length ? <><label className="review-target">Send to<select aria-label="Channel to send the comments to" value={target?.session.id ?? ''} onChange={(event) => setChosen(event.target.value)}>{channels.map(({ session, channel }) => <option key={session.id} value={session.id}>CH{channel} · {channelNameNow(session)}</option>)}</select></label>
        <button type="button" className="button primary small" disabled={busy || !target} onClick={() => void send()}><Send size={12} aria-hidden="true" />Send to channel</button></>
        : <span className="ui-hint">Start an agent channel in this repository to send them.</span>}
      <button type="button" className="quiet-button small" disabled={busy} onClick={onClear}>Clear</button></>}
    {note && <span className={note.error ? 'error-message' : 'ui-hint'} role={note.error ? 'alert' : 'status'}>{note.text}</span>}
  </div>;
}
