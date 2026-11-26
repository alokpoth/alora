/* Alora AI - Progressive Web App Service Worker (v3.7.0) */
const CACHE_NAME = 'alora-ai-v3.7.0';

// Core assets to pre-cache on service worker install
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/download.html',
  '/account.html',
  '/plans.html',
  '/checkout.html',
  '/login.html',
  '/profile.html',
  '/security.html',
  '/personalization.html',
  '/help.html',
  '/redeem.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  '/app_logo.png',
  '/logo_icon_white.png',
  '/logo_icon_black.png',
  '/logo_wordmark_white.png',
  '/logo_wordmark_black.png',
  '/alokpath_logo_dark.png',
  '/alokpath_logo_light.png',
  '/alokpath_icon_dark.png',
  '/alokpath_icon_light.png',
  '/alokpath_logo.svg'
];

/**
 * Service Worker Installation
 * Pre-caches critical app shell assets with resilient error handling
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Pre-caching core assets...');
      await Promise.allSettled(
        CORE_ASSETS.map(async (asset) => {
          try {
            const response = await fetch(asset, { cache: 'no-cache' });
            if (response.ok) {
              await cache.put(asset, response);
            } else {
              console.warn(`[SW] Pre-cache skipped for ${asset} (status: ${response.status})`);
            }
          } catch (err) {
            console.warn(`[SW] Pre-cache network failure for ${asset}:`, err.message);
          }
        })
      );
      console.log('[SW] Core assets pre-caching finished');
    }).then(() => self.skipWaiting())
  );
});

/**
 * Service Worker Activation
 * Cleans up previous cache versions and takes immediate control
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[SW] Removing outdated cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/**
 * Client Message Listener
 * Allows clients to trigger skipWaiting
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

/**
 * Push Notification Support
 */
self.addEventListener('push', (event) => {
  let data = {
    title: 'Alora AI',
    body: 'New update or message available',
    icon: '/favicon.png',
    badge: '/favicon-32x32.png',
    url: '/'
  };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/favicon.png',
    badge: data.badge || '/favicon-32x32.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/**
 * Notification Click Handler
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

/**
 * Check if a request is an API, dynamic data, or binary download
 * These MUST NEVER be cached in CacheStorage to prevent stale auth/chat data
 */
function isDynamicOrApiRequest(url, req) {
  // Non-GET requests (POST, PUT, DELETE, PATCH, etc.)
  if (req.method !== 'GET') return true;

  const path = url.pathname;

  // Backend API and dynamic routes
  if (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/auth' ||
    path.startsWith('/auth/') ||
    path === '/chat' ||
    path.startsWith('/chat/') ||
    path === '/redeem' ||
    path.startsWith('/redeem/') ||
    path === '/payments' ||
    path.startsWith('/payments/') ||
    path === '/search' ||
    path.startsWith('/search/') ||
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/zihan' ||
    path.startsWith('/zihan/') ||
    path === '/zihan.html' ||
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/debug-route'
  ) {
    return true;
  }

  // App binaries / large downloads
  if (
    path.endsWith('.apk') ||
    path.endsWith('.ipa') ||
    path.endsWith('.zip') ||
    path.endsWith('.tar.gz')
  ) {
    return true;
  }

  // Anti-cache / timestamp parameters
  if (url.searchParams.has('_t') || url.searchParams.has('nocache') || url.searchParams.has('timestamp')) {
    return true;
  }

  // External APIs (e.g., LLM providers, OAuth endpoints)
  if (url.origin !== self.location.origin) {
    const host = url.hostname;
    if (
      host.includes('googleapis.com') ||
      host.includes('openrouter.ai') ||
      host.includes('groq.com') ||
      host.includes('anthropic.com') ||
      host.includes('openai.com') ||
      host.includes('huggingface.co') ||
      host.includes('pollinations.ai') ||
      host.includes('onrender.com') ||
      host.includes('render.com')
    ) {
      return true;
    }
  }

  return false;
}

function makeOfflineApiResponse() {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'Network connection lost. Please check your internet connection.',
      offline: true
    }),
    {
      status: 503,
      statusText: 'Service Unavailable (Offline)',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      }
    }
  );
}

