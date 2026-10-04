// Offline support: cache the app shell. Deck + audio are stored by the app itself.
const VERSION = 'v6';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/github.js', 'js/check.js', 'js/sched.js', 'js/sync.js', 'js/stats.js', 'js/charts.js', 'js/obsidian.js',
  'vendor/ts-fsrs.mjs', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open('shell-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== 'shell-' + VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/__audio/')) return;
  // network first (so updates arrive), fall back to cache when offline
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });  // always revalidate, so updates show up straight away
      if (res.ok) (await caches.open('shell-' + VERSION)).put(e.request, res.clone());
      return res;
    } catch {
      return (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match('index.html'));
    }
  })());
});
