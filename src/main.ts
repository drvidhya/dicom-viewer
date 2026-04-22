import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
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
const VIEWPORT_ID = 'vp-main';

function parseViewQuery(): PlaneId | null {
  const raw = new URLSearchParams(window.location.search).get('view');
  if (!raw) return null;
  return (PLANE_IDS as readonly string[]).includes(raw) ? (raw as PlaneId) : null;
}

const viewParam = parseViewQuery();
const isViewer = viewParam !== null;

// ── Dashboard render hub + popup display clients ─────────────────────────────

const openViews = new Set<PlaneId>();
const childWindows = new Map<PlaneId, Window | null>();
const STREAM_CHANNEL = 'dicom-stream-v1';
const HUB_HOST_ID = 'dicom-stream-hub-host';
const HUB_ENGINE_ID = 'dicomHubRE';

type ChildToMainMsg =
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'ready';
    view: PlaneId;
    width: number;
    height: number;
    dpr: number;
  }
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'sliceSet';
    view: PlaneId;
    imageIndex: number;
  }
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'sliceDelta';
    view: PlaneId;
    delta: number;
  }
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'resize';
    view: PlaneId;
    width: number;
    height: number;
    dpr: number;
  }
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'closed';
    view: PlaneId;
  };

type MainToChildMsg =
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'frame';
    view: PlaneId;
    frameId: number;
    current: number;
    total: number;
    bitmap: ImageBitmap;
  }
  | {
    channel: typeof STREAM_CHANNEL;
    type: 'close';
    view: PlaneId;
  };

type HubViewState = {
  view: PlaneId;
  viewportId: string;
  element: HTMLDivElement;
  width: number;
  height: number;
  dpr: number;
  current: number;
  total: number;
  frameId: number;
  dirty: boolean;
  pending: boolean;
  renderQueued: boolean;
  frameInFlight: boolean;
  sliceInFlight: boolean;
  queuedSlice: number | null;
  lastSignature: string;
};

let hubEngine: RenderingEngine | null = null;
const hubViews = new Map<PlaneId, HubViewState>();
let messageListenerInstalled = false;
/** Same-origin broadcast: works when popups have no `window.opener` (COOP, automation, etc.). */
let streamHub: BroadcastChannel | null = null;

function getStreamHub(): BroadcastChannel {
  if (!streamHub) streamHub = new BroadcastChannel(STREAM_CHANNEL);
  return streamHub;
}

function isPlaneId(value: unknown): value is PlaneId {
  return typeof value === 'string' && (PLANE_IDS as readonly string[]).includes(value);
}

function clampRenderDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(256, Math.min(1400, Math.round(value)));
}

function dashboardUrl(): string {
  const u = new URL(window.location.href);
  u.searchParams.delete('view');
  return u.href;
}

function showMissingDashboardState(): void {
  const bar = document.getElementById('load-bar');
  bar?.classList.remove('loading');
  bar?.classList.remove('done');

  const viewerContent = document.getElementById('viewer-content');
  if (!viewerContent) return;
  viewerContent.innerHTML = `
    <div class="vp-container" style="display:flex;align-items:center;justify-content:center;min-height:70vh;">
      <div style="max-width:520px;text-align:center;padding:24px;">
        <h2 style="margin:0 0 10px;">No main dashboard found</h2>
        <p style="margin:0 0 18px;opacity:.85;">
          This view needs the dashboard window to be open. Reload this window into the dashboard, then open views again.
        </p>
        <button id="btn-open-dashboard" type="button" style="padding:10px 16px;cursor:pointer;">
          Go to Dashboard
        </button>
      </div>
    </div>
  `;
  document.getElementById('btn-open-dashboard')?.addEventListener('click', () => {
    window.location.href = dashboardUrl();
  });
  hideOverlay();
  updateStatus('Dashboard required', 'error');
}

function updateViewCard(view: string) {
  const card = document.getElementById(`card-${view}`);
  const open = openViews.has(view as PlaneId);
  card?.classList.toggle('open', open);
  const stateEl = card?.querySelector('.view-state');
  if (stateEl) stateEl.textContent = open ? 'Window open' : 'Closed';
  const btn = document.getElementById(`btn-${view}`) as HTMLButtonElement | null;
  if (btn) btn.textContent = open ? 'Close' : 'Open';
}

function getLiveChildWindow(view: PlaneId): Window | null {
  const win = childWindows.get(view) ?? null;
  if (!win || win.closed) {
    childWindows.delete(view);
    if (openViews.delete(view)) updateViewCard(view);
    return null;
  }
  return win;
}

function sendToChild(view: PlaneId, payload: MainToChildMsg, transfer?: Transferable[]): void {
  const win = getLiveChildWindow(view);
  if (!win) return;
  try {
    win.postMessage(payload, window.location.origin, transfer ?? []);
  } catch {
    childWindows.delete(view);
    if (openViews.delete(view)) updateViewCard(view);
  }
}

