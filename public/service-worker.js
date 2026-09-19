const CACHE_NAME = 'flow-cache-v132';
const ASSETS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// API never uses cache. Pages use network-first so updates are not hidden by stale files.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if(url.pathname.startsWith('/api/')){
    return; // always go to network for API calls
  }
  event.respondWith(fetch(event.request).then(response => {
    if(event.request.method === 'GET' && response.ok){
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(()=>caches.match(event.request)));
});
