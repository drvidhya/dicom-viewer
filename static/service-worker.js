/**
 * Cache-first handler for /dicom/data/* (manifest + DICOM) to avoid repeat downloads
 * across main window and viewer popups.
 *
 * Keep CACHE_NAME in sync with DICOM_SW_CACHE_NAME in src/dicom-cache.ts
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `dicom-viewer-data-${CACHE_VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('dicom-viewer-data-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * @param {URL} url
 */
function shouldCache(url) {
  return url.pathname.startsWith('/dicom/data/');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!shouldCache(url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) {
        try {
          await cache.put(event.request, response.clone());
        } catch (e) {
          console.warn('[dicom-viewer-sw] cache.put failed:', e);
        }
      }
      return response;
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
