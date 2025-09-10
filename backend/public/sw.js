/* Basic cache-first service worker for static assets */
const CACHE_VERSION = 'kk-v1';
const CACHE_NAME = `static-${CACHE_VERSION}`;
const ASSET_EXT = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Precache minimal critical assets; rest will be cached on-demand
    await cache.addAll([
      '/',
      '/styles.css',
      '/config.js',
    ].filter(Boolean));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('static-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only same-origin static assets and HTML shell
  const isSameOrigin = url.origin === self.location.origin;
  const isAsset = ASSET_EXT.test(url.pathname);
  const isHtml = req.headers.get('accept')?.includes('text/html');
  if (!isSameOrigin || (!isAsset && !isHtml)) return;

  // Cache-first for assets, network-first for HTML
  if (isAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); }
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
  } else if (isHtml) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); }
        return res;
      } catch (e) {
        // Offline: try cached shell
        const cached = await cache.match('/');
        return cached || Response.error();
      }
    })());
  }
});
