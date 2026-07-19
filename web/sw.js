// Caches only the sender app shell. Documents, signing pages and every /api
// call go straight to the network — stale or cached PDFs would be a bug, and a
// cached signing page would be a security problem.

const CACHE = 'mobile-signature-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
    caches.match(event.request).then((hit) => hit || fetch(event.request)),
  );
});
