import {
  RenderingEngine,
  Enums,
  volumeLoader,
  metaData,
  setVolumesForViewports,
  eventTarget,
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

function updateViewButton(view: string) {
  const btn = document.getElementById(`btn-${view}`);
  const open = openViews.has(view);
  btn?.classList.toggle('open', open);
  const stateEl = btn?.querySelector('.view-state');
  if (stateEl) stateEl.textContent = open ? 'Open' : 'Closed';
}

function setupViewButtons() {
  const views = ['axial', 'sagittal', 'coronal'] as const;
  for (const view of views) {
    const btn = document.getElementById(`btn-${view}`) as HTMLButtonElement;
    btn.disabled = false;
    btn.querySelector('.view-state')!.textContent = 'Closed';
    btn.addEventListener('click', () => window.open(
      `${window.location.pathname}?view=${view}`,
      `dicom-${view}`,
      'width=1000,height=800,menubar=no,toolbar=no',
    ));
  }
  viewChannel.addEventListener('message', (e: MessageEvent) => {
    const { type, view } = e.data as { type: string; view: string };
    if (type === 'opened') openViews.add(view);
    else if (type === 'closed') openViews.delete(view);
    updateViewButton(view);
  });
}

function setupXRButton() {
  const link = document.getElementById('vr-mode-link') as HTMLAnchorElement | null;
  if (!link) return;
  link.style.display = '';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    window.open('./xr.html', 'dicom-xr', 'width=1200,height=900,menubar=no,toolbar=no');
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
  setupViewButtons();
  setupXRButton();
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

  document.getElementById(VIEWPORT_ID)!.addEventListener('wheel', (e) => {
    e.preventDefault();
    const vp = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
    const cam = vp.getCamera();
    const delta = e.deltaY > 0 ? 1 : -1;
    const fp = cam.focalPoint!;
    const n = cam.viewPlaneNormal!;
    vp.setCamera({
      focalPoint: [fp[0] + n[0] * delta, fp[1] + n[1] * delta, fp[2] + n[2] * delta],
    });
    vp.render();
  }, { passive: false });

  viewChannel.postMessage({ type: 'opened', view });
  window.addEventListener('beforeunload', () => viewChannel.postMessage({ type: 'closed', view }));

  hideOverlay();
  updateStatus('Ready', 'ready');
}

// ── Entry point ────────────────────────────────────────────────────────────

(isViewer ? runViewer(viewParam!) : runDashboard()).catch((err) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});

function populateInfo(imageId: string, nSlices: number) {
  const pm  = metaData.get('patientModule',      imageId) ?? {};
  const sm  = metaData.get('generalStudyModule',  imageId) ?? {};
  const se  = metaData.get('generalSeriesModule', imageId) ?? {};
  const ip  = metaData.get('imagePlaneModule',    imageId) ?? {};
  const px  = metaData.get('imagePixelModule',    imageId) ?? {};
  const voi = metaData.get('voiLutModule',        imageId) ?? {};

  const row = (label: string, value: unknown) =>
    `<div class="info-row"><span class="lbl">${label}</span><span class="val">${value ?? '—'}</span></div>`;

  const wc = Array.isArray(voi.windowCenter) ? voi.windowCenter[0] : voi.windowCenter;
  const ww = Array.isArray(voi.windowWidth)  ? voi.windowWidth[0]  : voi.windowWidth;
  const ps = ip.pixelSpacing;

  document.getElementById('dicom-info')!.innerHTML = `
    <div class="section-title">Patient</div>
    ${row('Name', pm.patientName)}
    ${row('ID', pm.patientId)}
    <div class="section-title">Study</div>
    ${row('Description', sm.studyDescription)}
    ${row('Date', sm.studyDate)}
    <div class="section-title">Series</div>
    ${row('Modality', se.modality)}
    ${row('Description', se.seriesDescription)}
    <div class="section-title">Image</div>
    ${row('Matrix', px.columns && px.rows ? `${px.columns} × ${px.rows}` : '—')}
    ${row('Slices', nSlices)}
    ${row('Pixel spacing', ps ? `${Number(ps[0]).toFixed(3)} × ${Number(ps[1]).toFixed(3)} mm` : '—')}
    ${row('Slice thickness', ip.sliceThickness ? `${ip.sliceThickness} mm` : '—')}
    ${row('Window C / W', wc != null ? `${Number(wc).toFixed(0)} / ${Number(ww).toFixed(0)}` : '—')}
  `;
}
