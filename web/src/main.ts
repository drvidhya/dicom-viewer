import {
  init as csRenderInit,
  RenderingEngine,
  Enums,
  volumeLoader,
  imageLoader,
  metaData,
  cornerstoneStreamingImageVolumeLoader,
  setVolumesForViewports,
  type Types,
} from '@cornerstonejs/core';
import { init as csToolsInit } from '@cornerstonejs/tools';
import * as dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { saveSession, loadSession } from './session';
import { initXR, launchXR, exitXR, isXRInitialized, destroyXR } from './xr';

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomVolume';
const RENDERING_ENGINE_ID = 'dicomRE';
const VIEWPORT_ID = 'vp-main';

const urlParams = new URLSearchParams(window.location.search);
const viewType = (urlParams.get('view') ?? 'axial') as 'axial' | 'sagittal' | 'coronal';
const isChildWindow = viewType !== 'axial';

const ORIENTATION_MAP: Record<string, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal: Enums.OrientationAxis.CORONAL,
};

async function initCornerstone() {
  dicomImageLoader.init({ maxWebWorkers: 0 });
  metaData.addProvider(
    (dicomImageLoader as any).wadouri.metaData.metaDataProvider,
    10000,
  );
  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstoneStreamingImageVolumeLoader as any,
  );
  await csRenderInit();
  await csToolsInit();
}

function updateStatus(msg: string, state: 'loading' | 'ready' | 'error') {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className = `dot ${state}`;
  if (txt) txt.textContent = msg;
}

function updateProgress(msg: string) {
  const el = document.getElementById('progress');
  if (el) el.textContent = msg;
}

function hideOverlay() {
  const el = document.getElementById('overlay');
  if (el) el.classList.add('hidden');
}

function showOverlayError(msg: string) {
  const el = document.getElementById('overlay');
  if (el) el.innerHTML = `<p class="error">${msg}</p>`;
  updateStatus('Error', 'error');
}

async function fetchImageIds(): Promise<string[]> {
  const res = await fetch('/data/manifest.json');
  if (!res.ok) throw new Error('Failed to fetch manifest.json');
  const json = await res.json();
  const files: string[] = json.files ?? json;
  return files.map((f) => `wadouri:/data/${f}`);
}

async function prefetchAndSort(imageIds: string[]): Promise<string[]> {
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
        } catch {
          metas.push({ id });
        }
      }),
    );
    updateProgress(`Loading ${Math.min(i + BATCH, total)} / ${total}`);
  }

  metas.sort((a, b) => {
    if (a.instance != null && b.instance != null) return a.instance - b.instance;
    if (a.z != null && b.z != null) return a.z - b.z;
    return 0;
  });

  return metas.map((m) => m.id);
}

function getVoiFromMetadata(imageId: string): { lower: number; upper: number } {
  const voi = metaData.get('voiLutModule', imageId);
  const wc: number = Array.isArray(voi?.windowCenter)
    ? voi.windowCenter[0]
    : (voi?.windowCenter ?? 40);
  const ww: number = Array.isArray(voi?.windowWidth)
    ? voi.windowWidth[0]
    : (voi?.windowWidth ?? 400);
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
}

function makeCTCallback(lower: number, upper: number) {
  return ({ volumeActor }: { volumeActor: any }) => {
    volumeActor
      .getProperty()
      .getRGBTransferFunction(0)
      .setMappingRange(lower, upper);
  };
}

function setupUI(): void {
  const names: Record<string, string> = {
    axial: 'Axial (Top-Down)',
    sagittal: 'Sagittal',
    coronal: 'Coronal',
  };
  document.title = `DICOM Viewer – ${names[viewType]}`;

  const headerEl = document.getElementById('vp-header');
  if (headerEl) {
    headerEl.textContent = names[viewType];
    headerEl.className = `vp-header ${viewType}`;
  }

  if (isChildWindow) {
    const toolbar = document.getElementById('main-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    const infoPane = document.getElementById('info-pane-container');
    if (infoPane) infoPane.style.display = 'none';
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.classList.add('full');
  }

  document.getElementById('open-sagittal-btn')?.addEventListener('click', () => {
    window.open(`${window.location.pathname}?view=sagittal`, 'dicom-sagittal', 'width=1000,height=800,menubar=no,toolbar=no');
  });
  document.getElementById('open-coronal-btn')?.addEventListener('click', () => {
    window.open(`${window.location.pathname}?view=coronal`, 'dicom-coronal', 'width=1000,height=800,menubar=no,toolbar=no');
  });
}

function setupXRButton(): void {
  const btn = document.getElementById('enter-xr-btn') as HTMLButtonElement | null;
  if (!btn) return;

  btn.disabled = false;
  btn.title = 'Enter WebXR immersive-vr session';

  btn.addEventListener('click', async () => {
    if (isXRInitialized()) {
      exitXR();
      destroyXR();
      btn.textContent = 'WebXR';
      btn.classList.remove('xr-active');
    } else {
      btn.disabled = true;
      btn.textContent = 'Loading XR…';
      try {
        await initXR(VOLUME_ID);
        const xrLaunchError = await new Promise<Error | null>((resolve) => {
          const handler = (ev: PromiseRejectionEvent) => {
            if (String(ev.reason).includes('session') || String(ev.reason).includes('XR') || String(ev.reason).includes('NotSupported')) {
              ev.preventDefault();
              window.removeEventListener('unhandledrejection', handler);
              resolve(ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason)));
            }
          };
          window.addEventListener('unhandledrejection', handler);
          launchXR();
          setTimeout(() => { window.removeEventListener('unhandledrejection', handler); resolve(null); }, 2000);
        });
        if (xrLaunchError) throw xrLaunchError;
        btn.textContent = 'Exit WebXR';
        btn.classList.add('xr-active');
      } catch (err) {
        console.error('[XR] Failed to initialize:', err);
        btn.textContent = 'WebXR';
        alert('Failed to enter WebXR: ' + (err instanceof Error ? err.message : String(err)));
      } finally {
        btn.disabled = false;
      }
    }
  });
}

