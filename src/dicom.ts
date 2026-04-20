import { imageLoader, metaData } from '@cornerstonejs/core';

/**
 * Directory URL for manifest + slices.
 *
 * Default: **`dicom/data/`** under the app’s Vite **`import.meta.env.BASE_URL`**.
 * Absolute bases (e.g. `/dicom-viewer/`) resolve from `location.origin`; relative
 * bases (e.g. `./`) resolve from the current page URL so GitHub Pages subpaths work.
 *
 * **Override:** `VITE_DICOM_DATA_BASE` — full `http(s)` URL, or a path joined to `location.origin`
 * (leading `/` optional).
 */
export function getDicomDataDirUrl(): URL {
  const envRaw = import.meta.env.VITE_DICOM_DATA_BASE?.trim();
  if (envRaw) {
    if (envRaw.startsWith('http://') || envRaw.startsWith('https://')) {
      return new URL(envRaw.endsWith('/') ? envRaw : `${envRaw}/`);
    }
    const path = envRaw.replace(/^\/+/, '');
    const withSlash = path.endsWith('/') ? path : `${path}/`;
    return new URL(withSlash, window.location.origin);
  }

  const base = (import.meta.env.BASE_URL ?? './').trim() || './';
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  /**
   * Resolve BASE_URL relative to the current page for relative values (e.g. "./"),
   * and relative to origin for absolute values (e.g. "/dicom-viewer/").
   */
  const appRootUrl = withSlash.startsWith('/')
    ? new URL(withSlash, window.location.origin)
    : new URL(withSlash, window.location.href);
  return new URL('dicom/data/', appRootUrl);
}

const DICOM_DATA_PATH_MARKER = 'dicom/data/';

/** Default XR isosurface GLB when manifest lists no `.glb` files. */
export const XR_PREVIEW_GLB_DEFAULT = 'web-preview.glb';

function manifestEntryBasename(entry: string): string {
  const trimmed = entry.replace(/^\/+/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] ?? trimmed;
}

function manifestEntryIsGlb(entry: string): boolean {
  return manifestEntryBasename(entry).toLowerCase().endsWith('.glb');
}

/**
 * Picks the XR isosurface preview file from manifest `files` paths.
 * Prefers `web-preview.glb` when present; otherwise the first `.glb` (locale-aware sort).
 */
