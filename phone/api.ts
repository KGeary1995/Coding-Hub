import type { RemoteChannel } from '../shared/remote';

/** The phone's device key, given once when it paired. */
const KEY = 'trace-remote-token';
export const token = { get: () => localStorage.getItem(KEY), set: (value: string) => localStorage.setItem(KEY, value), clear: () => localStorage.removeItem(KEY) };

export class Unpaired extends Error { constructor() { super('This phone is not paired. Pair it again from Settings on the computer.'); } }

export async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token.get() ?? ''}`, 'Content-Type': 'application/json' } });
  if (response.status === 401) { token.clear(); throw new Unpaired(); }
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
export const unpair = () => api('/api/unpair', { method: 'POST' }).finally(() => token.clear());

/** Whether this browser can receive alerts here; on iPhone and iPad that needs Trace added to the Home Screen first. */
export function alertsSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
export async function alertsOn() { return ((await (await api('/api/alerts')).json()) as { on: boolean }).on; }
/** Asks for permission, subscribes with the computer's key and hands the subscription to the computer. */
export async function enableAlerts() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Alerts are blocked for Trace in this browser’s settings.');
  const { publicKey } = await (await api('/api/alerts')).json() as { publicKey: string };
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  const existing = await registration.pushManager.getSubscription();
  // A subscription made for another computer's key cannot carry this one's alerts.
  if (existing && existing.options.applicationServerKey && new Uint8Array(existing.options.applicationServerKey).join() !== key.join()) await existing.unsubscribe();
  const subscription = (await registration.pushManager.getSubscription()) ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/alerts', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
}
export async function disableAlerts() {
  await api('/api/alerts', { method: 'DELETE' });
  await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
}

export type StreamEvent =
  | { type: 'channels'; data: RemoteChannel[] }
  | { type: 'output'; data: { sessionId: string; runId: string; data: string } }
  /** The channel's screen as it is now, at the size it is drawn at. */
  | { type: 'replay'; data: { sessionId: string; runId: string; data: string; cols: number; rows: number } }
  | { type: 'resize'; data: { sessionId: string; runId: string; cols: number; rows: number } };

/**
 * Follows the computer's event stream (server-sent events read through fetch, which can send the device key). It
 * reconnects after a drop until `stop` is called; `onState` reports whether it is connected.
 */
export function follow(sessionId: string | null, onEvent: (event: StreamEvent) => void, onState: (connected: boolean) => void, onUnpaired: () => void) {
  let stopped = false; let controller: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await api('/api/stream' + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''), { signal: controller.signal });
        onState(true);
        const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end; while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
            if (type && data) onEvent({ type, data: JSON.parse(data) } as StreamEvent);
          }
        }
      } catch (error) {
        if (error instanceof Unpaired) { stopped = true; onUnpaired(); return; }
      }
      if (stopped) return;
      onState(false); await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  void run();
  return () => { stopped = true; controller?.abort(); };
}