/**
 * Fetch Event Handler
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle HTTP(S) schemes (skip chrome-extension:, data:, blob:, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // Always let browser handle API navigations/OAuth redirects directly without SW interception
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (req.mode === 'navigate' || req.destination === 'document' || req.method !== 'GET') {
      return;
    }
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(makeOfflineApiResponse));
    return;
  }

  // 1. Dynamic & Non-GET Requests: Strictly Network-Only (NEVER CACHED)
  // Page navigations are NOT API calls: routes like /redeem and /admin are real pages
  // (see vercel.json) and must reach the navigation branch below, even offline.
  const isPageNavigation = req.mode === 'navigate' ||
    req.destination === 'document' ||
    (req.headers.get('accept') && req.headers.get('accept').includes('text/html'));
  if (!isPageNavigation && isDynamicOrApiRequest(url, req)) {
    // For non-GET requests, pass through without service worker interception so browser handles it natively
    if (req.method !== 'GET') {
      return;
    }

    // For GET dynamic requests, perform network-only fetch and return clean offline JSON if disconnected
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(makeOfflineApiResponse));
    return;
  }

  // 2. HTML Navigation Requests (Page Loads): Network-First with Cache Fallback
  if (isPageNavigation) {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // Direct cache match
          const cached = await caches.match(req);
          if (cached) return cached;

          // Clean URL & ChatGPT Route Mapping
          const cleanPath = url.pathname.replace(/\/+$/, '') || '/';
          if (cleanPath === '/auth/login' || cleanPath === '/auth/signup' || cleanPath === '/login' || cleanPath === '/signup') {
            const authCached = await caches.match('/login.html');
            if (authCached) return authCached;
          }
          if (cleanPath === '/pricing' || cleanPath === '/plans') {
            const plansCached = await caches.match('/plans.html');
            if (plansCached) return plansCached;
          }
          if (cleanPath.startsWith('/c/') || cleanPath.startsWith('/share/') || cleanPath.startsWith('/settings')) {
            const appCached = (await caches.match('/index.html')) || (await caches.match('/'));
            if (appCached) return appCached;
          }
          const htmlPath = cleanPath.endsWith('.html') ? cleanPath : `${cleanPath}.html`;
          const altCached = await caches.match(htmlPath);
          if (altCached) return altCached;

          // Fallback to home page
          const fallback = (await caches.match('/index.html')) || (await caches.match('/'));
          if (fallback) return fallback;

          // Final monochrome offline page fallback
          return new Response(
            `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline — Alora</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #212121; color: #ececec; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; padding: 24px; box-sizing: border-box; }
    .box { max-width: 400px; background: #2a2a2a; border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; padding: 32px 24px; box-shadow: none; }
    h1 { font-size: 1.35rem; margin-bottom: 10px; font-weight: 700; }
    p { color: #b4b4b4; font-size: 0.92rem; line-height: 1.6; margin-bottom: 24px; }
    button { background: #ffffff; color: #000000; border: none; padding: 12px 28px; border-radius: 9999px; font-weight: 600; cursor: pointer; font-size: 0.95rem; transition: opacity 0.2s; }
    button:active { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="box">
    <h1>You are offline</h1>
    <p>Internet connection lost. Please check your network and reload.</p>
    <button onclick="window.location.reload()">Try again</button>
  </div>
</body>
</html>`,
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // 3. Static Assets (CSS, JS, Fonts, Images): Cache-First with Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => null);

      return cachedResponse || fetchPromise.then((response) => {
        if (response) return response;
        return new Response('Asset unavailable offline', { status: 408 });
      });
    })
  );
});
