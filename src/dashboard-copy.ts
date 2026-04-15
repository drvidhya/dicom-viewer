/** Shared user-visible strings for the 2D and XR dashboards. */

export const DASH_TITLE = 'DICOM Viewer';

/** Inner HTML for `.dash-hint` on the 2D page (static markup only). */
export const DASH_HINT_2D_HTML =
  'Use <strong>Open</strong> to launch each plane in its own window. A <strong>service worker</strong> cache stores DICOM data GETs (paths containing <code>dicom/data/</code>) so viewer windows skip repeat downloads (each window still builds its own Cornerstone volume). When a viewer is open, use the slice slider here or the mouse wheel in that window.';

/** Plain text for the XR canvas dashboard (wrapped by `drawDashboard`). */
export const DASH_HINT_XR_PLAIN =
  'Use Open to open or close each plane as a floating panel. A service worker caches DICOM data like the 2D viewer. When a panel is open, use the slice slider ' +
  'here, the thumbstick while pointing at the panel, or tap the track to jump.';

export const CACHE_BTN_CLEAR = 'Clear file cache';
export const CACHE_BTN_REBUILD = 'Clear & refetch series';
