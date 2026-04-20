import { prefetchAll } from './dicom';

/**
 * Must match CACHE_NAME in `static/service-worker.js` (copied to dist root on build).
 * Bump the version suffix in both places when the caching strategy changes.
 */
export const DICOM_SW_CACHE_NAME = 'dicom-viewer-data-v2';
export const DICOM_HTTP_CACHE_PREFIX = 'dicom-viewer-data-';

function serviceWorkerScriptUrl(): string {
  const base = import.meta.env.BASE_URL;
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return `${normalized}service-worker.js`;
}

/** Register the DICOM file cache worker; safe to call from every tab. */
export async function registerDicomServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(serviceWorkerScriptUrl());
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

/** Remove all dicom-viewer-data-* Cache Storage buckets (same-origin). */
export async function evictDicomHttpCache(): Promise<number> {
  if (!('caches' in window)) return 0;
  const keys = await caches.keys();
  const ours = keys.filter((k) => k.startsWith(DICOM_HTTP_CACHE_PREFIX));
  await Promise.all(ours.map((k) => caches.delete(k)));
  return ours.length;
}

/** Evict HTTP cache entries then download every slice again (repopulates Cache Storage). */
export async function rebuildDicomHttpCache(
  imageIds: string[],
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress('Clearing HTTP cache…');
  await evictDicomHttpCache();
  onProgress('Refetching series…');
  await prefetchAll(imageIds, (loaded, total) => onProgress(`Refetching ${loaded} / ${total}`));
}

export async function countDicomCacheEntries(): Promise<number> {
  if (!('caches' in window)) return 0;
  const cache = await caches.open(DICOM_SW_CACHE_NAME);
  const keys = await cache.keys();
  return keys.length;
}
