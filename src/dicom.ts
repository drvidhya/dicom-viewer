import { imageLoader, metaData } from '@cornerstonejs/core';

/** URL path for manifest + slices (Vite dev middleware + `dist/dicom/data` when built). */
export const DICOM_DATA_URL_PREFIX = '/dicom/data';

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

export async function fetchImageIds(): Promise<string[]> {
  const res = await fetch(`${DICOM_DATA_URL_PREFIX}/manifest.json`);
  if (!res.ok) throw new Error('Failed to fetch manifest.json');
  const json = await res.json();
  const files: string[] = json.files ?? json;
  return files.map((f) => `wadouri:${DICOM_DATA_URL_PREFIX}/${f}`);
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
        } catch (e) {
          console.warn('[dicom] skipped slice (load/parse failed):', id, e);
        }
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
        imageLoader.loadAndCacheImage(id).catch((e) => {
          console.warn('[dicom] prefetch slice failed:', id, e);
        }),
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
): Promise<{ imageIds: string[]; voiRange: { lower: number; upper: number } }> {
  onProgress('Loading manifest…');
  const rawIds = await fetchImageIds();
  onProgress('Prefetching images…');
  const imageIds = await prefetchAndSort(rawIds, (loaded, total) => {
    onProgress(`Loading ${loaded} / ${total}`);
  });
  const mid = imageIds[Math.floor(imageIds.length / 2)];
  const voiRange = getVoiFromMetadata(mid);
  return { imageIds, voiRange };
}
