import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  eventTarget,
  utilities,
  type Types,
} from '@cornerstonejs/core';
import { clearSession, loadSession, saveSession } from './session';
import { initCornerstone } from './cornerstone';
import {
  ctVoiCallback,
  getVoiFromMetadata,
  imageIdsReadyForVolume,
  loadFromManifest,
  prefetchAll,
} from './dicom';
import {
  registerDicomServiceWorker,
  evictDicomHttpCache,
  rebuildDicomHttpCache,
} from './dicom-cache';
import { getDicomCacheStatus } from './dicom-cache-status';
import {
  formatDicomMetaRowsHtml,
  getDicomStudyMeta,
} from './dicom-study-meta';
import {
  CACHE_BTN_CLEAR,
  CACHE_BTN_REBUILD,
  DASH_HINT_2D_HTML,
  DASH_TITLE,
} from './dashboard-copy';
import { formatDashboardViewCardsHtml } from './dashboard-view-cards-html';
import { ORIENTATION_MAP, PLANE_IDS, VIEW_LABELS, type PlaneId } from './viewer-planes';
import { updateStatus, updateProgress, hideOverlay, showOverlay, showError } from './ui';

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomVolume';
const RENDERING_ENGINE_ID = 'dicomRE';
const VIEWPORT_ID = 'vp-main';

const viewParam = new URLSearchParams(window.location.search).get('view') as PlaneId | null;
const isViewer = viewParam !== null;

// ── Dashboard + popup viewers (BroadcastChannel — no shared Cornerstone heap) ─

const viewChannel = new BroadcastChannel('dicom-viewer-views');
const openViews = new Set<string>();

type ViewMsg =
  | { type: 'opened'; view: string }
  | { type: 'closed'; view: string }
  | { type: 'slice'; view: string; imageIndex: number }
  | { type: 'sliceSync'; view: string; current: number; total: number };

function updateViewCard(view: string) {
  const card = document.getElementById(`card-${view}`);
  const open = openViews.has(view);
  card?.classList.toggle('open', open);
  const stateEl = card?.querySelector('.view-state');
  if (stateEl) stateEl.textContent = open ? 'Window open' : 'Closed';
  const slider = document.getElementById(`slider-${view}`) as HTMLInputElement | null;
  const readout = document.getElementById(`slice-readout-${view}`);
  if (slider) slider.disabled = !open;
  if (!open && readout) readout.textContent = '— / —';
}

function setupViewCards(nFrames: number) {
  const maxGuess = String(Math.max(1, nFrames));

  for (const view of PLANE_IDS) {
    const openBtn = document.getElementById(`btn-${view}`) as HTMLButtonElement;
    const slider = document.getElementById(`slider-${view}`) as HTMLInputElement;
    openBtn.disabled = false;
    slider.max = maxGuess;
    slider.min = '1';
    slider.value = '1';

    openBtn.addEventListener('click', () => {
      window.open(
        `${window.location.pathname}?view=${view}`,
        `dicom-${view}`,
        'width=1000,height=800,menubar=no,toolbar=no',
      );
    });

    slider.addEventListener('input', () => {
      if (!openViews.has(view)) return;
      const imageIndex = Number(slider.value) - 1;
      const readout = document.getElementById(`slice-readout-${view}`);
      if (readout) readout.textContent = `${slider.value} / ${slider.max}`;
      viewChannel.postMessage({ type: 'slice', view, imageIndex } satisfies ViewMsg);
    });
  }

  viewChannel.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as ViewMsg;
    if (!d || typeof d !== 'object' || !('type' in d)) return;
    if (d.type === 'opened') {
      openViews.add(d.view);
      updateViewCard(d.view);
    } else if (d.type === 'closed') {
      openViews.delete(d.view);
      updateViewCard(d.view);
    } else if (d.type === 'sliceSync' && d.view) {
      const slider = document.getElementById(`slider-${d.view}`) as HTMLInputElement | null;
      const readout = document.getElementById(`slice-readout-${d.view}`);
      if (!slider || !readout) return;
      const total = Math.max(1, d.total);
      const current = Math.min(Math.max(1, d.current), total);
      slider.max = String(total);
      slider.value = String(current);
      readout.textContent = `${current} / ${total}`;
    }
  });
}

