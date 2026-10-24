// Trace phone app service worker: shows alerts Trace sends when a channel needs the person, and opens that channel
// when one is tapped. It caches nothing; the app always loads from the computer.
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
