import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, Sparkles } from 'lucide-react';
import type { PromptExample } from '../../shared/coaching';
import { askAboutTip, clearLiveCoaching, loadLiveCoaching, setLiveCoaching, useLiveCoaching } from '../state/coaching-store';
import type { CoachingWeek, TipKind } from '../../shared/coaching';

/** What each kind of tip says about a week of prompts, most useful first. */
const KIND_TEXT: Record<TipKind, string> = { check: 'had no way to tell it worked', error: 'described a problem without the error text', thin: 'started a conversation with little to go on', unnamed: 'started with "it" or "this" before naming anything', vague: 'asked for "better" without saying what that means', many: 'asked for several things at once', long: 'were very long' };
/** The week in plain words: how many prompts, and the tips that came up most. */
function WeekSummary({ week }: { week: CoachingWeek }) {
  const top = (Object.entries(week.kinds) as [TipKind, number][]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!week.prompts) return <p className="muted">No prompts coached in the last 7 days.</p>;
  return <div className="live-week"><h3>Last 7 days</h3><p>{week.prompts} {week.prompts === 1 ? 'prompt' : 'prompts'}, {week.coached} with tips{week.reviewed ? `, ${week.reviewed} reviewed by AI` : ''}.</p>{top.length > 0 && <ul>{top.map(([kind, count]) => <li key={kind}><strong>{count}</strong> ({Math.round(count / week.prompts * 100)}%) {KIND_TEXT[kind]}</li>)}</ul>}{top[0] && <p className="muted">The biggest gain: {top[0][0] === 'check' ? 'end task prompts with how you will check the result.' : top[0][0] === 'error' ? 'paste the error message when something fails.' : top[0][0] === 'thin' || top[0][0] === 'unnamed' ? 'open conversations with the goal, the place and what done looks like.' : top[0][0] === 'vague' ? 'say what you want improved, specifically.' : top[0][0] === 'many' ? 'split big asks, or say what comes first.' : 'lead with the request, then the background.'}</p>}</div>;
}
import { channelNumber, useWorkspaceStore } from '../state/workspace-store';

/**
 * The prompts live coaching saw in this window's channels, newest first, with their tips; each can be reviewed by
 * Claude or saved as a curated example.
 */
export function LiveCoachingCard({ save }: { save: (text: string, outcome: PromptExample['outcome'], notes: string) => Promise<void> }) {
  const { enabled, tips, asking, errors, week } = useLiveCoaching();
  useEffect(() => { void loadLiveCoaching(); }, []);
  const sessions = useWorkspaceStore((state) => state.sessions);
  const [saved, setSaved] = useState<string[]>([]); const [error, setError] = useState('');
  return <article className="storage-card live-coaching"><h2>Live coaching</h2>
    <p>Trace checks each prompt you send in a Claude Code or Codex channel and shows tips under that channel. The checks run on this computer. Ask AI sends that prompt, and the end of the reply before it, to Claude Haiku through your Claude account (or to Codex when Claude Code is not installed), which uses a little of that plan and counts in your usage. Another computer's channels are coached there, and shown on its tab here and on your phone.</p>
    <label className="update-checkbox"><input type="checkbox" aria-label="Live coaching" checked={enabled} onChange={(event) => void setLiveCoaching(event.target.checked).catch((e) => setError(e.message))} />Coach my prompts as I send them</label>
    {error && <p role="alert" className="error-message">{error}</p>}
    {week && <WeekSummary week={week} />}
    {enabled && !tips.length && <p className="muted">No prompts yet. Send one in a channel and its tips appear here.</p>}
    {tips.length > 0 && <button className="quiet-button" onClick={() => void clearLiveCoaching().catch((e) => setError(e.message))}>Clear coached prompts</button>}
    <div className="live-feed">{tips.map((tip) => {
      const number = channelNumber(sessions, tip.sessionId);
      return <article key={tip.id}>
        <small className="muted">{number ? `CH${number}` : 'Closed channel'} · {tip.engine === 'claude' ? 'Claude Code' : 'Codex'} · {new Date(tip.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>
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