function getScrollInfo(view: PlaneId): { current: number; total: number } {
  const state = hubViews.get(view);
  if (!state || !hubEngine) return { current: state?.current ?? 1, total: state?.total ?? 1 };
  try {
    const vp = hubEngine.getViewport(state.viewportId) as Types.IVolumeViewport;
    const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
    const total = Math.max(1, info.numScrollSteps);
    const current = Math.min(Math.max(1, info.currentStepIndex + 1), total);
    return { current, total };
  } catch {
    return { current: state.current, total: state.total };
  }
}

function resizeHubView(view: PlaneId, width: number, height: number, dpr: number): void {
  const state = hubViews.get(view);
  if (!state || !hubEngine) return;
  const nextDpr = Number.isFinite(dpr) ? Math.max(1, Math.min(2, dpr)) : 1;
  const nextW = clampRenderDimension(width * nextDpr, state.width);
  const nextH = clampRenderDimension(height * nextDpr, state.height);
  if (nextW === state.width && nextH === state.height && nextDpr === state.dpr) return;
  state.width = nextW;
  state.height = nextH;
  state.dpr = nextDpr;
  state.element.style.width = `${state.width}px`;
  state.element.style.height = `${state.height}px`;
  hubEngine.resize();
  state.dirty = true;
}

async function renderAndSendViewFrame(view: PlaneId): Promise<void> {
  const state = hubViews.get(view);
  if (!state || !hubEngine) return;
  if (!state.dirty || state.frameInFlight) return;
  if (!openViews.has(view)) return;
  state.frameInFlight = true;
  state.dirty = false;
  try {
    hubEngine.renderViewports([state.viewportId]);
    const { current, total } = getScrollInfo(view);
    state.current = current;
    state.total = total;
    const signature = `${current}/${total}/${state.width}x${state.height}`;
    if (signature === state.lastSignature && !state.pending) return;
    const canvas = state.element.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const bitmap = await createImageBitmap(canvas);
    state.frameId += 1;
    state.lastSignature = signature;
    const payload: MainToChildMsg = {
      channel: STREAM_CHANNEL,
      type: 'frame',
      view,
      frameId: state.frameId,
      current,
      total,
      bitmap,
    };
    const win = getLiveChildWindow(view);
    if (win) {
      try {
        win.postMessage(payload, window.location.origin, [bitmap]);
        return;
      } catch {
        childWindows.delete(view);
      }
    }
    try {
      getStreamHub().postMessage(payload);
    } catch {
      bitmap.close();
    }
  } finally {
    state.frameInFlight = false;
    if (state.pending || state.dirty) {
      state.pending = false;
      queueViewRender(view);
    }
  }
}

function queueViewRender(view: PlaneId): void {
  const state = hubViews.get(view);
  if (!state) return;
  state.dirty = true;
  if (state.frameInFlight) {
    state.pending = true;
    return;
  }
  if (state.renderQueued) return;
  state.renderQueued = true;
  window.requestAnimationFrame(() => {
    state.renderQueued = false;
    void renderAndSendViewFrame(view);
  });
}

function requestSliceSet(view: PlaneId, requestedIndex: number): void {
  const state = hubViews.get(view);
  if (!state || !hubEngine) return;
  const clamped = Math.max(0, Math.min(Math.max(0, state.total - 1), Math.round(requestedIndex)));
  if (state.sliceInFlight) {
    state.queuedSlice = clamped;
    return;
  }
  state.sliceInFlight = true;
  void utilities.jumpToSlice(state.element, { imageIndex: clamped, volumeId: VOLUME_ID })
    .catch(() => { /* ignore failed jump */ })
    .finally(() => {
      state.sliceInFlight = false;
      const next = state.queuedSlice;
      state.queuedSlice = null;
      queueViewRender(view);
      if (next != null && next !== clamped) requestSliceSet(view, next);
    });
}

function closeViewWindow(view: PlaneId): void {
  sendToChild(view, { channel: STREAM_CHANNEL, type: 'close', view });
  try {
    getStreamHub().postMessage({ channel: STREAM_CHANNEL, type: 'close', view } satisfies MainToChildMsg);
  } catch { /* ignore */ }
  const win = getLiveChildWindow(view);
  if (win) {
    try { win.close(); } catch { /* ignore */ }
  }
  childWindows.delete(view);
  openViews.delete(view);
  updateViewCard(view);
}

