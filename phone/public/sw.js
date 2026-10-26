// Trace phone app service worker: shows alerts Trace sends when a channel needs the person, and opens that channel
// when one is tapped. It also keeps a copy of the app itself (never anything from /api/), loaded from the computer
// whenever it answers, so the app still opens while that computer is off and can reach the person's other computer.
const SHELL = 'trace-shell-v1';
self.addEventListener('fetch', (event) => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = request.mode === 'navigate' ? '/' : request;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try { const response = await fetch(request); if (response.ok) await cache.put(key, response.clone()); return response; }
    catch { return (await cache.match(key)) || Response.error(); }
  })());
});
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
