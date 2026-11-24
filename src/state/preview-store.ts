import { create } from 'zustand';
import type { PreviewEvent, PreviewOffer, PreviewResponse, PreviewStatus } from '../../shared/app-preview';
import { workbench } from '../runtime/workbench';

/**
 * App preview (1.39.0): the address each running channel printed (its tile offers Preview), and the one open beside the
 * channels. The host keeps the page and says what may be opened; this only names a channel and a port.
 */
interface PreviewState { offers: Record<string, PreviewOffer>; shown: { sessionId: string; port: number; url: string; status: PreviewStatus } | null; error: string | null }
export const usePreviewStore = create<PreviewState>(() => ({ offers: {}, shown: null, error: null }));

/** Opens a channel's app beside the channels (or another channel's in its place). */
export async function openPreview(sessionId: string) {
  const offer = usePreviewStore.getState().offers[sessionId]; if (!offer) return;
  usePreviewStore.setState({ shown: { sessionId, port: offer.port, url: offer.url, status: 'loading' }, error: null });
  try { await workbench({ action: 'preview-show', sessionId, port: offer.port }); }
  catch (error) { usePreviewStore.setState({ shown: null, error: (error as Error).message }); }
}
export async function previewAction(action: 'preview-reload' | 'preview-browser' | 'preview-close') {
  if (action === 'preview-close') usePreviewStore.setState({ shown: null, error: null });
  try { await workbench({ action }); } catch (error) { usePreviewStore.setState({ error: (error as Error).message }); }
}
/** Where the page goes, in this window's pixels; null while the channels are not shown. */
export function placePreview(bounds: { x: number; y: number; width: number; height: number } | null) { void workbench({ action: 'preview-bounds', bounds }).catch(() => {}); }

/** The host's events. The first address a run prints opens by itself when no preview is open (the person can close it). */
export function receivePreview(event: PreviewEvent) {
  const state = usePreviewStore.getState();
  if (event.type === 'found') {
    usePreviewStore.setState({ offers: { ...state.offers, [event.offer.sessionId]: event.offer } });
    if (event.fresh && !state.shown) void openPreview(event.offer.sessionId);
  } else if (event.type === 'gone') {
    const { [event.sessionId]: _gone, ...offers } = state.offers; usePreviewStore.setState({ offers });
  } else if (state.shown && state.shown.sessionId === event.sessionId && state.shown.port === event.port) usePreviewStore.setState({ shown: { ...state.shown, status: event.status } });
}
/** What the host offers and shows now, after the window (re)loads. */
export async function loadPreviews() {
  const value = await workbench<NonNullable<PreviewResponse>>({ action: 'preview-list' }).catch(() => null); if (!value) return;
  const offers = Object.fromEntries(value.offers.map((offer) => [offer.sessionId, offer]));
  const shown = value.shown ? { ...value.shown, url: value.offers.find((offer) => offer.sessionId === value.shown!.sessionId && offer.port === value.shown!.port)?.url ?? `localhost:${value.shown.port}` } : null;
  usePreviewStore.setState({ offers, shown });
}