function handleChildPayload(d: ChildToMainMsg, sourceWin: Window | null): void {
  if (!d || d.channel !== STREAM_CHANNEL || !isPlaneId(d.view)) return;
  const view = d.view;
  if (sourceWin) childWindows.set(view, sourceWin);

  if (d.type === 'closed') {
    if (sourceWin == null || childWindows.get(view) === sourceWin) {
      childWindows.delete(view);
      openViews.delete(view);
      updateViewCard(view);
    }
    return;
  }

  openViews.add(view);
  updateViewCard(view);

  if (d.type === 'ready' || d.type === 'resize') {
    resizeHubView(view, d.width, d.height, d.dpr);
    queueViewRender(view);
    return;
  }
  if (d.type === 'sliceSet') {
    requestSliceSet(view, d.imageIndex);
    return;
  }
  if (d.type === 'sliceDelta') {
    requestSliceSet(view, (hubViews.get(view)?.current ?? 1) - 1 + d.delta);
  }
}

function handleChildWindowMessage(e: MessageEvent): void {
  if (e.origin !== window.location.origin) return;
  const sourceWin = e.source instanceof Window ? e.source : null;
  handleChildPayload(e.data as ChildToMainMsg, sourceWin);
}

function handleStreamHubMessage(ev: MessageEvent): void {
  const d = ev.data as { type?: string } | null;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'frame' || d.type === 'close') return;
  handleChildPayload(d as ChildToMainMsg, null);
}

function attachHubSidebandListeners(): void {
  if (messageListenerInstalled) return;
  window.addEventListener('message', handleChildWindowMessage);
  getStreamHub().addEventListener('message', handleStreamHubMessage);
  messageListenerInstalled = true;
}

async function initDashboardRenderHub(
  imageIds: string[],
  voiRange: { lower: number; upper: number },
): Promise<void> {
  if (hubEngine) return;
  const host = document.createElement('div');
  host.id = HUB_HOST_ID;
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.opacity = '0';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  hubEngine = new RenderingEngine(HUB_ENGINE_ID);
  const viewportInputs: Types.PublicViewportInput[] = [];

  for (const view of PLANE_IDS) {
    const element = document.createElement('div');
    element.style.width = '768px';
    element.style.height = '768px';
    host.appendChild(element);
    const viewportId = `hub-vp-${view}`;
    viewportInputs.push({
      viewportId,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element,
      defaultOptions: {
        orientation: ORIENTATION_MAP[view],
        background: [0, 0, 0] as Types.Point3,
      },
    });
    hubViews.set(view, {
      view,
      viewportId,
      element,
      width: 768,
      height: 768,
      dpr: 1,
      current: 1,
      total: 1,
      frameId: 0,
      dirty: true,
      pending: false,
      renderQueued: false,
      frameInFlight: false,
      sliceInFlight: false,
      queuedSlice: null,
      lastSignature: '',
    });
  }

  hubEngine.setViewports(viewportInputs);
  const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
  volume.load();

  await setVolumesForViewports(
    hubEngine,
    [{ volumeId: VOLUME_ID, callback: ctVoiCallback(voiRange.lower, voiRange.upper) }],
    PLANE_IDS.map((view) => hubViews.get(view)?.viewportId!).filter(Boolean),
  );

  for (const view of PLANE_IDS) {
    const state = hubViews.get(view);
    if (!state) continue;
    const vp = hubEngine.getViewport(state.viewportId) as Types.IVolumeViewport;
    vp.setProperties({
      voiRange,
      VOILUTFunction: Enums.VOILUTFunctionType.LINEAR,
      colormap: { name: 'Grayscale' },
    });
    const info = getScrollInfo(view);
    state.current = info.current;
    state.total = info.total;
  }
  hubEngine.renderViewports(PLANE_IDS.map((view) => hubViews.get(view)?.viewportId!).filter(Boolean));

  attachHubSidebandListeners();
}

