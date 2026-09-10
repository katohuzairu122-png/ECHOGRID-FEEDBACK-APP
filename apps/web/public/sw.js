const CACHE_NAME = 'echo-grid-shell-v1';
// Cloudflare's static-asset serving 307-redirects this to the extension-
// less /offline in production (its default html_handling behavior) -- kept
// as /offline.html anyway since that's the one path that resolves in both
// environments (Next's local dev server has no such redirect, so /offline
// alone would 404 there). fetch()'s default redirect:'follow' resolves the
// production hop transparently before Cache.put() stores it, so this isn't
// an opaque-redirect response Cache.add() would reject.
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
// Last-resort body for the one case the cached shell cannot cover: the
// network is gone AND the cached copy is missing (install's cache.add()
// failed, storage was evicted under pressure, or the user cleared site
// data). Inline rather than a second cache entry -- anything that lives in
// the cache can be absent for exactly the same reasons, so a fallback that
// needs a cache hit is not a fallback.
const LAST_RESORT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px/1.5 system-ui,sans-serif;color:#1f2937;background:#f9fafb;padding:24px}
main{text-align:center;max-width:32rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;color:#6b7280}</style></head>
<body><main><h1>You're offline</h1>
<p>Check your connection and try again.</p></main></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      // Scoped to this worker's own cache rather than caches.match()'s
      // all-caches search, so a stale shell left by an older CACHE_NAME can
      // never be what gets served here.
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(OFFLINE_URL);

      // The `??` is the whole point of this handler's shape. A cache miss
      // resolves undefined, and respondWith(undefined) is a TypeError, which
      // the browser surfaces as a raw network-error page -- turning one
      // dropped connection into what reads like a dead site. On mobile,
      // where connections drop constantly, that is the difference this
      // worker exists to make.
      return (
        cached ??
        new Response(LAST_RESORT_HTML, {
          // 503, not 200: the page is genuinely not being served, and a
          // navigation that lies about that can be cached or bookmarked as
          // though it were the real content.
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      );
    }),
  );
});
