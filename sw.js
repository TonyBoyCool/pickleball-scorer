// Offline cache: app files, libraries and the detector model are kept after the first load,
// so the app still starts at courts with weak signal.
const CACHE = 'pb-cam-v1';
const SHELL = ['./', './index.html', './app.js', './engine.js', './vision.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const local = new URL(e.request.url).origin === location.origin;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    // own files: network first so updates arrive; libraries and model: cache first
    return local ? net.then((r) => r || hit) : (hit || net);
  }));
});
