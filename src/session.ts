import { normalizeWadouriImageIds } from './dicom';

const LEGACY_KEY = 'dicom-viewer:session';

function storageKey(): string {
  return `dicom-viewer:session:${window.location.origin}`;
}

export type DicomSession = {
  imageIds: string[];
  voiRange: { lower: number; upper: number };
};

export function clearSession(): void {
  try {
    localStorage.removeItem(storageKey());
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    console.warn('[Session] Failed to clear localStorage');
  }
}

export function saveSession(session: DicomSession): void {
  try {
    const normalized: DicomSession = {
      ...session,
      imageIds: normalizeWadouriImageIds(session.imageIds),
    };
    localStorage.setItem(storageKey(), JSON.stringify(normalized));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    console.warn('[Session] Failed to write to localStorage');
  }
}

export function loadSession(): DicomSession | null {
  try {
    let raw = localStorage.getItem(storageKey());
    if (!raw) raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as DicomSession;
    s.imageIds = normalizeWadouriImageIds(s.imageIds);
    return s;
  } catch {
    return null;
  }
}
