// Service worker do MarketLandia.
// - Nunca guarda /api/ (os dados vêm sempre do servidor).
// - A página principal é buscada na rede primeiro, então toda atualização do index.html chega sozinha.
// - Sem internet, abre a última versão guardada (o sistema avisa que está sem banco de dados).
const CACHE = 'marketlandia-v1';
const SHELL = ['./', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./').then(r => r || caches.match(req)))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