function setupViewCards() {
  for (const view of PLANE_IDS) {
    const openBtn = document.getElementById(`btn-${view}`) as HTMLButtonElement;
    openBtn.disabled = false;

    openBtn.addEventListener('click', () => {
      if (openViews.has(view)) {
        closeViewWindow(view);
        return;
      }
      const u = new URL(window.location.href);
      u.searchParams.set('view', view);
      const win = window.open(
        u.href,
        `dicom-${view}`,
        'width=1000,height=800,menubar=no,toolbar=no',
      );
      childWindows.set(view, win);
    });
  }
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
  updateProgress('Preparing shared render hub…');
  await initDashboardRenderHub(imageIds, voiRange);

  applyDashboardChrome();
  populateInfo(imageIds[0], imageIds.length);
  setupViewCards();
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
  const viewerSlider = document.getElementById('viewer-slice-slider') as HTMLInputElement;
  const viewerReadout = document.getElementById('viewer-slice-readout') as HTMLElement;
  viewerSlider.classList.add(view);

  const bar = document.getElementById('load-bar');
  bar?.classList.add('loading');
  updateStatus('Connecting to dashboard renderer…', 'loading');
  updateProgress('Waiting for first frame…');

  const streamBc = getStreamHub();

  const vpEl = document.getElementById(VIEWPORT_ID)!;
  const frameCanvas = document.createElement('canvas');
  frameCanvas.style.width = '100%';
  frameCanvas.style.height = '100%';
  frameCanvas.style.display = 'block';
  frameCanvas.style.background = '#000';
  vpEl.appendChild(frameCanvas);
  const frameCtx = frameCanvas.getContext('2d');
  if (!frameCtx) {
    throw new Error('Failed to initialise frame canvas context');
  }
  const ctx2d = frameCtx;

  let lastFrameId = 0;
  let gotFirstFrame = false;
  const hubWaitTimer = window.setTimeout(() => {
    if (!gotFirstFrame) showMissingDashboardState();
  }, 12_000);

  function postToHub(msg: ChildToMainMsg): void {
    try {
      streamBc.postMessage(msg);
    } catch { /* ignore */ }
    const openerWin = window.opener;
    if (openerWin instanceof Window && !openerWin.closed) {
      try {
        openerWin.postMessage(msg, window.location.origin);
      } catch { /* ignore */ }
    }
  }

  function sendResize() {
    const rect = vpEl.getBoundingClientRect();
    postToHub({
      channel: STREAM_CHANNEL,
      type: 'resize',
      view,
      width: Math.max(256, Math.round(rect.width)),
      height: Math.max(256, Math.round(rect.height)),
      dpr: window.devicePixelRatio || 1,
    });
  }

  function applyFrameMessage(d: MainToChildMsg): void {
    if (d.type === 'close') {
      window.close();
      return;
    }
    if (d.type !== 'frame' || d.frameId <= lastFrameId) return;
    lastFrameId = d.frameId;
    const bitmap = d.bitmap;
    if (frameCanvas.width !== bitmap.width || frameCanvas.height !== bitmap.height) {
      frameCanvas.width = bitmap.width;
      frameCanvas.height = bitmap.height;
    }
    ctx2d.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
    ctx2d.drawImage(bitmap, 0, 0, frameCanvas.width, frameCanvas.height);
    bitmap.close();
    viewerSlider.max = String(Math.max(1, d.total));
    viewerSlider.value = String(Math.min(Math.max(1, d.current), Math.max(1, d.total)));
    viewerReadout.textContent = `${viewerSlider.value} / ${viewerSlider.max}`;
    if (!gotFirstFrame) {
      gotFirstFrame = true;
      window.clearTimeout(hubWaitTimer);
      bar?.classList.remove('loading');
      bar?.classList.add('done');
      hideOverlay();
      updateStatus('Ready', 'ready');
    }
  }

  const onWindowMsg = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data as MainToChildMsg | null;
    if (!d || d.channel !== STREAM_CHANNEL || d.view !== view) return;
    applyFrameMessage(d);
  };

  const onBcMsg = (ev: MessageEvent) => {
    const d = ev.data as MainToChildMsg | null;
    if (!d || d.channel !== STREAM_CHANNEL || d.view !== view) return;
    applyFrameMessage(d);
  };

  viewerSlider.addEventListener('input', () => {
    postToHub({
      channel: STREAM_CHANNEL,
      type: 'sliceSet',
      view,
      imageIndex: Math.max(0, Number(viewerSlider.value) - 1),
    });
  });

  vpEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    postToHub({
      channel: STREAM_CHANNEL,
      type: 'sliceDelta',
      view,
      delta: e.deltaY > 0 ? 1 : -1,
    });
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => sendResize());
  resizeObserver.observe(vpEl);
  window.addEventListener('message', onWindowMsg);
  streamBc.addEventListener('message', onBcMsg);

  postToHub({
    channel: STREAM_CHANNEL,
    type: 'ready',
    view,
    width: Math.max(256, Math.round(vpEl.getBoundingClientRect().width)),
    height: Math.max(256, Math.round(vpEl.getBoundingClientRect().height)),
    dpr: window.devicePixelRatio || 1,
  });

  window.addEventListener('beforeunload', () => {
    window.clearTimeout(hubWaitTimer);
    resizeObserver.disconnect();
    window.removeEventListener('message', onWindowMsg);
    streamBc.removeEventListener('message', onBcMsg);
    postToHub({ channel: STREAM_CHANNEL, type: 'closed', view });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

(isViewer ? runViewer(viewParam) : runDashboard()).catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
});

function populateInfo(imageId: string, nSlices: number) {
  const meta = getDicomStudyMeta(imageId, nSlices);
  document.getElementById('dicom-info')!.innerHTML = formatDicomMetaRowsHtml(meta);
}
