// Lets the planner open without internet once it has been loaded.
// Network first, so updates show up as soon as you're online.
const CACHE = 'pen-planner-v3';
const FILES = ['./', 'index.html', 'pen.css', 'pen.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
// The PDF maker comes from a CDN: keep a copy so "⤓ PDF" works offline too.
const PDF_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES).then(() => c.add(new Request(PDF_LIB, { mode: 'cors' })).catch(() => {})))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.href === PDF_LIB) {
    e.respondWith(caches.match(PDF_LIB).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(PDF_LIB, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
