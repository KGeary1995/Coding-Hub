/**
 * App preview (1.39.0): a dev server's address a channel printed (Vite's "Local: http://localhost:5173/", Next.js, Create
 * React App, Python's http.server…), shown in Trace and on the phone. Only this computer's own loopback addresses over
 * http, on ports 1024-65535, count: anything else a channel prints is never offered or loaded.
 */
export interface PreviewAddress { host: 'localhost' | '127.0.0.1' | '[::1]'; port: number; url: string }
/** What the window shows for a channel: its latest address, and whether the preview is open on it and loading or stopped. */
export interface PreviewOffer { sessionId: string; port: number; url: string }
export type PreviewStatus = 'loading' | 'ready' | 'stopped';
/** `found`: a channel printed an address it had not printed in this run (`fresh` the first in the run, to open by itself). */
export type PreviewEvent = { type: 'found'; offer: PreviewOffer; fresh: boolean } | { type: 'gone'; sessionId: string } | { type: 'status'; sessionId: string; port: number; status: PreviewStatus };
export type PreviewRequest = { action: 'preview-list' } | { action: 'preview-show'; sessionId: string; port: number }
  /** Where the window keeps room for the page, in its own CSS pixels; null hides it (another page of Trace is in front). */
  | { action: 'preview-bounds'; bounds: { x: number; y: number; width: number; height: number } | null }
  | { action: 'preview-reload' } | { action: 'preview-browser' } | { action: 'preview-close' };
export type PreviewResponse = { offers: PreviewOffer[]; shown: { sessionId: string; port: number; status: PreviewStatus } | null } | null;

/** Terminal control sequences (colours, cursor moves, titles), which Vite puts inside the address itself ("localhost:\x1b[1m5173\x1b[22m"). */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
export const plainText = (text: string) => text.replace(CONTROL, (match) => match === '\r' || match === '\n' ? match : '');
/**
 * A loopback http address with its port, followed by something that is not a digit (an address at the very end of what
 * has arrived may still be growing: "localhost:51" then "73"). 0.0.0.0 and [::] mean "every address", which includes loopback.
 */
const ADDRESS = /\bhttp:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d{1,5})(?=[^\d])/gi;
const LOOPBACK = { 'localhost': 'localhost', '127.0.0.1': '127.0.0.1', '[::1]': '[::1]', '0.0.0.0': '127.0.0.1', '[::]': '[::1]' } as const;
export const previewUrl = (host: PreviewAddress['host'], port: number) => `http://${host}:${port}/`;
/** Every dev-server address in `text`, in order, each once. */
export function previewAddresses(text: string): PreviewAddress[] {
  const found: PreviewAddress[] = [];
  for (const match of plainText(text).matchAll(ADDRESS)) {
    const host = LOOPBACK[match[1].toLowerCase() as keyof typeof LOOPBACK]; const port = Number(match[2]);
    if (port < 1024 || port > 65535 || found.some((item) => item.host === host && item.port === port)) continue;
    found.push({ host, port, url: previewUrl(host, port) });
  }
  return found;
}
/** How much of a run's earlier output is kept, so an address split between two pieces of output is still found. */
const CARRY = 256;
/** Finds addresses in a run's output as it arrives, piece by piece. */
export class PreviewDetector {
  private carried = new Map<string, string>();
  feed(runId: string, chunk: string): PreviewAddress[] { const text = (this.carried.get(runId) ?? '') + chunk; this.carried.set(runId, text.slice(-CARRY)); return previewAddresses(text); }
  forget(runId: string) { this.carried.delete(runId); }
}
/**
 * Where a page in the preview may go: its own address (`allow`), another web address (`external`: the system browser
 * opens it), or nowhere (`block`: file:, javascript:, data: and the rest).
 */
export function previewNavigation(target: string, shown: string): 'allow' | 'external' | 'block' {
  let url: URL; let own: URL; try { url = new URL(target); own = new URL(shown); } catch { return 'block'; }
  if (url.protocol === 'http:' && url.origin === own.origin) return 'allow';
  return url.protocol === 'http:' || url.protocol === 'https:' ? 'external' : 'block';
}
/** "localhost:5173", as the tile and the phone name it. */
export const previewLabel = (url: string) => url.replace(/^http:\/\//, '').replace(/\/$/, '');
