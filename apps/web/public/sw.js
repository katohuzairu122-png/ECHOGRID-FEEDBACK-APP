const CACHE_NAME = 'echo-grid-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for page navigations, falling back to a cached offline shell
// when the network is unreachable. Every other request (API calls, dashboard
// data, anything carrying a session) passes straight through untouched --
// this app is almost entirely dynamic and authenticated, so caching
// responses beyond the static offline shell would risk serving stale or
// cross-session data on a shared device. This worker exists to satisfy
// PWA install criteria and give a graceful offline screen, not to make the
// app usable offline.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;

  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
