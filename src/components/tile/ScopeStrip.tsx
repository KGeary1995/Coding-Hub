import { useActivityStore, ACTIVITY_WINDOW } from '../../state/activity-store';
import { LIMIT_THRESHOLD, type ChannelState } from '../../state/channel-state';
import { TRACE_HEIGHT, TRACE_RAIL, TRACE_WIDTH, tracePath } from '../../state/trace';
import { compact } from '../shell/StatusBar';

const EMPTY: readonly number[] = Array(ACTIVITY_WINDOW).fill(0);

/**
 * The channel's footer (Flight Deck Lite): context, or the session budget, as a segmented gauge with its share and the
 * channel's tokens today, then terminal output over the last two minutes as a small trace with its rate. The trace is
 * real output only; the state shows in its colour, never in invented data.
 */
export function ScopeStrip({ sessionId, state, engine, limit, limitLabel, tokens, contextUsed }: { sessionId: string; state: ChannelState; engine: 'claude' | 'codex' | 'shell'; limit: number | null; limitLabel: string; tokens?: number; contextUsed?: number | null }) {
  const samples = useActivityStore((store) => store.samples[sessionId]) ?? EMPTY;
  const rate = samples.at(-1) ?? 0;
  const color = state === 'working' ? `var(--tr-ch-${engine})` : `var(--tr-st-${state})`;
  const hot = limit !== null && limit >= LIMIT_THRESHOLD;
  return <div className={`tr-scope tr-tile-foot state-${state}`}>
    {engine !== 'shell' && <>
      <span className="tr-foot-label" aria-hidden="true">ctx</span>
      <span className={`tr-scope-limit ${hot ? 'hot' : ''}`} role="img" aria-label={limit !== null ? limitLabel : contextUsed ? `${compact(contextUsed)} tokens in context` : 'No context report yet'} title={limit !== null ? limitLabel : 'Claude Code does not report its context window, so there is no percentage.'}><i style={{ width: `${limit !== null ? Math.min(100, Math.round(limit * 100)) : 0}%` }} /></span>
      <b className={`tr-foot-value tnum ${hot ? 'hot' : ''}`}>{limit !== null ? `${Math.round(limit * 100)}%` : contextUsed ? compact(contextUsed) : '—'}</b>
      <span className="tr-foot-value tnum" title="New tokens in this channel today">{tokens ? compact(tokens) : '—'} tok</span>
    </>}
    <svg className="tr-scope-plot" viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Terminal output over the last two minutes${rate ? `, ${compact(rate)} characters in the last second` : ', quiet'}`}>
      <line className="tr-scope-rail" x1="0" x2={TRACE_WIDTH} y1={TRACE_RAIL} y2={TRACE_RAIL} />
      <path className="tr-scope-trace" d={tracePath(samples)} style={{ stroke: color }} />
    </svg>
    <span className="tr-scope-rate tnum" title="Terminal output, characters per second">out {compact(rate)}/s</span>
  </div>;
}
