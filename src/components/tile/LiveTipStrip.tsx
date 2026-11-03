import { Lightbulb, LoaderCircle, Sparkles, Copy, X } from 'lucide-react';
import { askAboutTip, channelTip, dismissTip, useLiveCoaching } from '../../state/coaching-store';

/**
 * Live coaching under a channel: local tips on the prompt just sent there, and Claude's advice and rewrite once asked.
 * It sits outside the terminal, so it never covers the conversation.
 */
export function LiveTipStrip({ sessionId }: { sessionId: string }) {
  const tip = useLiveCoaching((state) => state.enabled ? channelTip(state, sessionId) : null);
  const asking = useLiveCoaching((state) => tip ? state.asking.includes(tip.id) : false);
  const error = useLiveCoaching((state) => tip ? state.errors[tip.id] : undefined);
  if (!tip) return null;
  return <div className="live-tip" role="status" aria-label="Prompt coaching">
    <Lightbulb size={13} className="live-tip-icon" />
    <div className="live-tip-body">
      {tip.review ? <><p>{tip.review.advice}</p>{tip.review.rewrite.trim() !== tip.prompt.trim() && <details><summary>Suggested rewrite</summary><pre>{tip.review.rewrite}</pre></details>}</> : tip.tips.map((text) => <p key={text}>{text}</p>)}
      {!tip.review && !tip.tips.length && !error && <p>Claude is reviewing this prompt…</p>}
      {error && <p className="error-message">{error}</p>}
    </div>
    <div className="live-tip-actions">
      {tip.review ? tip.review.rewrite.trim() !== tip.prompt.trim() && <button className="quiet-button" title="Copy the suggested rewrite" onClick={() => void window.codingHub?.copyText(tip.review!.rewrite)}><Copy size={12} />Copy rewrite</button>
        : <button className="quiet-button" disabled={asking} title="Claude Haiku reviews this prompt, using a little of your Claude plan" onClick={() => void askAboutTip(tip.id)}>{asking ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}{asking ? 'Asking' : 'Ask AI'}</button>}
      <button className="icon-button" aria-label="Dismiss coaching tip" onClick={() => dismissTip(tip.id)}><X size={12} /></button>
    </div>
  </div>;
}
