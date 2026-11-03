import { useState } from 'react';
import { LoaderCircle, Plus, Sparkles } from 'lucide-react';
import type { PromptExample } from '../../shared/coaching';
import { askAboutTip, setLiveCoaching, useLiveCoaching } from '../state/coaching-store';
import { useWorkspaceStore } from '../state/workspace-store';

/**
 * The prompts live coaching saw in this window's channels, newest first, with their tips; each can be reviewed by
 * Claude or saved as a curated example.
 */
export function LiveCoachingCard({ save }: { save: (text: string, outcome: PromptExample['outcome'], notes: string) => Promise<void> }) {
  const { enabled, tips, asking, errors } = useLiveCoaching();
  const sessions = useWorkspaceStore((state) => state.sessions);
  const [saved, setSaved] = useState<string[]>([]); const [error, setError] = useState('');
  return <article className="storage-card live-coaching"><h2>Live coaching</h2>
    <p>Trace checks each prompt you send in a Claude Code or Codex channel and shows tips under that channel. The checks run on this computer. Ask AI sends that prompt, and the end of the reply before it, to Claude Haiku through your Claude account (Codex, for a Codex channel), which uses a little of that plan. Another computer's channels are coached there, and shown on its tab here and on your phone.</p>
    <label className="update-checkbox"><input type="checkbox" aria-label="Live coaching" checked={enabled} onChange={(event) => void setLiveCoaching(event.target.checked).catch((e) => setError(e.message))} />Coach my prompts as I send them</label>
    {error && <p role="alert" className="error-message">{error}</p>}
    {enabled && !tips.length && <p className="muted">No prompts yet. Send one in a channel and its tips appear here.</p>}
    <div className="live-feed">{tips.map((tip) => {
      const index = sessions.findIndex((session) => session.id === tip.sessionId);
      return <article key={tip.id}>
        <small className="muted">{index >= 0 ? `CH${index + 1}` : 'Closed channel'} · {tip.engine === 'claude' ? 'Claude Code' : 'Codex'} · {new Date(tip.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>
        <blockquote>{tip.prompt.length > 400 ? tip.prompt.slice(0, 400) + '…' : tip.prompt}</blockquote>
        {tip.review ? <><p>{tip.review.advice}</p>{tip.review.rewrite.trim() !== tip.prompt.trim() && <details><summary>Suggested rewrite</summary><pre>{tip.review.rewrite}</pre></details>}</> : tip.tips.length ? <ul>{tip.tips.map((text) => <li key={text}>{text}</li>)}</ul> : <p className="muted">No local tips for this prompt.</p>}
        {errors[tip.id] && <p className="error-message">{errors[tip.id]}</p>}
        <div className="hub-toolbar">
          {!tip.review && <button className="button secondary" disabled={asking.includes(tip.id)} onClick={() => void askAboutTip(tip.id)}>{asking.includes(tip.id) ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{asking.includes(tip.id) ? 'Asking Claude' : 'Ask AI'}</button>}
          <button className="button secondary" disabled={saved.includes(tip.id)} onClick={() => void save(tip.prompt.slice(0, 2000), 'partial', (tip.review?.advice ?? tip.tips.join(' ')).slice(0, 500)).then(() => setSaved([...saved, tip.id])).catch((e) => setError(e.message))}><Plus size={13} />{saved.includes(tip.id) ? 'Saved' : 'Save as example'}</button>
        </div>
      </article>;
    })}</div>
  </article>;
}
