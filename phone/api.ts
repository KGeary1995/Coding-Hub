import type { RemoteChannel } from '../shared/remote';

/** The phone's device key, given once when it paired. */
const KEY = 'trace-remote-token';
export const token = { get: () => localStorage.getItem(KEY), set: (value: string) => localStorage.setItem(KEY, value), clear: () => localStorage.removeItem(KEY) };

/** `home` is false when another computer, reached directly, no longer accepts this phone; only its key is dropped. */
export class Unpaired extends Error { constructor(readonly home = true) { super('This phone is not paired. Pair it again from Settings on the computer.'); } }

/**
 * Another of the person's computers this phone can reach directly, with a phone key the computer that served this app
 * fetched for it. Used when that computer is off, so one app on the phone works with whichever computer is on.
 */
export interface Sibling { id: string; name: string; url: string; token: string }
const SIBLINGS = 'trace-remote-computers'; const HOME_NAME = 'trace-remote-home-name';
export const siblings = {
  list: (): Sibling[] => { try { const value = JSON.parse(localStorage.getItem(SIBLINGS) ?? '[]') as Sibling[]; return Array.isArray(value) ? value : []; } catch { return []; } },
  save: (list: Sibling[]) => localStorage.setItem(SIBLINGS, JSON.stringify(list)),
  remove: (id: string) => siblings.save(siblings.list().filter((item) => item.id !== id)),
};
export const homeName = () => localStorage.getItem(HOME_NAME);

/** Where requests go: the computer that served this app (`id` null), or another one directly. */
export interface Target { id: string | null; name: string | null; base: string; key: () => string | null }
const home: Target = { id: null, name: null, base: '', key: () => token.get() };
const direct = (sibling: Sibling): Target => ({ id: sibling.id, name: sibling.name, base: sibling.url.replace(/\/$/, ''), key: () => sibling.token });
let active: Target = home;
/** The computer the phone is talking to now. */
export const activeTarget = () => active;