export function pickXrPreviewGlbFilename(files: string[]): string {
  const names = files
    .filter((f) => manifestEntryIsGlb(f))
    .map((f) => manifestEntryBasename(f))
    .filter(Boolean);
  if (names.length === 0) {
    return XR_PREVIEW_GLB_DEFAULT;
  }
  if (names.includes(XR_PREVIEW_GLB_DEFAULT)) {
    return XR_PREVIEW_GLB_DEFAULT;
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return sorted[0]!;
}

/** Fetches `manifest.json` and returns the `files` array (relative paths, POSIX slashes). */
export async function fetchManifestFiles(): Promise<string[]> {
  const manifestUrl = new URL('manifest.json', getDicomDataDirUrl());
  let text: string;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`Failed to fetch manifest.json (${res.status})`);
    text = await res.text();
  } catch (e) {
    const busted = new URL(manifestUrl);
    busted.searchParams.set('refresh', `${Date.now()}`);
    const res2 = await fetch(busted, { cache: 'no-store' });
    if (!res2.ok) {
      throw new Error(
        `Failed to fetch manifest.json after retry (${res2.status}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    text = await res2.text();
  }
  return parseManifestPayload(text);
}

/** XR preview GLB basename from the current manifest (see {@link pickXrPreviewGlbFilename}). */
export async function fetchXrPreviewGlbFilename(): Promise<string> {
  const files = await fetchManifestFiles();
  return pickXrPreviewGlbFilename(files);
}

/**
 * Rewrites stored `wadouri:` ids to use the current {@link getDicomDataDirUrl} base
 * (fixes localhost vs 127.0.0.1, GitHub Pages vs dev, or older path shapes).
 */
export function normalizeWadouriImageIds(imageIds: string[]): string[] {
  const dir = getDicomDataDirUrl();
  return imageIds.map((id) => {
    if (!id.startsWith('wadouri:')) return id;
    const rest = id.slice('wadouri:'.length).trim();
    let pathname: string;
    try {
      pathname = new URL(rest).pathname;
    } catch {
      try {
        pathname = new URL(rest, 'http://placeholder.local/').pathname;
      } catch {
        return id;
      }
    }
    const trimmed = pathname.replace(/^\/+/, '');
    const idx = trimmed.indexOf(DICOM_DATA_PATH_MARKER);
    const rel =
      idx >= 0
        ? trimmed.slice(idx + DICOM_DATA_PATH_MARKER.length)
        : trimmed.split('/').filter(Boolean).pop() ?? '';
    if (!rel) return id;
    return `wadouri:${new URL(rel, dir).href}`;
  });
}

/** Slices Cornerstone can build a volume from (wadouri cache + required tags present). */
function imageIdReadyForVolume(id: string): boolean {
  const px = metaData.get('imagePixelModule', id);
  if (
    !px ||
    px.bitsAllocated == null ||
    px.bitsStored == null ||
    px.highBit == null ||
    px.pixelRepresentation == null ||
    px.photometricInterpretation == null ||
    px.samplesPerPixel == null
  ) {
    return false;
  }
  const plane = metaData.get('imagePlaneModule', id);
  if (
    !plane?.rows ||
    !plane.columns ||
    !plane.imageOrientationPatient ||
    plane.imageOrientationPatient.length < 6
  ) {
    return false;
  }
  return metaData.get('generalSeriesModule', id) != null;
}

export function imageIdsReadyForVolume(imageIds: string[]): string[] {
  return imageIds.filter(imageIdReadyForVolume);
}

function parseManifestPayload(text: string): string[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(
      `Manifest response is not JSON (starts with ${JSON.stringify(trimmed.slice(0, 24))})`,
    );
  }
  const json = JSON.parse(text);
  const files: string[] = json.files ?? json;
  if (!Array.isArray(files)) {
    throw new Error('Manifest JSON must be an array or an object with `files` array');
  }
  return files;
}

export async function fetchImageIds(): Promise<string[]> {
  const files = await fetchManifestFiles();
  const dir = getDicomDataDirUrl();
  return files
    .filter((f) => !manifestEntryIsGlb(f))
    .map((f) => {
      const rel = f.replace(/^\/+/, '');
      return `wadouri:${new URL(rel, dir).href}`;
    });
}

export async function prefetchAndSort(
  imageIds: string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<string[]> {
  const BATCH = 20;
  const total = imageIds.length;
  type Meta = { id: string; instance?: number; z?: number };
  const metas: Meta[] = [];

  for (let i = 0; i < total; i += BATCH) {
    const batch = imageIds.slice(i, Math.min(i + BATCH, total));
    await Promise.all(
      batch.map(async (id) => {
        try {
          await imageLoader.loadAndCacheImage(id);
          const gim = metaData.get('generalImageModule', id);
          const ipm = metaData.get('imagePlaneModule', id);
          metas.push({
            id,
            instance: gim?.instanceNumber,
            z: ipm?.imagePositionPatient?.[2],
          });
        } catch { /* skip slice */ }
      }),
    );
    onProgress?.(Math.min(i + BATCH, total), total);
  }

  metas.sort((a, b) => {
    if (a.instance != null && b.instance != null) return a.instance - b.instance;
    if (a.z != null && b.z != null) return a.z - b.z;
    return 0;
  });

  const sorted = metas.map((m) => m.id);
  const ready = imageIdsReadyForVolume(sorted);
  if (ready.length === 0) {
    throw new Error(
      'No DICOM slices could be loaded with full metadata. Check files, transfer syntax, and manifest paths.',
    );
  }
  return ready;
}

export function getVoiFromMetadata(imageId: string): { lower: number; upper: number } {
  const voi = metaData.get('voiLutModule', imageId);
  const wc: number = Array.isArray(voi?.windowCenter)
    ? voi.windowCenter[0]
    : (voi?.windowCenter ?? 40);
  const ww: number = Array.isArray(voi?.windowWidth)
    ? voi.windowWidth[0]
    : (voi?.windowWidth ?? 400);
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
}

// Load all images into the in-memory cache without re-sorting.
// Used when imageIds are already sorted (e.g. from session) but per-tab
// metadata cache is empty and Cornerstone needs imagePlaneModule for every image.
export async function prefetchAll(
  imageIds: string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const BATCH = 20;
  const total = imageIds.length;
  for (let i = 0; i < total; i += BATCH) {
    const batch = imageIds.slice(i, Math.min(i + BATCH, total));
    await Promise.all(
      batch.map((id) =>
        imageLoader.loadAndCacheImage(id).catch(() => { /* skip slice */ }),
      ),
    );
    onProgress?.(Math.min(i + BATCH, total), total);
  }
}

export function ctVoiCallback(lower: number, upper: number) {
  return ({ volumeActor }: { volumeActor: any }) => {
    volumeActor.getProperty().getRGBTransferFunction(0).setMappingRange(lower, upper);
  };
}

export async function loadFromManifest(
  onProgress: (msg: string) => void,
): Promise<{
  imageIds: string[];
  voiRange: { lower: number; upper: number };
  xrPreviewGlb: string;
}> {
  onProgress('Loading manifest…');
  const manifestFiles = await fetchManifestFiles();
  const xrPreviewGlb = pickXrPreviewGlbFilename(manifestFiles);
  const dir = getDicomDataDirUrl();
  const rawIds = manifestFiles
    .filter((f) => !manifestEntryIsGlb(f))
    .map((f) => {
      const rel = f.replace(/^\/+/, '');
      return `wadouri:${new URL(rel, dir).href}`;
    });
  onProgress('Prefetching images…');
  const imageIds = await prefetchAndSort(rawIds, (loaded, total) => {
    onProgress(`Loading ${loaded} / ${total}`);
  });
  const mid = imageIds[Math.floor(imageIds.length / 2)];
  const voiRange = getVoiFromMetadata(mid);
  return { imageIds, voiRange, xrPreviewGlb };
}