function setupCacheControls(imageIds: string[]) {
  const statusEl = document.getElementById('cache-sw-status');
  const clearBtn = document.getElementById('btn-cache-clear') as HTMLButtonElement | null;
  const rebuildBtn = document.getElementById('btn-cache-rebuild') as HTMLButtonElement | null;

  if (clearBtn) clearBtn.textContent = CACHE_BTN_CLEAR;
  if (rebuildBtn) rebuildBtn.textContent = CACHE_BTN_REBUILD;

  async function refreshCacheStatusLine() {
    const s = await getDicomCacheStatus();
    if (statusEl) statusEl.textContent = s.line;
    if (!s.interactable) {
      clearBtn?.setAttribute('disabled', '');
      rebuildBtn?.setAttribute('disabled', '');
    } else {
      clearBtn?.removeAttribute('disabled');
      rebuildBtn?.removeAttribute('disabled');
    }
    return s.interactable;
  }

  void refreshCacheStatusLine();
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    void refreshCacheStatusLine();
  });

  clearBtn?.addEventListener('click', async () => {
    if (clearBtn) clearBtn.disabled = true;
    if (rebuildBtn) rebuildBtn.disabled = true;
    try {
      const n = await evictDicomHttpCache();
      updateStatus(`Cleared ${n} cache bucket(s)`, 'ready');
      await refreshCacheStatusLine();
      setTimeout(() => updateStatus('Ready', 'ready'), 2200);
    } finally {
      if (clearBtn) clearBtn.disabled = false;
      if (rebuildBtn) rebuildBtn.disabled = false;
    }
  });

  rebuildBtn?.addEventListener('click', async () => {
    if (clearBtn) clearBtn.disabled = true;
    rebuildBtn!.disabled = true;
    updateStatus('Rebuilding cache…', 'loading');
    showOverlay();
    try {
      await rebuildDicomHttpCache(imageIds, updateProgress);
      updateStatus('Ready', 'ready');
      await refreshCacheStatusLine();
    } catch (e) {
      console.error(e);
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      hideOverlay();
      if (clearBtn) clearBtn.disabled = false;
      rebuildBtn!.disabled = false;
    }
  });
}

function applyDashboardChrome(): void {
  const title = document.querySelector('.dash-title');
  if (title) title.textContent = DASH_TITLE;
  const hint = document.querySelector('.dash-hint');
  if (hint) hint.innerHTML = DASH_HINT_2D_HTML;
  const views = document.querySelector('.dash-views');
  if (views) views.innerHTML = formatDashboardViewCardsHtml();
  document.getElementById('main-content')?.classList.add('dashboard-ready');
}

async function runDashboard() {
  updateStatus('Initialising…', 'loading');
  updateProgress('Registering offline file cache…');
  await registerDicomServiceWorker();
  updateProgress('Initialising Cornerstone3D…');
  await initCornerstone();

  let imageIds: string[];
  let voiRange: { lower: number; upper: number };
  const session = loadSession();
  let usedSession = false;
  if (session) {
    usedSession = true;
    imageIds = session.imageIds;
    voiRange = session.voiRange;
    updateProgress('Prefetching series (warms cache for viewer windows)…');
    await prefetchAll(imageIds, (loaded, total) => updateProgress(`Prefetching ${loaded} / ${total}`));
  } else {
    const result = await loadFromManifest(updateProgress);
    imageIds = result.imageIds;
    voiRange = result.voiRange;
  }

  const nDash = imageIds.length;
  imageIds = imageIdsReadyForVolume(imageIds);
  if (imageIds.length === 0 && usedSession) {
    clearSession();
    const result = await loadFromManifest(updateProgress);
    imageIds = result.imageIds;
    voiRange = result.voiRange;
    imageIds = imageIdsReadyForVolume(imageIds);
  }
  if (imageIds.length === 0) {
    showError(
      'No usable DICOM slices (missing metadata, bad session, or unsupported transfer syntax). Try clearing site data for this origin or open in a private window.',
    );
    return;
  }
  if (imageIds.length !== nDash) {
    voiRange = getVoiFromMetadata(imageIds[Math.floor(imageIds.length / 2)]);
  }
  saveSession({ imageIds, voiRange });

  applyDashboardChrome();
  populateInfo(imageIds[0], imageIds.length);
  setupViewCards(imageIds.length);
  setupCacheControls(imageIds);
  hideOverlay();
  updateStatus('Ready', 'ready');
}

