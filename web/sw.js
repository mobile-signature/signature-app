// Caches only the sender app shell. Documents, signing pages and every /api
// call go straight to the network — stale or cached PDFs would be a bug, and a
// cached signing page would be a security problem.
//
// Strategy is NETWORK-FIRST for the shell, with the cache as an offline
// fallback. Cache-first looks faster but means a deployed fix never reaches
// anyone who already opened the app: they keep running the version they first
// loaded, forever.

const CACHE = 'mobile-signature-v5';
const SHELL = [
  '/', '/index.html', '/app.js', '/styles.css',
  '/icon.svg', '/saka-logo.jpg', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}) // a failed pre-cache must not block activation
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const bypass =
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/s/');

  if (bypass) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Refresh the cached copy so the app still opens offline.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || Promise.reject(new Error('offline')))),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
