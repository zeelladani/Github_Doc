const CACHE_NAME = 'docvault-v2'; // Changed version to force an update
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  self.skipWaiting(); // Force the new service worker to take over immediately
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  // Delete any old caches
  e.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) return caches.delete(cache);
        })
      );
    })
  );
});

self.addEventListener('fetch', (e) => {
  // Ignore GitHub API requests
  if (e.request.method !== 'GET' || e.request.url.includes('api.github.com')) return;

  // NETWORK FIRST strategy: Try to get the latest file from Netlify/GitHub.
  // If offline, fall back to the cache.
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // If we got a valid response, clone it and update the cache
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // If network fails (offline), serve from cache
        return caches.match(e.request);
      })
  );
});