import {
  RenderingEngine,
  Enums,
  volumeLoader,
  metaData,
  setVolumesForViewports,
  eventTarget,
  utilities,
  type Types,
} from '@cornerstonejs/core';
import { saveSession, loadSession } from './session';
import { initCornerstone } from './cornerstone';
import { ctVoiCallback, loadFromManifest, prefetchAll } from './dicom';
import { updateStatus, updateProgress, hideOverlay, showError } from './ui';

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomVolume';
const RENDERING_ENGINE_ID = 'dicomRE';
const VIEWPORT_ID = 'vp-main';

const viewParam = new URLSearchParams(window.location.search).get('view') as
  | 'axial' | 'sagittal' | 'coronal' | null;
const isViewer = viewParam !== null;

const ORIENTATION_MAP: Record<string, Enums.OrientationAxis> = {
  axial:    Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal:  Enums.OrientationAxis.CORONAL,
};

// ── Dashboard ──────────────────────────────────────────────────────────────

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
  const views = ['axial', 'sagittal', 'coronal'] as const;
  const maxGuess = String(Math.max(1, nFrames));

  for (const view of views) {
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

async function runDashboard() {
  updateStatus('Initialising…', 'loading');
  updateProgress('Initialising Cornerstone3D…');
  await initCornerstone();

  let imageIds: string[];
  const session = loadSession();
  if (session) {
    imageIds = session.imageIds;
    updateProgress('Using cached session…');
  } else {
    const result = await loadFromManifest(updateProgress);
    imageIds = result.imageIds;
    saveSession(result);
  }

  populateInfo(imageIds[0], imageIds.length);
  setupViewCards(imageIds.length);
  hideOverlay();
  updateStatus('Ready', 'ready');
}

// ── Viewer window ──────────────────────────────────────────────────────────

async function runViewer(view: 'axial' | 'sagittal' | 'coronal') {
  // Child window setup
  document.title = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' }[view];
  document.body.classList.add('child-view');
  document.querySelector('header')!.style.display = 'none';

  // Swap content panes
  document.getElementById('main-content')!.style.display = 'none';
  const viewerContent = document.getElementById('viewer-content')!;
  viewerContent.style.display = '';
  viewerContent.classList.add('full');

  const vpHeader = document.getElementById('vp-header')!;
  vpHeader.textContent = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' }[view];
  vpHeader.className = `vp-header ${view}`;

  document.getElementById('load-bar')?.classList.add('loading');

  updateStatus('Initialising…', 'loading');
  updateProgress('Initialising Cornerstone3D…');
  await initCornerstone();

  let imageIds: string[];
  let voiRange: { lower: number; upper: number };

  const session = loadSession();
  if (session) {
    imageIds = session.imageIds;
    voiRange = session.voiRange;
    // Must prefetch all images so per-tab metadata cache is populated.
    // getClosestImageId iterates every imageId and destructures imagePositionPatient — throws if missing.
    await prefetchAll(imageIds, (loaded, total) => updateProgress(`Prefetching ${loaded} / ${total}`));
  } else {
    ({ imageIds, voiRange } = await loadFromManifest(updateProgress));
    saveSession({ imageIds, voiRange });
  }

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

  // Load bar: complete when all images are streamed into the volume
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

  function postSliceSync() {
    try {
      const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
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
    const vport = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
    const cam = vport.getCamera();
    const delta = e.deltaY > 0 ? 1 : -1;
    const fp = cam.focalPoint!;
    const n = cam.viewPlaneNormal!;
    vport.setCamera({
      focalPoint: [fp[0] + n[0] * delta, fp[1] + n[1] * delta, fp[2] + n[2] * delta],
    });
    vport.render();
    postSliceSync();
  }, { passive: false });

  viewChannel.postMessage({ type: 'opened', view } satisfies ViewMsg);
  postSliceSync();

  window.addEventListener('beforeunload', () => {
    viewChannel.removeEventListener('message', onSliceMsg);
    viewChannel.postMessage({ type: 'closed', view } satisfies ViewMsg);
  });

  hideOverlay();
  updateStatus('Ready', 'ready');
}

// ── Entry point ────────────────────────────────────────────────────────────

(isViewer ? runViewer(viewParam!) : runDashboard()).catch((err) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});

function populateInfo(imageId: string, nSlices: number) {
  const pm = metaData.get('patientModule', imageId) ?? {};
  const sm = metaData.get('generalStudyModule', imageId) ?? {};
  const se = metaData.get('generalSeriesModule', imageId) ?? {};
  const px = metaData.get('imagePixelModule', imageId) ?? {};

  const esc = (v: unknown) =>
    String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const matrix = px.columns && px.rows ? `${px.columns} × ${px.rows}` : '—';
  const row = (label: string, value: string) =>
    `<div class="meta-row"><span class="meta-lbl">${label}</span><span class="meta-val">${esc(value)}</span></div>`;

  // Same compact fields as the XR dashboard canvas (`drawDashboard` in xr-main.ts).
  document.getElementById('dicom-info')!.innerHTML = [
    row('Patient', String(pm.patientName ?? '—')),
    row('Study', String(sm.studyDescription ?? '—')),
    row('Series', String(se.seriesDescription ?? '—')),
    row('Modality', String(se.modality ?? '—')),
    row('Slices', String(nSlices)),
    row('Matrix', matrix),
  ].join('');
}