async function run() {
  setupUI();
  updateStatus('Initialising…', 'loading');
  updateProgress('Initialising Cornerstone3D…');

  await initCornerstone();

  let imageIds: string[];
  let voiRange: { lower: number; upper: number };

  const session = loadSession();

  if (isChildWindow && session) {
    // Child window: reuse sorted imageIds saved by the main window — no re-fetch, no re-sort.
    // The DICOM files are already in the browser's HTTP cache from the main window's load.
    imageIds = session.imageIds;
    voiRange = session.voiRange;
    updateProgress('Using shared session…');
  } else {
    // Main window (or child opened before main finished): load, sort, and save.
    updateProgress('Loading manifest…');
    const rawIds = await fetchImageIds();

    updateProgress('Prefetching images…');
    imageIds = await prefetchAndSort(rawIds);

    const midId = imageIds[Math.floor(imageIds.length / 2)];
    voiRange = getVoiFromMetadata(midId);

    saveSession({ imageIds, voiRange });
  }

  updateProgress('Setting up viewport…');
  const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  renderingEngine.setViewports([
    {
      viewportId: VIEWPORT_ID,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: document.getElementById(VIEWPORT_ID) as HTMLDivElement,
      defaultOptions: {
        orientation: ORIENTATION_MAP[viewType],
        background: [0, 0, 0] as Types.Point3,
      },
    },
  ]);

  updateProgress('Creating volume…');
  const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
  volume.load();

  updateProgress('Assigning volume to viewport…');
  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId: VOLUME_ID, callback: makeCTCallback(voiRange.lower, voiRange.upper) }],
    [VIEWPORT_ID],
  );

  const vp = renderingEngine.getViewport(VIEWPORT_ID) as Types.IVolumeViewport;
  vp.setProperties({
    voiRange,
    VOILUTFunction: Enums.VOILUTFunctionType.LINEAR,
    colormap: { name: 'Grayscale' },
  });

  renderingEngine.renderViewports([VIEWPORT_ID]);

  const el = document.getElementById(VIEWPORT_ID)!;
  el.addEventListener('wheel', (e) => {
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

  if (!isChildWindow) {
    const sagBtn = document.getElementById('open-sagittal-btn') as HTMLButtonElement;
    const corBtn = document.getElementById('open-coronal-btn') as HTMLButtonElement;
    if (sagBtn) { sagBtn.disabled = false; sagBtn.title = 'Open Sagittal view in new window'; }
    if (corBtn) { corBtn.disabled = false; corBtn.title = 'Open Coronal view in new window'; }
    populateInfo(imageIds[0], imageIds.length);
    setupXRButton();
  }

  hideOverlay();
  updateStatus('Ready', 'ready');
}

function populateInfo(imageId: string, nSlices: number) {
  const pm = metaData.get('patientModule', imageId) ?? {};
  const sm = metaData.get('generalStudyModule', imageId) ?? {};
  const se = metaData.get('generalSeriesModule', imageId) ?? {};
  const ip = metaData.get('imagePlaneModule', imageId) ?? {};
  const px = metaData.get('imagePixelModule', imageId) ?? {};
  const voi = metaData.get('voiLutModule', imageId) ?? {};

  const row = (label: string, value: unknown) =>
    `<div class="info-row"><span class="lbl">${label}</span><span class="val">${value ?? '—'}</span></div>`;

  const wc = Array.isArray(voi.windowCenter) ? voi.windowCenter[0] : voi.windowCenter;
  const ww = Array.isArray(voi.windowWidth) ? voi.windowWidth[0] : voi.windowWidth;
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

run().catch((err) => {
  console.error(err);
  showOverlayError(err instanceof Error ? err.message : String(err));
});
