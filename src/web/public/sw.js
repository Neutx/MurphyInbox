// MurphyInbox service worker: shows push notifications, and keeps the app and recently opened mail
// readable offline. It never fetches anything on its own: every request it caches is one the app
// made anyway, so it adds no Worker requests.
const SHELL = 'shell-v2';
const DATA = 'api-v1';
const MAX_API_ENTRIES = 300;
// Live data that is useless (or wrong) when replayed offline.
// The session itself is kept, so a signed-in app opens offline; sign-out clears it.
const NO_CACHE = [/^\/api\/sync/, /^\/api\/auth\/(?!session$)/, /^\/api\/setup/, /\/attachments?\//, /\/raw(\/|$)/, /\/download/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_API_ENTRIES; i++) await cache.delete(keys[i]);
}

function offlineJson() {
  return new Response(JSON.stringify({ error: { code: 'offline', message: "You're offline. This hasn't been opened on this device yet." } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: network first, then the cached app shell (the SPA handles the route).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/', { cacheName: SHELL }).then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req, { cacheName: SHELL }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Mail data: always the network when online; the last copy when offline.
  if (url.pathname.startsWith('/api/') && !NO_CACHE.some((r) => r.test(url.pathname))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 401) caches.delete(DATA);
          else if (res.ok && (res.headers.get('Content-Type') || '').includes('application/json')) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy).then(() => trim(c)));
          }
          return res;
        })
        .catch(() => caches.match(req, { cacheName: DATA }).then((r) => r || offlineJson())),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-data') event.waitUntil(caches.delete(DATA));
});

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: 'New mail', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const watching = windows.some((w) => w.visibilityState === 'visible' && w.focused);
      // Browsers require a notification for every push, so while the app is in front it is silent.
      await self.registration.showNotification(d.title || 'New mail', {
        body: d.body || '',
        tag: d.tag,
        renotify: !!d.tag && !watching,
        silent: watching && d.kind !== 'test',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: d.url || '/mail' },
      });
      for (const w of windows) w.postMessage({ type: 'push', kind: d.kind });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/mail', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
