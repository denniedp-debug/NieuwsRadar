// Service worker: app-shell offline, API network-first met cache als terugval.
const SHELL = 'nr-shell-v7';
const API = 'nr-api-v7';
const ASSETS = ['/', '/static/style.css', '/static/app.js', '/manifest.webmanifest', '/static/icons/icon.svg', '/static/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, API].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(API).then((c) => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // shell: cache eerst, op de achtergrond verversen
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => hit);
      return hit || net;
    })
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'NieuwsRadar', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NieuwsRadar', {
    body: d.body || '',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
    requireInteraction: (d.priority || 3) >= 5,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) { c.navigate(target); return c.focus(); }
    }
    return clients.openWindow(target);
  }));
});
