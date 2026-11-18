// Trace phone app service worker: shows alerts Trace sends when a channel needs the person, and opens that channel
// when one is tapped. It also keeps a copy of the app itself (never anything from /api/), loaded from the computer
// whenever it answers, so the app still opens while that computer is off and can reach the person's other computer.
const SHELL = 'trace-shell-v1';
/** A computer that is off or asleep can leave a request unanswered rather than refuse it: past this, the saved copy opens. */
const NETWORK_MS = 3000;
self.addEventListener('fetch', (event) => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = request.mode === 'navigate' ? '/' : request;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL); const saved = await cache.match(key);
    // Files under /assets/ are named by their content and served as immutable: a saved one is right without asking,
    // also when the page shown is an older one whose files an update removed from the computer.
    if (saved && url.pathname.startsWith('/assets/')) return saved;
    const network = fetch(request);
    if (!saved) { const response = await network.catch(() => Response.error()); if (response.ok) event.waitUntil(keep(cache, key, response.clone(), false).catch(() => {})); return response; }
    const response = await Promise.race([network.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_MS))]);
    if (response && response.status < 500) { if (response.ok) event.waitUntil(keep(cache, key, response.clone(), false).catch(() => {})); return response; }
    // No answer in time or none at all, or the computer is on but Trace is not answering (Tailscale serve replies 502
    // while Trace is closed or starting): open the saved app, which can then reach the person's other computer. A later
    // answer is still saved, so the next start has the newest app.
    event.waitUntil(network.then((late) => late.ok ? keep(cache, key, late, true) : undefined).catch(() => {}));
    return saved;
  })());
});
/** The scripts, styles and other files an app page names (`/assets/…`). */
const named = (html) => new Set([...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((match) => '/' + match[1]));
/**
 * Saves an answer for the next start. A page the browser was not given (the saved one was shown) never loaded its
 * files, so they are saved first; if one cannot be, the saved page and its files stay as they were.
 */
async function keep(cache, key, response, unseen) {
  if (key !== '/') return cache.put(key, response);
  const used = named(await response.clone().text());
  if (unseen) for (const path of used) if (!await cache.match(path)) { const file = await fetch(path); if (!file.ok) return; await cache.put(path, file); }
  await cache.put('/', response); await prune(cache, used);
}
/** Each update ships new hashed files: once a new app page is saved, forget saved assets it no longer uses. */
async function prune(cache, used) {
  // Scripts and styles only: fonts are named in the styles, not the page, and change rarely.
  for (const request of await cache.keys()) { const path = new URL(request.url).pathname; if (/^\/assets\/.+\.(js|css)$/.test(path) && !used.has(path)) await cache.delete(request); }
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: 'Trace', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(message.title || 'Trace', {
    body: message.body || '', tag: message.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { sessionId: message.sessionId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) { client.postMessage({ open: sessionId }); return client.focus(); }
    return self.clients.openWindow(sessionId ? `/#channel=${encodeURIComponent(sessionId)}` : '/');
  })());
});
