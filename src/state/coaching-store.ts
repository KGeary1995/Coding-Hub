import { create } from 'zustand';
import type { CoachingRequest, CoachingResponse, LiveCoaching, LiveTip } from '../../shared/coaching';

async function coaching<T extends CoachingResponse>(request: CoachingRequest): Promise<T> {
  if (!window.codingHub) throw new Error('Coaching requires the desktop app.');
  const result = await window.codingHub.coaching(request); if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}
/**
 * Live coaching as the window shows it: the prompts the host saw (newest first), which tips were dismissed from their
 * channel, and which prompts Claude is reviewing.
 */
interface LiveState { enabled: boolean; tips: LiveTip[]; dismissed: string[]; asking: string[]; errors: Record<string, string> }
export const useLiveCoaching = create<LiveState>(() => ({ enabled: true, tips: [], dismissed: [], asking: [], errors: {} }));

export function receiveTip(tip: LiveTip) {
  useLiveCoaching.setState((state) => ({ tips: [tip, ...state.tips.filter((item) => item.id !== tip.id)].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50) }));
}
export async function loadLiveCoaching() {
  try { const live = await coaching<LiveCoaching>({ action: 'live' }); useLiveCoaching.setState({ enabled: live.enabled, tips: live.tips }); } catch { /* Shown as on with no prompts yet. */ }
}
export async function setLiveCoaching(enabled: boolean) { const live = await coaching<LiveCoaching>({ action: 'live-set', enabled }); useLiveCoaching.setState({ enabled: live.enabled }); }
export const dismissTip = (id: string) => useLiveCoaching.setState((state) => ({ dismissed: [...state.dismissed, id] }));
export async function askAboutTip(id: string) {
  if (useLiveCoaching.getState().asking.includes(id)) return;
  useLiveCoaching.setState((state) => { const { [id]: _old, ...errors } = state.errors; return { asking: [...state.asking, id], errors }; });
  try { receiveTip(await coaching<LiveTip>({ action: 'live-review', id })); }
  catch (error) { useLiveCoaching.setState((state) => ({ errors: { ...state.errors, [id]: error instanceof Error ? error.message : 'Claude could not review this prompt.' } })); }
  finally { useLiveCoaching.setState((state) => ({ asking: state.asking.filter((item) => item !== id) })); }
}
/** The tip a channel shows: its newest prompt, while that has tips or a review and was not dismissed. */
export const channelTip = (state: LiveState, sessionId: string) => {
  const tip = state.tips.find((item) => item.sessionId === sessionId);
  return tip && !state.dismissed.includes(tip.id) && (tip.tips.length || tip.review || state.asking.includes(tip.id) || state.errors[tip.id]) ? tip : null;
};
