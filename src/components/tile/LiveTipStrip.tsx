import { useState } from 'react';
import { Lightbulb, LoaderCircle, Sparkles, Copy, X } from 'lucide-react';
import type { LiveReview } from '../../../shared/coaching';
import { askAboutTip, channelTip, dismissTip, useLiveCoaching } from '../../state/coaching-store';
import { workbench } from '../../runtime/workbench';

/**
 * Live coaching under a channel: local tips on the prompt just sent there, and the AI's advice and rewrite once asked.
 * It sits outside the terminal, so it never covers the conversation.
 */
export function TipStrip({ tips, review, prompt, asking, error, ask, dismiss, where }: { tips: string[]; review: LiveReview | null; prompt?: string; asking: boolean; error?: string; ask: () => void; dismiss: () => void; where?: string }) {
  const rewrite = review && review.rewrite.trim() !== prompt?.trim() ? review.rewrite : null;
  return <div className="live-tip" role="status" aria-label="Prompt coaching">
    <Lightbulb size={13} className="live-tip-icon" />
    <div className="live-tip-body">
      {review ? <><p>{review.advice}</p>{rewrite && <details><summary>Suggested rewrite</summary><pre>{rewrite}</pre></details>}</> : tips.map((text) => <p key={text}>{text}</p>)}
      {!review && !tips.length && !error && <p>The AI is reviewing this prompt…</p>}
      {error && <p className="error-message">{error}</p>}
    </div>
    <div className="live-tip-actions">
      {review ? rewrite && <button className="quiet-button" title="Copy the suggested rewrite" onClick={() => void window.codingHub?.copyText(rewrite)}><Copy size={12} />Copy rewrite</button>
        : <button className="quiet-button" disabled={asking} title={`Claude Code (or Codex, for a Codex channel)${where ? ` on ${where}` : ''} reviews this prompt, using a little of that plan`} onClick={ask}>{asking ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}{asking ? 'Asking' : 'Ask AI'}</button>}
      <button className="icon-button" aria-label="Dismiss coaching tip" onClick={dismiss}><X size={12} /></button>
    </div>
  </div>;
}

/** This computer's channel. */
export function LiveTipStrip({ sessionId }: { sessionId: string }) {
  const tip = useLiveCoaching((state) => state.enabled ? channelTip(state, sessionId) : null);
  const asking = useLiveCoaching((state) => tip ? state.asking.includes(tip.id) : false);
  const error = useLiveCoaching((state) => tip ? state.errors[tip.id] : undefined);
  if (!tip) return null;
  return <TipStrip tips={tip.tips} review={tip.review} prompt={tip.prompt} asking={asking} error={error} ask={() => void askAboutTip(tip.id)} dismiss={() => dismissTip(tip.id)} />;
}

/** A linked computer's channel: that computer coaches its own prompts, and its CLI reviews them when asked. */
export function LinkedTipStrip({ computerId, computerName, coaching }: { computerId: string; computerName: string; coaching: { id: string; tips: string[]; review: LiveReview | null } }) {
  const [dismissed, setDismissed] = useState<string | null>(null); const [asking, setAsking] = useState(false); const [error, setError] = useState('');
  if (dismissed === coaching.id) return null;
  const ask = () => { setAsking(true); setError(''); void workbench({ action: 'linked-coach-review', id: computerId, tip: coaching.id }).catch((e: Error) => setError(e.message)).finally(() => setAsking(false)); };
  return <TipStrip tips={coaching.tips} review={coaching.review} asking={asking} error={error} ask={ask} dismiss={() => setDismissed(coaching.id)} where={computerName} />;
}
