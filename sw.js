/* Akshardham Tasks — Service Worker v1 */
const CACHE_NAME = 'aa-tasks-v1';
const STATIC_ASSETS = [
  './akshardham-ops-v6.html',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.30.0/dist/tabler-icons.min.css'
];

/* Install: cache static assets */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS).catch(function(e) {
        console.log('SW install cache error (non-fatal):', e);
      });
    })
  );
  self.skipWaiting();
});

/* Activate: clean old caches */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

/* Fetch: network-first for API, cache-first for assets */
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  /* API calls (Apps Script) — always network, no cache */
  if (url.indexOf('script.google.com') !== -1) {
    event.respondWith(fetch(event.request).catch(function() {
      return new Response(JSON.stringify({
        ok: false,
        error: 'You are offline. Please check your connection and try again.'
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  /* Google Fonts / CDN — cache first, network fallback */
  if (url.indexOf('fonts.googleapis.com') !== -1 ||
      url.indexOf('fonts.gstatic.com') !== -1 ||
      url.indexOf('cdn.jsdelivr.net') !== -1) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        return cached || fetch(event.request).then(function(response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          return response;
        });
      })
    );
    return;
  }

  /* HTML app — network first, cache fallback (offline support) */
  if (url.indexOf('akshardham-ops-v6.html') !== -1 || url.endsWith('/')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        return response;
      }).catch(function() {
        return caches.match('./akshardham-ops-v6.html');
      })
    );
    return;
  }

  /* Everything else — network */
  event.respondWith(fetch(event.request));
});

/* Push notifications (when supported) */
self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  var title = data.title || 'Akshardham Tasks';
  var options = {
    body:    data.body    || 'You have a new notification',
    icon:    'icon-192.png',
    badge:   'icon-72.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url === event.notification.data.url && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data.url);
    })
  );
});
