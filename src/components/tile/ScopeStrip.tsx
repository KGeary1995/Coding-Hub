import { useActivityStore, ACTIVITY_WINDOW } from '../../state/activity-store';
import { LIMIT_THRESHOLD, type ChannelState } from '../../state/channel-state';
import { TRACE_HEIGHT, TRACE_RAIL, TRACE_WIDTH, tracePath } from '../../state/trace';
import { compact } from '../shell/StatusBar';

const EMPTY: readonly number[] = Array(ACTIVITY_WINDOW).fill(0);

/**
 * The channel's oscilloscope: terminal output per second for the last two minutes, a dashed limit rail and the
 * context (or budget) bar. The trace is real output only; the state shows in its colour, never in invented data.
 */
export function ScopeStrip({ sessionId, state, engine, limit, limitLabel }: { sessionId: string; state: ChannelState; engine: 'claude' | 'codex'; limit: number | null; limitLabel: string }) {
  const samples = useActivityStore((store) => store.samples[sessionId]) ?? EMPTY;
  const rate = samples.at(-1) ?? 0;
  const color = state === 'working' ? `var(--tr-ch-${engine})` : `var(--tr-st-${state})`;
  const hot = limit !== null && limit >= LIMIT_THRESHOLD;
  return <div className={`tr-scope state-${state}`} role="img" aria-label={`Terminal output over the last two minutes${rate ? `, ${compact(rate)} characters in the last second` : ', quiet'}`}>
    <svg className="tr-scope-plot" viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="tr-scope-rail" x1="0" x2={TRACE_WIDTH} y1={TRACE_RAIL} y2={TRACE_RAIL} />
      <path className="tr-scope-trace" d={tracePath(samples)} style={{ stroke: color }} />
    </svg>
    <span className="tr-scope-window" aria-hidden="true">−120 s</span>
    <span className="tr-scope-rate tnum" aria-hidden="true" title="Terminal output, characters per second">out {compact(rate)}/s</span>
    {limit !== null && <span className={`tr-scope-limit ${hot ? 'hot' : ''}`} title={limitLabel}><i style={{ width: `${Math.min(100, Math.round(limit * 100))}%` }} /></span>}
  </div>;
}
