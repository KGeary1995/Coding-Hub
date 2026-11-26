import { useActivityStore, ACTIVITY_WINDOW } from '../../state/activity-store';
import { LIMIT_THRESHOLD, type ChannelState } from '../../state/channel-state';
import { TRACE_HEIGHT, TRACE_WIDTH, tracePath } from '../../state/trace';
import type { ChannelEngine } from '../../../shared/types';
import { compact } from '../shell/StatusBar';
import { Coins, Gauge } from 'lucide-react';

const EMPTY: readonly number[] = Array(ACTIVITY_WINDOW).fill(0);

/**
 * The channel's footer: at the left its context (or the channel's budget) as a meter with its share, or only the amount
 * where the CLI reports no window, and the channel's tokens today; at the right terminal output over the last two
 * minutes as a small trace with its rate. The trace is real output only; the state shows in its colour (set in tile.css
 * from the tile's state), never in invented data. `limitName` names what the meter measures ("Budget" when it falls
 * back to the channel's budget), and a chat channel (`chat`) has no trace: it has no terminal output, so the trace read
 * "0 chars/s" through every reply; its state badge says it is working. `tokens` is null while a channel's usage is not
 * measured (a Gemini CLI channel before its first request is read): that is drawn as "—", and 0 is a counted zero.
 * Gemini CLI reports no context window, so its footer has the tokens and no context.
 *
 * `place` 'head': the same numbers in the tile's header (the owner's choice of 2026-11-25, for the terminal's room), in short
 * (no labels, "tok" for "tok today", "ctx" after an amount in context, which has no meter to name it and read as a bare
 * number, the rate in the trace's tooltip). Which of the two shows follows the tile's width (tile.css).
 */
export function ScopeStrip({ sessionId, state, engine, limit, limitLabel, limitName = 'Context', chat = false, tokens, tokensTitle = 'New tokens in this channel today', contextUsed, place = 'foot' }: { sessionId: string; state: ChannelState; engine: ChannelEngine; limit: number | null; limitLabel: string; limitName?: 'Context' | 'Budget'; chat?: boolean; tokens?: number | null; tokensTitle?: string; place?: 'head' | 'foot'; contextUsed?: number | null }) {
  const samples = useActivityStore((store) => store.samples[sessionId]) ?? EMPTY;
  const rate = samples.at(-1) ?? 0;
  const hot = limit !== null && limit >= LIMIT_THRESHOLD;
  const head = place === 'head';
  return <div className={`tr-scope tr-tile-foot state-${state} ${head ? 'in-head' : 'in-foot'}`}>
    {engine !== 'shell' && <>
      {/* With a share to show, the meter carries the name ("Context 13%") and the label is for the eye only; without one
          there is no meter (an empty track read as 0%), and the label is the name of the amount. */}
      {limit !== null ? <span className="tr-foot-item" title={limitLabel}><Gauge size={12} aria-hidden="true" /><span className="tr-foot-label" aria-hidden="true">{limitName}</span>
        <span className={`tr-scope-limit ui-meter ${hot ? 'limit' : engine}`} role="img" aria-label={limitLabel}><i style={{ width: `${Math.min(100, Math.round(limit * 100))}%` }} /></span>
        <b className={`tr-foot-value ${hot ? 'hot' : ''}`}>{Math.round(limit * 100)}%</b></span>
        : contextUsed ? <span className="tr-foot-item" title="Tokens in context. Claude Code does not report its context window, so there is no percentage."><Gauge size={12} aria-hidden="true" /><span className="tr-foot-label">Context</span><b className="tr-foot-value">{compact(contextUsed)}</b>{head && ' ctx'}</span> : null}
      <span className="tr-foot-item" title={tokensTitle}><Coins size={12} aria-hidden="true" /><b className="tr-foot-value">{tokens === null ? '—' : compact(tokens ?? 0)}</b> {head ? 'tok' : 'tok today'}</span>
    </>}
    {!chat && <><svg className="tr-scope-plot" viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Terminal output over the last two minutes${rate ? `, ${compact(rate)} characters in the last second` : ', quiet'}`}>
      <path className="tr-scope-trace" d={tracePath(samples)} />
    </svg>
    {!head && <span className="tr-scope-rate" title="Terminal output, characters per second">{compact(rate)} chars/s</span>}</>}
  </div>;
}
