const CACHE_NAME = 'quadrate-notes-static-v1';
const STATIC_DESTINATIONS = new Set(['script', 'style', 'font', 'image']);
const OFFLINE_DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quadrate Notes offline</title><style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:15vh auto;padding:1.5rem;color:#1d252c;background:#f7f4ee}main{background:white;border:1px solid #d8d0c2;border-radius:1rem;padding:2rem}h1{margin-top:0}</style></head><body><main><p>Quadrate Notes</p><h1>You are offline</h1><p>The workspace could not be loaded. Reconnect and try again. Local drafts in this browser are left untouched.</p></main></body></html>`;

function offlineResponse() {
  return new Response(OFFLINE_DOCUMENT, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/functions/') || url.pathname.startsWith('/storage/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/').then((cached) => cached ?? offlineResponse()).catch(() => offlineResponse())));
    return;
  }
  if (!STATIC_DESTINATIONS.has(request.destination)) return;
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
    }
    return response;
  })));
});
