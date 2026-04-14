const KEY = 'dicom-viewer:session';

export type DicomSession = {
  imageIds: string[];
  voiRange: { lower: number; upper: number };
};

export function saveSession(session: DicomSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    console.warn('[Session] Failed to write to localStorage');
  }
}

export function loadSession(): DicomSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DicomSession) : null;
  } catch {
    return null;
  }
}
