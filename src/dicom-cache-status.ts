import { countDicomCacheEntries } from './dicom-cache';

export type DicomCacheStatus = {
  /** Single line for UI (DOM or XR canvas). */
  line: string;
  /** When false, hide or disable cache actions. */
  interactable: boolean;
};

export async function getDicomCacheStatus(): Promise<DicomCacheStatus> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    return {
      line: 'Offline file cache: not supported in this browser',
      interactable: false,
    };
  }
  try {
    const n = await countDicomCacheEntries();
    const on = !!navigator.serviceWorker.controller;
    return {
      line: on
        ? `Offline file cache: active · ${n} stored request(s)`
        : `Offline file cache: installing… · ${n} stored request(s)`,
      interactable: true,
    };
  } catch {
    return { line: 'Offline file cache: could not read status', interactable: true };
  }
}