export async function api(path: string, init: RequestInit = {}, target: Target = active) {
  const response = await fetch(target.base + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${target.key() ?? ''}`, 'Content-Type': 'application/json' } });
  if (response.status === 401) { if (target.id) { siblings.remove(target.id); throw new Unpaired(false); } token.clear(); throw new Unpaired(); }
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? 'The computer did not accept the request.');
  return response;
}

export async function pair(code: string, name: string) {
  const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
  const body = await response.json().catch(() => ({})) as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error ?? 'Pairing failed.');
  token.set(body.token);
}

/** The most the computer takes in one piece of input. */
export const INPUT_LIMIT = 4096;
let queue: Promise<unknown> = Promise.resolve();
/** Input goes out one request at a time, in the order it was typed, so "y" then Enter can never arrive reversed. */
export function send(sessionId: string, runId: string, data: string) {
  const body = JSON.stringify({ sessionId, runId, data });
  const delivery = queue.then(() => api('/api/input', { method: 'POST', body })); queue = delivery.catch(() => {});
  return delivery;
}
/** Asks the computer to draw a channel at this phone's size (it gives it back to the desktop when asked or when the phone leaves). */
/** Resolves true when the channel is now drawn at the phone's size; false while the computer is in use (it wins). */
export const sizeChannel = async (sessionId: string, runId: string, cols: number, rows: number, force = false) => {
  const response = await api('/api/size', { method: 'POST', body: JSON.stringify({ sessionId, runId, cols, rows, ...(force ? { force } : {}) }) });
  // Computers from before this change apply every request.
  return (await response.json().catch(() => ({})) as { held?: boolean }).held !== false;
};
export const releaseChannel = (sessionId: string) => api('/api/size', { method: 'DELETE', body: JSON.stringify({ sessionId }) });

/** Removes this phone from its computer and from every other computer it could reach directly. */
export const unpair = async () => {
  await Promise.all(siblings.list().map((sibling) => api('/api/unpair', { method: 'POST' }, direct(sibling)).catch(() => {})));
  siblings.save([]); await api('/api/unpair', { method: 'POST' }, home).finally(() => token.clear());
};

/**
 * Asks the computer that served this app for keys to the other computers linked to it, so the phone can still reach
 * them if this one is off. Only computers it has no key for yet are asked for.
 */
export async function collectKeys() {
  if (active !== home) return;
  const info = await (await api('/api/computers', {}, home)).json() as { self: { id: string; name: string } | null; others: { id: string; name: string }[] };
  if (info.self) localStorage.setItem(HOME_NAME, info.self.name);
  const known = new Set(siblings.list().map((item) => item.id));
  for (const other of info.others) if (!known.has(other.id)) {
    try { const sibling = await (await api('/api/computer-key', { method: 'POST', body: JSON.stringify({ id: other.id }) }, home)).json() as Sibling; if (sibling.token && sibling.url) siblings.save([...siblings.list().filter((item) => item.id !== sibling.id), sibling]); }
    catch { /* Asked again on the next connection. */ }
  }
}

/** Whether this browser can receive alerts here; on iPhone and iPad that needs Trace added to the Home Screen first. */
export function alertsSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
// Alerts come from the computer that served this app: a browser takes push messages from one computer's key here.
export async function alertsOn() { return ((await (await api('/api/alerts', {}, home)).json()) as { on: boolean }).on; }
/** Asks for permission, subscribes with the computer's key and hands the subscription to the computer. */
export async function enableAlerts() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Alerts are blocked for Trace in this browser’s settings.');
  const { publicKey } = await (await api('/api/alerts', {}, home)).json() as { publicKey: string };
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  const existing = await registration.pushManager.getSubscription();
  // A subscription made for another computer's key cannot carry this one's alerts.
  if (existing && existing.options.applicationServerKey && new Uint8Array(existing.options.applicationServerKey).join() !== key.join()) await existing.unsubscribe();
  const subscription = (await registration.pushManager.getSubscription()) ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/alerts', { method: 'POST', body: JSON.stringify(subscription.toJSON()) }, home);
}
export async function disableAlerts() {
  await api('/api/alerts', { method: 'DELETE' }, home);
  await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
}

export type StreamEvent =
  | { type: 'channels'; data: RemoteChannel[] }
  | { type: 'output'; data: { sessionId: string; runId: string; data: string } }
  /** The channel's screen as it is now, at the size it is drawn at. */
  | { type: 'replay'; data: { sessionId: string; runId: string; data: string; cols: number; rows: number } }
  | { type: 'resize'; data: { sessionId: string; runId: string; cols: number; rows: number } };

/**
 * Follows a computer's event stream (server-sent events read through fetch, which can send the device key): the one
 * that served this app when it answers, otherwise each other computer the phone has a key for, directly. It reconnects
 * after a drop until `stop` is called, trying this app's computer first each time, and while on another computer it
 * checks every 30 seconds whether this app's computer is back. `onState` reports the connection and which computer.
 */
export function follow(sessionId: string | null, onEvent: (event: StreamEvent) => void, onState: (connected: boolean, via: Target) => void, onUnpaired: () => void) {
  let stopped = false; let controller: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      for (const target of [home, ...siblings.list().map(direct)]) {
        if (stopped) return;
        controller = new AbortController(); const connecting = setTimeout(() => controller?.abort(), 6000); let back: ReturnType<typeof setInterval> | null = null;
        try {
          const response = await api('/api/stream' + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''), { signal: controller.signal }, target);
          clearTimeout(connecting); active = target; onState(true, target);
          if (target !== home) {
            const current = controller;
            back = setInterval(() => { void api('/api/computers', { signal: AbortSignal.timeout(4000) }, home).then(() => current.abort()).catch(() => {}); }, 30000);
          }
          const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
          // The computer sends a heartbeat every 25 seconds: a connection silent for a minute has stalled (the network
          // dropped it without saying so), and is replaced rather than left showing "live".
          const current = controller; let silence: ReturnType<typeof setTimeout> | null = null;
          const listen = () => { if (silence) clearTimeout(silence); silence = setTimeout(() => current.abort(), 60000); };
          for (;;) {
            listen(); let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await reader.read(); } finally { if (silence) clearTimeout(silence); }
            const { value, done } = next; if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end; while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
              if (type && data) onEvent({ type, data: JSON.parse(data) } as StreamEvent);
            }
          }
          break;
        } catch (error) {
          if (error instanceof Unpaired && error.home) { stopped = true; onUnpaired(); return; }
          if (active === target && target !== home) break;
        } finally { clearTimeout(connecting); if (back) clearInterval(back); }
      }
      if (stopped) return;
      onState(false, active); await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  void run();
  return () => { stopped = true; controller?.abort(); };
}