// ── Popup / standalone viewer (?view=) ──────────────────────────────────────

async function runViewer(view: PlaneId) {
  document.title = VIEW_LABELS[view];
  document.body.classList.add('child-view');
  document.querySelector('header')!.style.display = 'none';

  document.getElementById('main-content')!.style.display = 'none';
  const viewerContent = document.getElementById('viewer-content')!;
  viewerContent.style.display = '';
  viewerContent.classList.add('full');

  const vpHeader = document.getElementById('vp-header')!;
  vpHeader.textContent = VIEW_LABELS[view];
  vpHeader.className = `vp-header ${view}`;

  document.getElementById('load-bar')?.classList.add('loading');

  updateStatus('Initialising…', 'loading');
  updateProgress('Registering offline file cache…');
  await registerDicomServiceWorker();
  updateProgress('Initialising Cornerstone3D…');
  await initCornerstone();

  let imageIds: string[];
  let voiRange: { lower: number; upper: number };

  const session = loadSession();
  let usedSession = false;
  if (session) {
    usedSession = true;
    imageIds = session.imageIds;
    voiRange = session.voiRange;
    await prefetchAll(imageIds, (loaded, total) =>
      updateProgress(`Loading slices ${loaded} / ${total}…`));
  } else {
    ({ imageIds, voiRange } = await loadFromManifest(updateProgress));
  }

  const nBefore = imageIds.length;
  imageIds = imageIdsReadyForVolume(imageIds);
  if (imageIds.length === 0 && usedSession) {
    clearSession();
    ({ imageIds, voiRange } = await loadFromManifest(updateProgress));
    imageIds = imageIdsReadyForVolume(imageIds);
  }
  if (imageIds.length === 0) {
    throw new Error(
      'No usable DICOM slices (missing metadata, bad session, or unsupported transfer syntax). Clear site data for this origin or use a private window.',
    );
  }
  if (imageIds.length !== nBefore) {
    voiRange = getVoiFromMetadata(imageIds[Math.floor(imageIds.length / 2)]);
  }
  saveSession({ imageIds, voiRange });

  updateProgress('Setting up viewport…');
  const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  renderingEngine.setViewports([{
    viewportId: VIEWPORT_ID,
    type: Enums.ViewportType.ORTHOGRAPHIC,
    element: document.getElementById(VIEWPORT_ID) as HTMLDivElement,
    defaultOptions: {
      orientation: ORIENTATION_MAP[view],
      background: [0, 0, 0] as Types.Point3,
    },
  }]);

  updateProgress('Creating volume…');
  const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
  volume.load();

  const bar = document.getElementById('load-bar');
  if (bar) {
    let loaded = 0;
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      eventTarget.removeEventListener(Enums.Events.IMAGE_LOADED, handler);
      bar.classList.remove('loading');
      bar.classList.add('done');
    };
    const handler = () => { if (++loaded >= imageIds.length) complete(); };
    eventTarget.addEventListener(Enums.Events.IMAGE_LOADED, handler);
    setTimeout(complete, 60_000);
  }

  updateProgress('Assigning volume to viewport…');
  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId: VOLUME_ID, callback: ctVoiCallback(voiRange.lower, voiRange.upper) }],
    [VIEWPORT_ID],
  );

  const vp = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
  vp.setProperties({
    voiRange,
    VOILUTFunction: Enums.VOILUTFunctionType.LINEAR,
    colormap: { name: 'Grayscale' },
  });
  renderingEngine.renderViewports([VIEWPORT_ID]);

  const vpEl = document.getElementById(VIEWPORT_ID) as HTMLDivElement;

  /** Positive delta moves forward through slices (same direction as wheel down). */
  function stepSlices(deltaSteps: number) {
    if (deltaSteps === 0) return;
    const vport = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
    const cam = vport.getCamera();
    const fp = cam.focalPoint!;
    const n = cam.viewPlaneNormal!;
    vport.setCamera({
      focalPoint: [
        fp[0] + n[0] * deltaSteps,
        fp[1] + n[1] * deltaSteps,
        fp[2] + n[2] * deltaSteps,
      ],
    });
    vport.render();
    postSliceSync();
  }

  function postSliceSync() {
    try {
      const vport = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
      const info = utilities.getVolumeViewportScrollInfo(vport, VOLUME_ID);
      viewChannel.postMessage({
        type: 'sliceSync',
        view,
        current: info.currentStepIndex + 1,
        total: info.numScrollSteps,
      } satisfies ViewMsg);
    } catch {
      /* viewport not ready */
    }
  }

  const onSliceMsg = async (e: MessageEvent) => {
    const d = e.data as ViewMsg;
    if (d?.type !== 'slice' || d.view !== view) return;
    if (typeof d.imageIndex !== 'number') return;
    try {
      await utilities.jumpToSlice(vpEl, { imageIndex: d.imageIndex, volumeId: VOLUME_ID });
      renderingEngine.renderViewports([VIEWPORT_ID]);
      postSliceSync();
    } catch (err) {
      console.warn('[viewer] jumpToSlice', err);
    }
  };
  viewChannel.addEventListener('message', onSliceMsg);

  document.getElementById(VIEWPORT_ID)!.addEventListener('wheel', (e) => {
    e.preventDefault();
    stepSlices(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  /**
   * Drag: pointer position maps linearly across the window — (0,0) to bottom-right
   * spans all slices. Uses (clientX + clientY) / (innerWidth + innerHeight) so a
   * drag from the top-left corner to the opposite corner covers the full range.
   */
  let dragPointerId: number | null = null;
  let lastDragMappedIndex = -1;

  function windowDragSpanPx(): number {
    return Math.max(1, window.innerWidth + window.innerHeight);
  }

  function sliceIndexFromWindowClient(clientX: number, clientY: number, numSteps: number): number | null {
    if (numSteps <= 1) return null;
    const span = windowDragSpanPx();
    const t = Math.max(0, Math.min(1, (clientX + clientY) / span));
    const maxIdx = numSteps - 1;
    return Math.max(0, Math.min(maxIdx, Math.round(t * maxIdx)));
  }

  function applyDragSliceIfChanged(clientX: number, clientY: number) {
    let numSteps: number;
    try {
      const vport = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
      numSteps = utilities.getVolumeViewportScrollInfo(vport, VOLUME_ID).numScrollSteps;
    } catch {
      return;
    }
    const clamped = sliceIndexFromWindowClient(clientX, clientY, numSteps);
    if (clamped === null || clamped === lastDragMappedIndex) return;
    lastDragMappedIndex = clamped;
    void utilities.jumpToSlice(vpEl, { imageIndex: clamped, volumeId: VOLUME_ID })
      .then(() => {
        renderingEngine.renderViewports([VIEWPORT_ID]);
        postSliceSync();
      })
      .catch((err) => console.warn('[viewer] jumpToSlice drag', err));
  }

  vpEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragPointerId = e.pointerId;
    lastDragMappedIndex = -1;
    vpEl.setPointerCapture(e.pointerId);
    applyDragSliceIfChanged(e.clientX, e.clientY);
  });

  vpEl.addEventListener('pointermove', (e) => {
    if (dragPointerId !== e.pointerId) return;
    applyDragSliceIfChanged(e.clientX, e.clientY);
  });

  function endSliceDrag(e: PointerEvent) {
    if (dragPointerId !== e.pointerId) return;
    dragPointerId = null;
    lastDragMappedIndex = -1;
    try {
      vpEl.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }
  vpEl.addEventListener('pointerup', endSliceDrag);
  vpEl.addEventListener('pointercancel', endSliceDrag);

  viewChannel.postMessage({ type: 'opened', view } satisfies ViewMsg);
  postSliceSync();

  window.addEventListener('beforeunload', () => {
    viewChannel.removeEventListener('message', onSliceMsg);
    viewChannel.postMessage({ type: 'closed', view } satisfies ViewMsg);
  });

  hideOverlay();
  updateStatus('Ready', 'ready');
}

// ── Entry point ───────────────────────────────────────────────────────────────

(isViewer ? runViewer(viewParam!) : runDashboard()).catch((err) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});

function populateInfo(imageId: string, nSlices: number) {
  const meta = getDicomStudyMeta(imageId, nSlices);
  document.getElementById('dicom-info')!.innerHTML = formatDicomMetaRowsHtml(meta);
}
