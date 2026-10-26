import { create } from 'zustand';
import type { LimitWindow, PlanLimits } from '../../shared/plan-limits';
import { workbench } from '../runtime/workbench';

/** The usage limits last read from the CLIs (see PlanLimitsService), for the status bar and Usage. */
export const usePlanLimits = create<{ limits: PlanLimits[]; loading: boolean }>(() => ({ limits: [], loading: false }));

export async function refreshPlanLimits(force = false) {
  if (usePlanLimits.getState().loading) return;
  usePlanLimits.setState({ loading: true });
  try { usePlanLimits.setState({ limits: await workbench<PlanLimits[]>({ action: 'plan-limits', force }) }); }
  catch { /* Kept as it was; shown as unavailable. */ }
  finally { usePlanLimits.setState({ loading: false }); }
}

/** When a window resets, in the person's words: "in 3 h", "Oct 31, 8:00 AM", or as the CLI said it. */
export function resetText(window: LimitWindow, now = Date.now()) {
  if (!window.resets) return null;
  const at = Date.parse(window.resets); if (Number.isNaN(at)) return window.resets;
  const minutes = Math.round((at - now) / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)} h`;
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
/** How close a window is to its limit, for colour: under 75%, nearing it, or nearly out. */
export const limitLevel = (percent: number) => percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'ok';
