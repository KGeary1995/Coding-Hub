import { useActivityStore, ACTIVITY_WINDOW } from '../../state/activity-store';
import { LIMIT_THRESHOLD, type ChannelState } from '../../state/channel-state';
import { TRACE_HEIGHT, TRACE_WIDTH, tracePath } from '../../state/trace';
import type { ChannelEngine } from '../../../shared/types';
import { compact } from '../shell/StatusBar';

const EMPTY: readonly number[] = Array(ACTIVITY_WINDOW).fill(0);

/**
 * The channel's footer: context, or the channel's budget, as a meter with its share and the channel's tokens today, then
 * terminal output over the last two minutes as a small trace with its rate. The trace is real output only; the state
 * shows in its colour (set in tile.css from the tile's state), never in invented data.
 */
export function ScopeStrip({ sessionId, state, engine, limit, limitLabel, tokens, tokensTitle = 'New tokens in this channel today', contextUsed }: { sessionId: string; state: ChannelState; engine: ChannelEngine; limit: number | null; limitLabel: string; tokens?: number; tokensTitle?: string; contextUsed?: number | null }) {
  const samples = useActivityStore((store) => store.samples[sessionId]) ?? EMPTY;
  const rate = samples.at(-1) ?? 0;
  const hot = limit !== null && limit >= LIMIT_THRESHOLD;
  return <div className={`tr-scope tr-tile-foot state-${state}`}>
    {(engine === 'claude' || engine === 'codex') && <>
      <span className="tr-foot-label" aria-hidden="true">Context</span>
      <span className={`tr-scope-limit ui-meter ${hot ? 'limit' : engine}`} role="img" aria-label={limit !== null ? limitLabel : contextUsed ? `${compact(contextUsed)} tokens in context` : 'No context report yet'} title={limit !== null ? limitLabel : 'Claude Code does not report its context window, so there is no percentage.'}><i style={{ width: `${limit !== null ? Math.min(100, Math.round(limit * 100)) : 0}%` }} /></span>
      {(limit !== null || Boolean(contextUsed)) && <b className={`tr-foot-value ${hot ? 'hot' : ''}`}>{limit !== null ? `${Math.round(limit * 100)}%` : `${compact(contextUsed ?? 0)} used`}</b>}
      <span className="tr-foot-value" title={tokensTitle}>{compact(tokens ?? 0)} tokens today</span>
    </>}
    <svg className="tr-scope-plot" viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Terminal output over the last two minutes${rate ? `, ${compact(rate)} characters in the last second` : ', quiet'}`}>
      <path className="tr-scope-trace" d={tracePath(samples)} />
    </svg>
    <span className="tr-scope-rate" title="Terminal output, characters per second">{compact(rate)} chars/s</span>
  </div>;
}
