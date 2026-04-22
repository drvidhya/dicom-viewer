/**
 * DICOM XR Viewer — WebXR entry point
 *
 * Architecture:
 *   • IWSDK `World` drives the Three.js scene and XR session lifecycle.
 *   • Cornerstone3D renders each view into a hidden off-screen DOM element.
 *   • Each frame, `DicomSystem` blits the Cornerstone canvas into a
 *     `THREE.CanvasTexture` that textures a grabbable panel mesh.
 *   • Dashboard panel (canvas-drawn): metadata, hint, cache bar, Exit XR control.
 *   • View panels (Axial / Sagittal / Coronal): default-open on a shallow horizontal
 *     arc in front of the user (each faces the head). Grabbable; vertical slice strip on the right.
 *   • Isosurface GLB: centered near the layout; two-hand grab for move + rotate (scale off).
 */

import {
  World,
  OneHandGrabbable,
  TwoHandsGrabbable,
  Interactable,
  Pressed,
  createSystem,
  SessionMode,
} from '@iwsdk/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  utilities,
  type Types,
} from '@cornerstonejs/core';
import { initCornerstone } from './cornerstone';
import {
  ctVoiCallback,
  fetchXrPreviewGlbFilename,
  getDicomDataDirUrl,
  getVoiFromMetadata,
  imageIdsReadyForVolume,
  loadFromManifest,
  prefetchAll,
  XR_PREVIEW_GLB_DEFAULT,
} from './dicom';
import {
  registerDicomServiceWorker,
  evictDicomHttpCache,
  rebuildDicomHttpCache,
} from './dicom-cache';
import { getDicomCacheStatus } from './dicom-cache-status';
import {
  CACHE_BTN_CLEAR,
  CACHE_BTN_REBUILD,
  DASH_HINT_XR_PLAIN,
  DASH_TITLE,
  XR_BTN_EXIT,
} from './dashboard-copy';
import { getDicomStudyMeta, type DicomStudyMeta } from './dicom-study-meta';
import {
  ORIENTATION_MAP,
  PLANE_IDS,
  VIEW_COLORS_HEX,
  VIEW_LABELS,
  type PlaneId,
} from './viewer-planes';
import { clearSession, loadSession, saveSession } from './session';

// ── Constants ─────────────────────────────────────────────────────────────────

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomXrVol';
const RE_ID     = 'xr-re';

const PANEL_W    = 0.65;  // viewport panel width  (metres)
const PANEL_H    = 0.65;  // viewport panel height (metres)
/** Longest axis of the isosurface after scaling — strictly smaller than a viewport panel. */
const GLB_PREVIEW_MAX_AXIS_M = Math.min(PANEL_W, PANEL_H) * 0.4;
const GLB_GRAB_HIT_RADIUS_M = GLB_PREVIEW_MAX_AXIS_M * 0.75;
const SLICE_PLANE_OPACITY = 0.28;
/** Opacity for the slice plane last clicked (easier to see + confirms hit). */
const SLICE_PLANE_OPACITY_ACTIVE = 0.62;
/** Plane mesh width/height vs fitted AABB (larger = easier ray hits than the isosurface). */
const SLICE_PLANE_VISUAL_SCALE = 1.5;
const HEADER_H   = 0.065; // title-bar height      (metres)
const CANVAS_PX  = 512;   // Cornerstone canvas pixel size
/** When slice indices are unchanged, still blit Cornerstone at this interval (ms) so W/L updates appear. */
const XR_CORNERSTONE_BLIT_IDLE_MS = 150;
/** Force full-rate Cornerstone blits for this many frames after XR panels mount. */
const XR_STARTUP_BLIT_FRAMES = 36;
/** After a slice jump, blit this many frames so the new slice appears even if snapshot lags one frame. */
const XR_SLICE_JUMP_BLIT_FRAMES = 12;

const DASH_W_M  = 0.72;   // dashboard width in scene (metres)
const DASH_CW   = 1024;   // dashboard texture width (px)
/** Texture height (px); keep in sync with content in `drawDashboard`. */
const DASH_CH   = 880;
const DASH_H_METRES = DASH_W_M * (DASH_CH / DASH_CW);

const VIEW_HEADER_PX_W = 512;
const VIEW_HEADER_PX_H = 48;

/** Vertical slice control strip (canvas px); placed to the right of the DICOM viewport. */
const SLIDER_PX_W = 56;
const SLIDER_PX_H = CANVAS_PX;
const SLIDER_STRIP_W_M = 0.052;
const SLIDER_VIEWPORT_GAP_M = 0.014;

/** Panels rotate to face this point (comfortable viewing height, below eye level). */
const PANEL_LOOK_TARGET = new THREE.Vector3(0, 1.0, 0);

/**
 * Horizontal arc in XZ: circle center sits a bit closer to the user; panels rest on
 * the rim bulging toward -Z so they form a curve instead of stacking.
 */
const PANEL_ARC_CENTER = new THREE.Vector3(0, 0.98, -0.56);
const PANEL_ARC_RADIUS = 1.02;
/** Degrees on the arc from centerline (0 = straight ahead; same as coronal). */
const VIEW_ARC_ANGLE_DEG: Record<PlaneId, number> = {
  coronal: 0,
  sagittal: 48,
  axial: -48,
};

/** Vertical gap between coronal panel top and dashboard bottom (metres). */
const DASH_GAP_ABOVE_CORONAL_M = 0.06;

/**
 * Isosurface GLB grab origin (metres), tuned in XR; values rounded from measured world/local pose.
 */
/** Grab-handle local position for the preview mesh (tuned in XR). */
const GLB_PREVIEW_POS = new THREE.Vector3(-0.017249, 0.877749, -0.575167);

/**
 * Default orientation for the preview mesh in world space (degrees, Euler order YXZ).
 * Snapped to the nearest multiple of 90° from XR tuning (−84°, −29°, 30° → −90°, 0°, 0°).
 */
const GLB_PREVIEW_WORLD_YXZ_DEG = { x: -90, y: 0, z: 0 } as const;

/** Point on the arc at `deg`; sets `out` to (x, arc deck y, z). */
function arcPointAtAngleDeg(deg: number, out: THREE.Vector3): void {
  const rad = (deg * Math.PI) / 180;
  const r = PANEL_ARC_RADIUS;
  out.set(
    PANEL_ARC_CENTER.x + r * Math.sin(rad),
    PANEL_ARC_CENTER.y,
    PANEL_ARC_CENTER.z - r * Math.cos(rad),
  );
}

function placePanelOnArc(group: THREE.Object3D, view: PlaneId): void {
  arcPointAtAngleDeg(VIEW_ARC_ANGLE_DEG[view], group.position);
  group.lookAt(PANEL_LOOK_TARGET);
}

type CacheBtnRect = {
  action: 'clear' | 'rebuild';
  x: number; y: number; w: number; h: number;
};

// ── Module-level state ────────────────────────────────────────────────────────

let gRE: RenderingEngine | null       = null;
let gVoiRange = { lower: -500, upper: 500 };
let gGlbRootObj: THREE.Object3D | null = null;
/** GLB root + slice planes parent (for world ↔ local). */
let gGlbModelPivotObj: THREE.Object3D | null = null;
const _sliceWorldScratch = new THREE.Vector3();
const _glbRootWorldBox = new THREE.Box3();

// Dashboard redraw state
let gDashCtx:     CanvasRenderingContext2D | null = null;
let gDashTexture: THREE.CanvasTexture | null      = null;
let gDashMeta:    DicomStudyMeta | null            = null;
let gDashboardDirty                               = false;

// Cached hit-test rects (updated every time the dashboard is redrawn)
let gExitXrRect:  { x: number; y: number; w: number; h: number } | null = null;
let gCacheBtnRects: CacheBtnRect[] = [];

let gXRCacheStatus       = 'Offline file cache: …';
let gXRCacheInteractable = true;
let gXRCacheBusy         = false;
let gXRRebuildImageIds: string[] = [];

/** Grabbable handle for the main dashboard (center top). */
let gDashDragEntity: ReturnType<World['createEntity']> | null = null;
/** Dashboard body mesh (pose follows `gDashDragEntity`). */
let gDashMeshRef: THREE.Mesh | null = null;

const _tmpDashWorldPos = new THREE.Vector3();
const _tmpDashWorldQuat = new THREE.Quaternion();

type ViewPanel = {
  view:        PlaneId;
  vpId:        string;
  domEl:       HTMLElement;
  panelCanvas: HTMLCanvasElement;
  panelCtx:    CanvasRenderingContext2D;
  csCanvas:    HTMLCanvasElement | null;
  texture:     THREE.CanvasTexture;
  entity:      ReturnType<World['createEntity']>;
  // Separate grabbable handle entities
  dragHandleEntity:   ReturnType<World['createEntity']>;
  resizeHandleEntity: ReturnType<World['createEntity']>;
  /** Last resize-handle position (detect grab-driven resize deltas). */
  lastResizePos: THREE.Vector3;
  headerCanvas:  HTMLCanvasElement;
  headerCtx:     CanvasRenderingContext2D;
  headerTexture: THREE.CanvasTexture;
  sliderCanvas:  HTMLCanvasElement;
  sliderCtx:     CanvasRenderingContext2D;
  sliderTexture: THREE.CanvasTexture;
  /** Active pointer id on the vertical slice strip (null = not dragging). */
  sliceStripPointerId: number | null;
  sliceJumpInFlight: boolean;
  sliceJumpQueued: number | null;
  sliceLastIndex: number;
  /** Last header/strip paint key (`current/total`); skip 2D redraw when unchanged. */
  lastPaintedSliceKey: string;
};

type SlicePlane = {
  view: PlaneId;
  entity: ReturnType<World['createEntity']>;
  /** Fixed local-plane rotation under modelPivot; rotates with GLB handle. */
  localQuat: THREE.Quaternion;
  lastRequestedIndex: number;
};

// Local offsets from panel center to each handle (at scale 1.0).
// Drag: center top. World position = panelPos + rotateLocal(offset * scale).
const DRAG_HANDLE_TOP_MARGIN = 0.03;
const DRAG_HANDLE_OFFSET = new THREE.Vector3(
  0,
  PANEL_H / 2 + HEADER_H + DRAG_HANDLE_TOP_MARGIN,
  0.006,
);
const RESIZE_HANDLE_OFFSET = new THREE.Vector3(PANEL_W / 2 - 0.02, -PANEL_H / 2 + 0.02,           0.005);

const DASH_DRAG_TOP_MARGIN = 0.045;
const DASH_DRAG_HANDLE_OFFSET = new THREE.Vector3(
  0,
  DASH_H_METRES / 2 + DASH_DRAG_TOP_MARGIN,
  0.014,
);
const RESIZE_HANDLE_BASE_LEN = RESIZE_HANDLE_OFFSET.length();

const _tmpResizeDir = new THREE.Vector3();
const _tmpDragCorner = new THREE.Vector3();
const _tmpRhCorner   = new THREE.Vector3();
const _tmpResizeDelta = new THREE.Vector3();

/** Last good `numScrollSteps` per view (Cornerstone sometimes throws briefly in XR). */
const gSliceScrollTotalCache = new Map<PlaneId, number>();

function applySlicePlaneOpacityHighlight(active: PlaneId | null): void {
  for (const [view, plane] of gSlicePlanes) {
    const mesh = plane.entity.object3D as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = view === active ? SLICE_PLANE_OPACITY_ACTIVE : SLICE_PLANE_OPACITY;
  }
}

/**
 * GrabSystem sets `pointerEventsType = { deny: 'ray' }` on OneHandGrabbable targets, which blocks
 * XR controller rays. Slice planes must allow rays so grabs + our pointer listeners work.
 */
function ensureSlicePlanePointerEventsForRays(): void {
  for (const plane of gSlicePlanes.values()) {
    (plane.entity.object3D as any).pointerEventsType = 'all';
  }
}

let gPrevSliceSnapshot = '';
let gLastCornerstoneBlitMs = 0;
let gXrStartupBlitCountdown = XR_STARTUP_BLIT_FRAMES;
let gCornerstoneBlitBoostFrames = 0;
const gSliceStateScratch = new Map<string, { current: number; total: number }>();

function resizeHandleWorldDir(panelObj: THREE.Object3D, target: THREE.Vector3): THREE.Vector3 {
  return target
    .copy(RESIZE_HANDLE_OFFSET)
    .normalize()
    .applyQuaternion(panelObj.quaternion);
}

function scaledLocalOffsetWorld(
  panelObj: THREE.Object3D,
  localOffset: THREE.Vector3,
  scale: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  return target.copy(localOffset).multiplyScalar(scale).applyQuaternion(panelObj.quaternion);
}

const gPanels = new Map<string, ViewPanel>();
const gSlicePlanes = new Map<PlaneId, SlicePlane>();

// ── Cornerstone slice-state helpers ──────────────────────────────────────────

function fillSliceStates(out: Map<string, { current: number; total: number }>): Map<string, { current: number; total: number }> {
  out.clear();
  if (!gRE) return out;
  for (const view of PLANE_IDS) {
    const panel = gPanels.get(view);
    if (!panel) continue;
    try {
      const vp = gRE.getViewport(panel.vpId) as Types.IVolumeViewport;
      /** Same source as `jumpToSlice` / `getSliceIndex` — *not* `getVolumeViewportScrollInfo.numScrollSteps` (often off by steps). */
      const sliceData = utilities.getImageSliceDataForVolumeViewport(vp as Types.IVolumeViewport);
      if (sliceData && sliceData.numberOfSlices >= 1) {
        const total = sliceData.numberOfSlices;
        const idx0 = Math.max(0, Math.min(total - 1, sliceData.imageIndex));
        gSliceScrollTotalCache.set(view, total);
        out.set(view, { current: idx0 + 1, total });
      } else {
        const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
        if (info.numScrollSteps > 0) {
          gSliceScrollTotalCache.set(view, info.numScrollSteps);
        }
        out.set(view, { current: info.currentStepIndex + 1, total: info.numScrollSteps });
      }
    } catch {
      const cachedTotal = gSliceScrollTotalCache.get(view);
      if (cachedTotal !== undefined && cachedTotal > 0) {
        const cur = panel.sliceLastIndex >= 0 ? panel.sliceLastIndex + 1 : 1;
        out.set(view, { current: cur, total: cachedTotal });
      }
    }
  }
  return out;
}

const _planeGeomZ = new THREE.Vector3(0, 0, 1);
const _qwPivot = new THREE.Quaternion();
const _qwPlane = new THREE.Quaternion();
const _qwInvPivot = new THREE.Quaternion();

/** World-locked plane orientation: mesh is under `pivot`, so local quat = inv(pivotWorld) * planeWorld. */
function setSlicePlaneLocalRotationWorldLocked(
  mesh: THREE.Object3D,
  pivot: THREE.Object3D,
  worldNormal: THREE.Vector3,
): void {
  _qwPlane.setFromUnitVectors(_planeGeomZ, worldNormal);
  pivot.getWorldQuaternion(_qwPivot);
  _qwInvPivot.copy(_qwPivot).invert();
  mesh.quaternion.copy(_qwInvPivot).multiply(_qwPlane);
}

/** Per MPR view: world-space plane normal, world axis the plane slides on, Cornerstone index direction. */
const XR_SLICE_BY_VIEW: Record<
  PlaneId,
  { worldNormal: THREE.Vector3; scrollAxis: 0 | 1 | 2; highEndIsFirstSlice: boolean }
> = {
  axial: { worldNormal: new THREE.Vector3(0, 1, 0), scrollAxis: 1, highEndIsFirstSlice: true },
  sagittal: { worldNormal: new THREE.Vector3(1, 0, 0), scrollAxis: 0, highEndIsFirstSlice: false },
  coronal: { worldNormal: new THREE.Vector3(0, 0, 1), scrollAxis: 2, highEndIsFirstSlice: false },
};

function fracFromSlice(current: number, total: number): number {
  if (total <= 1) return 0;
  return THREE.MathUtils.clamp((current - 1) / (total - 1), 0, 1);
}

function axisValueFromSlice(
  current: number,
  total: number,
  min: number,
  max: number,
  highEndIsFirstSlice: boolean,
): number {
  const frac = fracFromSlice(current, total);
  if (highEndIsFirstSlice) {
    return THREE.MathUtils.lerp(max, min, frac);
  }
  return THREE.MathUtils.lerp(min, max, frac);
}

function sliceIndexFromAxis(
  value: number,
  total: number,
  min: number,
  max: number,
  highEndIsFirstSlice: boolean,
): number {
  if (total <= 1 || Math.abs(max - min) < 1e-6) return 0;
  const span = max - min;
  const frac = highEndIsFirstSlice
    ? THREE.MathUtils.clamp((max - value) / span, 0, 1)
    : THREE.MathUtils.clamp((value - min) / span, 0, 1);
  return Math.round(frac * (total - 1));
}

/** World-space point: AABB center on X/Z (or the two non-scroll axes), slice depth on scroll axis. */
function slicePlaneWorldPositionFromBox(
  box: THREE.Box3,
  scrollAxis: 0 | 1 | 2,
  scrollCoord: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(box.getCenter(new THREE.Vector3()));
  out.setComponent(scrollAxis, scrollCoord);
  return out;
}

/** One pass: world AABB once; slider sync or single-axis drag + `jumpToSlice` when grabbed. */
function applySlicePlanesFromState(
  sliceStates: Map<string, { current: number; total: number }>,
): void {
  const root = gGlbRootObj;
  const pivot = gGlbModelPivotObj;
  if (!root || !pivot || gSlicePlanes.size === 0) return;
  root.updateMatrixWorld(true);
  pivot.updateMatrixWorld(true);
  _glbRootWorldBox.setFromObject(root, true);

  for (const plane of gSlicePlanes.values()) {
    const obj = plane.entity.object3D!;
    const cfg = XR_SLICE_BY_VIEW[plane.view];
    const ax = cfg.scrollAxis;
    const minW = _glbRootWorldBox.min.getComponent(ax);
    const maxW = _glbRootWorldBox.max.getComponent(ax);

    if (plane.entity.hasComponent(Pressed)) {
      _sliceWorldScratch.copy(obj.position);
      pivot.localToWorld(_sliceWorldScratch);
      const clampedW = THREE.MathUtils.clamp(_sliceWorldScratch.getComponent(ax), minW, maxW);
      slicePlaneWorldPositionFromBox(_glbRootWorldBox, ax, clampedW, _sliceWorldScratch);
      pivot.worldToLocal(_sliceWorldScratch);
      obj.position.copy(_sliceWorldScratch);
      obj.quaternion.copy(plane.localQuat);

      const panel = gPanels.get(plane.view);
      const ss = sliceStates.get(plane.view);
      if (!panel || !ss || ss.total <= 1) continue;
      const idx = sliceIndexFromAxis(
        clampedW,
        ss.total,
        minW,
        maxW,
        cfg.highEndIsFirstSlice,
      );
      if (idx === plane.lastRequestedIndex) continue;
      plane.lastRequestedIndex = idx;
      requestPanelSliceJump(panel, idx);
    } else {
      const ss = sliceStates.get(plane.view);
      if (!ss || ss.total < 1) continue;
      const coordW = axisValueFromSlice(
        ss.current,
        ss.total,
        minW,
        maxW,
        cfg.highEndIsFirstSlice,
      );
      slicePlaneWorldPositionFromBox(_glbRootWorldBox, ax, coordW, _sliceWorldScratch);
      obj.position.copy(_sliceWorldScratch);
      pivot.worldToLocal(obj.position);
      obj.quaternion.copy(plane.localQuat);
      plane.lastRequestedIndex = Math.max(0, ss.current - 1);
    }
  }
}

function clearSlicePlanes(): void {
  for (const plane of gSlicePlanes.values()) {
    plane.entity.destroy();
  }
  gSlicePlanes.clear();
}

/**
 * Slice planes live under `modelPivot` (sibling of `root`) so we never attach an IWSDK Transform
 * entity to `gltf.scene` — that was hiding planes. ECS parent is `pivotEntity` so planes follow
 * the grab handle. Each frame, slice depth is taken from the volume index and written as a world
 * point on the mesh AABB, then converted with `modelPivot.worldToLocal` for the mesh transform.
 */
function createSlicePlanes(
  world: World,
  modelPivot: THREE.Object3D,
  root: THREE.Object3D,
  bounds: THREE.Box3,
  pivotEntity: ReturnType<World['createTransformEntity']>,
): void {
  clearSlicePlanes();

  const size = bounds.getSize(new THREE.Vector3());
  const ps = SLICE_PLANE_VISUAL_SCALE;
  root.updateMatrixWorld(true);
  modelPivot.updateMatrixWorld(true);

  for (const view of PLANE_IDS) {
    const col = VIEW_COLORS_HEX[view];
    const cfg = XR_SLICE_BY_VIEW[view];

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: SLICE_PLANE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );

    const dims = [size.x * ps, size.y * ps, size.z * ps].sort((a, b) => b - a);
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(
      Math.max(dims[0], 1e-4),
      Math.max(dims[1], 1e-4),
    );

    modelPivot.add(mesh);
    _sliceWorldScratch.copy(bounds.getCenter(new THREE.Vector3()));
    mesh.position.copy(_sliceWorldScratch);
    modelPivot.worldToLocal(mesh.position);
    setSlicePlaneLocalRotationWorldLocked(mesh, modelPivot, cfg.worldNormal);

    mesh.renderOrder = 10;

    const entity = world.createTransformEntity(mesh, { parent: pivotEntity });
    entity.addComponent(Interactable, {});
    entity.addComponent(OneHandGrabbable, {
      translate: true,
      rotate: false,
    });
    (entity.object3D as any).pointerEventsType = 'all';

    const plane: SlicePlane = {
      view,
      entity,
      localQuat: mesh.quaternion.clone(),
      lastRequestedIndex: -1,
    };
    mesh.addEventListener('pointerdown', () => {
      applySlicePlaneOpacityHighlight(view);
    });

    gSlicePlanes.set(view, plane);
  }
}

/** Map vertical strip UV to slice fraction (0 = first slice, 1 = last). */
function sliceFractionFromStripUv(uv: THREE.Vector2 | undefined): number | null {
  if (!uv) return null;
  const sy = (1 - uv.y) * SLIDER_PX_H;
  const pad = 14;
  const yTop = pad;
  const yBot = SLIDER_PX_H - pad;
  if (yBot <= yTop) return 0;
  return THREE.MathUtils.clamp((yBot - sy) / (yBot - yTop), 0, 1);
}

function requestPanelSliceJump(panel: ViewPanel, imageIndex: number): void {
  const idx = Math.max(0, Math.trunc(imageIndex));
  if (panel.sliceJumpInFlight) {
    panel.sliceJumpQueued = idx;
    return;
  }
  panel.sliceJumpInFlight = true;
  panel.sliceJumpQueued = null;
  panel.sliceLastIndex = idx;
  void utilities.jumpToSlice(panel.domEl as HTMLDivElement, { imageIndex: idx, volumeId: VOLUME_ID })
    .then(() => {
      (gRE as any)?._needsRender?.add(panel.vpId);
      gDashboardDirty = true;
      gCornerstoneBlitBoostFrames = Math.max(gCornerstoneBlitBoostFrames, XR_SLICE_JUMP_BLIT_FRAMES);
    })
    .catch(() => { /* ignore */ })
    .finally(() => {
      panel.sliceJumpInFlight = false;
      const queued = panel.sliceJumpQueued;
      panel.sliceJumpQueued = null;
      if (queued !== null && queued !== panel.sliceLastIndex) {
        requestPanelSliceJump(panel, queued);
      }
    });
}

function applySliceStripUv(panel: ViewPanel, uv?: THREE.Vector2): void {
  if (!gRE) return;
  const frac = sliceFractionFromStripUv(uv);
  if (frac === null) return;
  try {
    const vp = gRE.getViewport(panel.vpId) as Types.IVolumeViewport;
    const sliceData = utilities.getImageSliceDataForVolumeViewport(vp as Types.IVolumeViewport);
    let total = sliceData?.numberOfSlices;
    if (total === undefined || total < 1) {
      const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
      total = info.numScrollSteps;
    }
    if (total <= 1) return;
    const idx = Math.round(frac * (total - 1));
    if (idx === panel.sliceLastIndex) return;
    requestPanelSliceJump(panel, idx);
  } catch { /* viewport not ready */ }
}

function xrCacheSetProgress(msg: string): void {
  const p = document.getElementById('xr-progress');
  if (p) {
    p.textContent = msg;
    p.style.color = '#00d4aa';
  }
}

function xrCacheShowOverlay(): void {
  const overlay = document.getElementById('xr-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.classList.remove('hidden');
}

function xrCacheHideOverlay(): void {
  const overlay = document.getElementById('xr-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 400);
}

async function refreshXRCacheStatus(): Promise<void> {
  const s = await getDicomCacheStatus();
  gXRCacheStatus = s.line;
  gXRCacheInteractable = s.interactable;
  gDashboardDirty = true;
}

function initXRCache(imageIds: string[]): void {
  gXRRebuildImageIds = imageIds;
  void refreshXRCacheStatus();
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    void refreshXRCacheStatus();
  });
}

async function runXRCacheClear(): Promise<void> {
  if (!gXRCacheInteractable || gXRCacheBusy) return;
  gXRCacheBusy = true;
  gDashboardDirty = true;
  try {
    await evictDicomHttpCache();
  } finally {
    gXRCacheBusy = false;
    gDashboardDirty = true;
    await refreshXRCacheStatus();
  }
}

async function runXRCacheRebuild(): Promise<void> {
  if (!gXRCacheInteractable || gXRCacheBusy || gXRRebuildImageIds.length === 0) return;
  gXRCacheBusy = true;
  gDashboardDirty = true;
  xrCacheShowOverlay();
  xrCacheSetProgress('Rebuilding cache…');
  try {
    await rebuildDicomHttpCache(gXRRebuildImageIds, xrCacheSetProgress);
  } catch (e) {
    const p = document.getElementById('xr-progress');
    if (p) {
      p.textContent = e instanceof Error ? e.message : String(e);
      p.style.color = '#ef4444';
    }
  } finally {
    gXRCacheBusy = false;
    gDashboardDirty = true;
    xrCacheHideOverlay();
    await refreshXRCacheStatus();
  }
}

// ── ECS System: blit Cornerstone canvases + thumbstick slice-scroll ───────────

class DicomSystem extends createSystem({}) {
  update(_delta: number, _time: number) {
    ensureSlicePlanePointerEventsForRays();
    const sliceStates = fillSliceStates(gSliceStateScratch);
    applySlicePlanesFromState(sliceStates);
    const snap = PLANE_IDS.map((v) => {
      const s = sliceStates.get(v);
      return s ? `${s.current}/${s.total}` : '--';
    }).join('|');
    const sliceChanged = snap !== gPrevSliceSnapshot;
    gPrevSliceSnapshot = snap;

    const now = performance.now();
    const idleBlitDue = now - gLastCornerstoneBlitMs >= XR_CORNERSTONE_BLIT_IDLE_MS;
    const startupBlit = gXrStartupBlitCountdown > 0;
    const boostBlit = gCornerstoneBlitBoostFrames > 0;
    const shouldBlitCornerstone =
      Boolean(gRE && gPanels.size > 0) && (sliceChanged || idleBlitDue || startupBlit || boostBlit);

    // ── Main dashboard: center-top drag handle drives position + rotation ─────
    if (gDashMeshRef && gDashDragEntity) {
      const dashObj = gDashMeshRef;
      const dhObj   = gDashDragEntity.object3D!;
      const dhPos   = dhObj.position;
      _tmpDragCorner.copy(DASH_DRAG_HANDLE_OFFSET);
      _tmpDragCorner.applyQuaternion(dhObj.quaternion);
      dashObj.position.copy(dhPos).sub(_tmpDragCorner);
      dashObj.quaternion.copy(dhObj.quaternion);
    }

    // ── View panels: move handle (center top) + resize handle ─────────────────
    // Move handle: OneHandGrabbable updates its world pose; panel matches that
    // position + rotation with the drag anchor fixed to the handle.
    // Resize handle: delta along the bottom-right diagonal updates uniform scale.
    for (const panel of gPanels.values()) {
      const panelObj = panel.entity.object3D!;
      const dhObj    = panel.dragHandleEntity.object3D!;
      const dhPos    = dhObj.position;
      const rhPos    = panel.resizeHandleEntity.object3D!.position;

      // ── Resize: uniform scale; snap resize handle on bottom-right diagonal ──
      _tmpResizeDelta.subVectors(rhPos, panel.lastResizePos);
      if (_tmpResizeDelta.lengthSq() > 1e-10) {
        const center   = panelObj.position;
        const worldDir = resizeHandleWorldDir(panelObj, _tmpResizeDir);
        const tAlong   = _tmpRhCorner.subVectors(rhPos, center).dot(worldDir);
        const newScale = THREE.MathUtils.clamp(tAlong / RESIZE_HANDLE_BASE_LEN, 0.3, 3.0);
        panelObj.scale.setScalar(newScale);
        rhPos.copy(center).addScaledVector(worldDir, newScale * RESIZE_HANDLE_BASE_LEN);
        scaledLocalOffsetWorld(panelObj, DRAG_HANDLE_OFFSET, newScale, _tmpDragCorner);
        dhPos.copy(center).add(_tmpDragCorner);
        dhObj.quaternion.copy(panelObj.quaternion);
      }

      // ── Move handle: panel position + rotation match handle (grabbable rotates by default) ──
      const scale = panelObj.scale.x;
      _tmpDragCorner.copy(DRAG_HANDLE_OFFSET).multiplyScalar(scale);
      _tmpDragCorner.applyQuaternion(dhObj.quaternion);
      panelObj.position.copy(dhPos).sub(_tmpDragCorner);
      panelObj.quaternion.copy(dhObj.quaternion);

      scaledLocalOffsetWorld(panelObj, RESIZE_HANDLE_OFFSET, scale, _tmpRhCorner);
      rhPos.copy(panelObj.position).add(_tmpRhCorner);
      panel.lastResizePos.copy(rhPos);

      const ss = sliceStates.get(panel.view);
      const cur = ss?.current ?? 1;
      const tot = ss?.total ?? 0;
      const sliceKey = `${cur}/${tot}`;
      if (sliceKey !== panel.lastPaintedSliceKey) {
        panel.lastPaintedSliceKey = sliceKey;
        redrawViewPanelHeader(panel.headerCtx, panel.view, cur, tot);
        panel.headerTexture.needsUpdate = true;
        redrawPanelSliceStrip(panel.sliderCtx, panel.view, cur, tot);
        panel.sliderTexture.needsUpdate = true;
      }
    }

    // ── Dashboard redraw ──────────────────────────────────────────────────────
    if (gDashboardDirty && gDashCtx && gDashTexture && gDashMeta) {
      gDashboardDirty = false;
      const { exitXrRect, cacheBtnRects } = drawDashboard(gDashCtx, gDashMeta);
      gExitXrRect    = exitXrRect;
      gCacheBtnRects = cacheBtnRects;
      gDashTexture.needsUpdate = true;
    }

    // ── Blit Cornerstone frames ───────────────────────────────────────────────
    // vp.render() only schedules a window.requestAnimationFrame callback —
    // it never renders synchronously.  In WebXR mode, Quest Browser throttles
    // window.rAF, so Cornerstone's callback never fires.
    // Fix: write viewport IDs directly into Cornerstone's _needsRender Set and
    // call _renderFlaggedViewports() ourselves, bypassing the rAF gate entirely.
    // Throttle when slice indices are unchanged so moving unrelated grabbables
    // (e.g. GLB) does not pay three full Cornerstone renders + 512² drawImage every XR frame.
    if (shouldBlitCornerstone) {
      gLastCornerstoneBlitMs = now;
      if (gXrStartupBlitCountdown > 0) gXrStartupBlitCountdown--;
      if (gCornerstoneBlitBoostFrames > 0) gCornerstoneBlitBoostFrames--;

      const re = gRE as any;
      for (const panel of gPanels.values()) {
        re._needsRender.add(panel.vpId);
      }
      try { re._renderFlaggedViewports(); } catch { /* ignore */ }

      for (const panel of gPanels.values()) {
        if (!panel.csCanvas) {
          panel.csCanvas = panel.domEl.querySelector('canvas');
        }
        if (panel.csCanvas) {
          try {
            panel.panelCtx.drawImage(panel.csCanvas, 0, 0, CANVAS_PX, CANVAS_PX);
            panel.texture.needsUpdate = true;
          } catch { /* ignore */ }
        }
      }
    }

  }
}

// ── Canvas drawing helpers ────────────────────────────────────────────────────

function rrect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

type DashRects = {
  exitXrRect: { x: number; y: number; w: number; h: number } | null;
  cacheBtnRects: CacheBtnRect[];
};

/** Multi-line text; returns Y below last line. */
function fillTextWrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  align: CanvasTextAlign,
): number {
  const words = text.split(/\s+/).filter(Boolean);
  let line = '';
  let yy = y;
  const flush = (): void => {
    if (!line) return;
    ctx.textAlign = align;
    const tx = align === 'center' ? x + maxWidth / 2 : x;
    ctx.fillText(line, tx, yy);
    yy += lineHeight;
    line = '';
  };
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      flush();
      line = w;
    } else {
      line = test;
    }
  }
  flush();
  return yy;
}

function drawPillButton(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string,
  accent: string | null,
  enabled: boolean,
): void {
  ctx.save();
  rrect(ctx, x, y, w, h, 10);
  if (!enabled) {
    ctx.fillStyle = '#131920';
    ctx.fill();
    ctx.strokeStyle = '#2a323d';
    ctx.lineWidth = 1.5;
    rrect(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.fillStyle = '#4a5260';
  } else if (accent) {
    ctx.fillStyle = '#131920';
    ctx.fill();
    ctx.strokeStyle = accent + '77';
    ctx.lineWidth = 2;
    rrect(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.fillStyle = accent;
  } else {
    ctx.fillStyle = '#131920';
    ctx.fill();
    ctx.strokeStyle = '#2a323d';
    ctx.lineWidth = 1.5;
    rrect(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.fillStyle = '#e6e6e6';
  }
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

/**
 * Redraws the XR dashboard canvas (metadata, cache, exit — no per-plane controls).
 */
function drawDashboard(
  ctx: CanvasRenderingContext2D,
  meta: DicomStudyMeta,
): DashRects {
  const W = DASH_CW;
  const H = DASH_CH;
  ctx.clearRect(0, 0, W, H);

  const padX = 36;

  // ── background ──
  ctx.fillStyle = '#131920';
  rrect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // ── title bar (matches index dash-header) ──
  const hHeader = 102;
  const hGrad = ctx.createLinearGradient(0, 0, W, 0);
  hGrad.addColorStop(0, '#1c2430');
  hGrad.addColorStop(1, '#131920');
  ctx.fillStyle = hGrad;
  ctx.fillRect(0, 0, W, hHeader);

  const bdGrad = ctx.createLinearGradient(padX, 18, padX + 56, 74);
  bdGrad.addColorStop(0, '#00d4aa');
  bdGrad.addColorStop(1, '#7c5cff');
  ctx.fillStyle = bdGrad;
  rrect(ctx, padX, 20, 56, 56, 14);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 26px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Rx', padX + 28, 48);

  ctx.fillStyle = '#e6e6e6';
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(DASH_TITLE, padX + 76, 58);

  ctx.fillStyle = '#2a323d';
  ctx.fillRect(padX, hHeader - 1, W - padX * 2, 1);

  // ── DICOM metadata ──
  const metaRows: [string, string][] = [
    ['Patient',  meta.patientName],
    ['Study',    meta.studyDescription],
    ['Series',   meta.seriesDesc],
    ['Modality', meta.modality],
    ['Slices',   String(meta.nSlices)],
    ['Matrix',   meta.matrix],
  ];
  const mTop = hHeader + 14;
  const rowH = 42;
  const labelColW = 184;
  metaRows.forEach(([label, val], i) => {
    const y = mTop + i * rowH + 26;
    ctx.fillStyle = '#8a919b';
    ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, padX, y);
    ctx.fillStyle = '#e6e6e6';
    let v = String(val);
    while (v.length > 1 && ctx.measureText(v).width > W - padX * 2 - labelColW - 8) {
      v = v.slice(0, -2) + '…';
    }
    ctx.fillText(v, padX + labelColW, y);
  });

  // ── hint (index copy, XR tweaks) ──
  let yAfterMeta = mTop + metaRows.length * rowH + 20;
  ctx.fillStyle = '#2a323d';
  ctx.fillRect(padX, yAfterMeta, W - padX * 2, 1);
  yAfterMeta += 18;
  ctx.fillStyle = '#8a919b';
  ctx.font = 'italic 24px system-ui, sans-serif';
  yAfterMeta = fillTextWrapped(ctx, DASH_HINT_XR_PLAIN, padX, yAfterMeta, W - padX * 2, 30, 'center');

  // ── cache bar ──
  const cacheTop = yAfterMeta + 18;
  const cacheH = 118;
  const cacheX = padX;
  const cacheW = W - padX * 2;
  ctx.fillStyle = '#1a2028';
  rrect(ctx, cacheX, cacheTop, cacheW, cacheH, 12);
  ctx.fill();
  ctx.strokeStyle = '#2a323d';
  ctx.lineWidth = 1.5;
  rrect(ctx, cacheX, cacheTop, cacheW, cacheH, 12);
  ctx.stroke();

  ctx.fillStyle = '#8a919b';
  ctx.font = '22px system-ui, sans-serif';
  ctx.textAlign = 'left';
  const statusY = fillTextWrapped(
    ctx, gXRCacheStatus, cacheX + 16, cacheTop + 26, cacheW - 32, 28, 'left',
  );

  const cacheBtnH = 40;
  ctx.font = 'bold 22px system-ui, sans-serif';
  const cacheBtnW1 = ctx.measureText(CACHE_BTN_CLEAR).width + 36;
  const cacheBtnW2 = ctx.measureText(CACHE_BTN_REBUILD).width + 36;
  const btnGap = 10;
  const cacheBtnY = Math.max(statusY + 10, cacheTop + cacheH - cacheBtnH - 14);
  let bx = cacheX + cacheW - 16 - cacheBtnW2 - btnGap - cacheBtnW1;
  const cacheBtnsOk = gXRCacheInteractable && !gXRCacheBusy;
  const clearBx = bx;
  drawPillButton(ctx, clearBx, cacheBtnY, cacheBtnW1, cacheBtnH, CACHE_BTN_CLEAR, null, cacheBtnsOk);
  bx += cacheBtnW1 + btnGap;
  drawPillButton(ctx, bx, cacheBtnY, cacheBtnW2, cacheBtnH, CACHE_BTN_REBUILD, null, cacheBtnsOk);

  const cacheBtnRects: CacheBtnRect[] = [];
  if (cacheBtnsOk) {
    cacheBtnRects.push(
      { action: 'clear', x: clearBx, y: cacheBtnY, w: cacheBtnW1, h: cacheBtnH },
      { action: 'rebuild', x: bx, y: cacheBtnY, w: cacheBtnW2, h: cacheBtnH },
    );
  }

  // ── Exit XR (full-width pill below cache) ──
  const exitY = cacheTop + cacheH + 28;
  const exitH = 52;
  const exitX = padX;
  const exitW = W - padX * 2;
  ctx.font = 'bold 24px system-ui, sans-serif';
  drawPillButton(ctx, exitX, exitY, exitW, exitH, XR_BTN_EXIT, '#ef4444', true);
  const exitXrRect = { x: exitX, y: exitY, w: exitW, h: exitH };

  return { exitXrRect, cacheBtnRects };
}

/** Title bar: plane name (left) and slice index / count (right). */
function redrawViewPanelHeader(
  ctx: CanvasRenderingContext2D,
  view: PlaneId,
  current: number,
  total: number,
): void {
  const col = VIEW_COLORS_HEX[view];
  const g   = ctx.createLinearGradient(0, 0, VIEW_HEADER_PX_W, 0);
  g.addColorStop(0, col);
  g.addColorStop(1, col + 'cc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_HEADER_PX_W, VIEW_HEADER_PX_H);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font      = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(VIEW_LABELS[view], 14, 32);

  const readout =
    total > 0
      ? `${Math.min(Math.max(1, current), total)} / ${total}`
      : '— / —';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font      = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(readout, VIEW_HEADER_PX_W - 14, 32);
}

/** Vertical slice strip drawn beside each view panel (matches {@link sliceFractionFromStripUv}). */
function redrawPanelSliceStrip(
  ctx: CanvasRenderingContext2D,
  view: PlaneId,
  current: number,
  total: number,
): void {
  const col = VIEW_COLORS_HEX[view];
  const W = SLIDER_PX_W;
  const H = SLIDER_PX_H;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  rrect(ctx, 0, 0, W, H, 10);
  ctx.fill();
  ctx.strokeStyle = col + '55';
  ctx.lineWidth = 1.5;
  rrect(ctx, 0, 0, W, H, 10);
  ctx.stroke();

  const padX = 10;
  const padY = 14;
  const trackX = padX;
  const trackW = W - padX * 2;
  const trackY = padY;
  const trackH = H - padY * 2;

  ctx.fillStyle = '#1e2630';
  rrect(ctx, trackX, trackY, trackW, trackH, 12);
  ctx.fill();

  if (total <= 1) {
    ctx.fillStyle = '#5c6570';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(total === 1 ? '1 slice' : '—', 0, 0);
    ctx.restore();
    return;
  }

  const fraction = THREE.MathUtils.clamp((current - 1) / (total - 1), 0, 1);
  const fillH = Math.max(10, fraction * trackH);
  const fillTop = trackY + trackH - fillH;
  ctx.fillStyle = col + '99';
  rrect(ctx, trackX, fillTop, trackW, fillH, 12);
  ctx.fill();

  const thumbCy = trackY + trackH - fraction * trackH;
  const thumbCx = trackX + trackW / 2;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(thumbCx, thumbCy, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(thumbCx, thumbCy, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.save();
  ctx.translate(W / 2, padY - 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('SLICE', 0, 0);
  ctx.restore();
}

/** Four-direction move icon (arrows along ±x / ±y) at (cx, cy). */
function drawFourWayMoveIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, arm: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.fillStyle   = 'rgba(255,255,255,0.92)';
  ctx.lineWidth   = 3.2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const shaft = arm * 0.42;
  const head  = arm * 0.22;

  for (const [dx, dy] of dirs) {
    const vx = dx * arm;
    const vy = dy * arm;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * shaft, cy + dy * shaft);
    ctx.stroke();

    const tipX = cx + vx;
    const tipY = cy + vy;
    const ox = Math.abs(dy) * head;
    const oy = Math.abs(dx) * head;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - dx * head + (dx === 0 ? -ox : 0), tipY - dy * head + (dy === 0 ? -oy : 0));
    ctx.lineTo(tipX - dx * head + (dx === 0 ? ox : 0), tipY - dy * head + (dy === 0 ? oy : 0));
    ctx.closePath();
    ctx.fill();
  }
}

// ── Handle mesh factories ─────────────────────────────────────────────────────

/** Center-top grab badge with four-way move arrows. */
function makeDragHandleMesh(col: string): THREE.Mesh {
  const c   = document.createElement('canvas');
  c.width   = 144;
  c.height  = 72;
  const ctx = c.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, 144, 0);
  g.addColorStop(0, col + 'dd');
  g.addColorStop(1, col);
  ctx.fillStyle = g;
  rrect(ctx, 4, 4, 136, 64, 16);
  ctx.fill();

  drawFourWayMoveIcon(ctx, 72, 36, 22);

  return new THREE.Mesh(
    new THREE.PlaneGeometry(0.09, 0.045),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      side: THREE.DoubleSide,
      transparent: true,
    }),
  );
}

/** Resize handle drawn at the bottom-right of each view panel. */
function makeResizeHandleMesh(): THREE.Mesh {
  const c   = document.createElement('canvas');
  c.width   = 72;
  c.height  = 72;
  const ctx = c.getContext('2d')!;

  // Corner triangle background
  ctx.fillStyle = 'rgba(200, 200, 220, 0.85)';
  ctx.beginPath();
  ctx.moveTo(8, 64);
  ctx.lineTo(64, 64);
  ctx.lineTo(64, 8);
  ctx.closePath();
  ctx.fill();

  // Diagonal notch lines
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth   = 4;
  ctx.lineCap     = 'round';
  for (let i = 0; i < 3; i++) {
    const o = 14 + i * 13;
    ctx.beginPath();
    ctx.moveTo(64 - o, 64);
    ctx.lineTo(64, 64 - o);
    ctx.stroke();
  }

  return new THREE.Mesh(
    new THREE.PlaneGeometry(0.055, 0.055),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      side: THREE.DoubleSide,
      transparent: true,
    }),
  );
}

// ── View panel factory ────────────────────────────────────────────────────────

async function openViewPanel(world: World, view: PlaneId): Promise<void> {
  if (gPanels.has(view) || !gRE) return;

  // ── Cornerstone hidden element ──
  const domEl = document.createElement('div');
  domEl.style.cssText =
    `position:fixed;left:-9999px;top:0;width:${CANVAS_PX}px;height:${CANVAS_PX}px;`;
  document.body.appendChild(domEl);

  const vpId = `xr-vp-${view}`;
  gRE.enableElement({
    viewportId: vpId,
    type: Enums.ViewportType.ORTHOGRAPHIC,
    element: domEl,
    defaultOptions: {
      orientation: ORIENTATION_MAP[view],
      background: [0, 0, 0] as Types.Point3,
    },
  });

  await setVolumesForViewports(
    gRE,
    [{ volumeId: VOLUME_ID, callback: ctVoiCallback(gVoiRange.lower, gVoiRange.upper) }],
    [vpId],
  );

  // Queue an initial render — DicomSystem will flush it on the next frame.
  (gRE as any)._needsRender.add(vpId);

  // ── Panel canvas (Cornerstone frames blitted here each frame) ──
  const panelCanvas = document.createElement('canvas');
  panelCanvas.width  = CANVAS_PX;
  panelCanvas.height = CANVAS_PX;
  const panelCtx = panelCanvas.getContext('2d')!;
  panelCtx.fillStyle = '#000';
  panelCtx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

  const texture = new THREE.CanvasTexture(panelCanvas);

  // ── Three.js geometry ──
  const viewportMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_H),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );

  const sliderCanvas = document.createElement('canvas');
  sliderCanvas.width  = SLIDER_PX_W;
  sliderCanvas.height = SLIDER_PX_H;
  const sliderCtx = sliderCanvas.getContext('2d')!;
  redrawPanelSliceStrip(sliderCtx, view, 1, 0);
  const sliderTexture = new THREE.CanvasTexture(sliderCanvas);
  const sliderMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(SLIDER_STRIP_W_M, PANEL_H),
    new THREE.MeshBasicMaterial({ map: sliderTexture, side: THREE.DoubleSide }),
  );
  sliderMesh.position.set(
    PANEL_W / 2 + SLIDER_VIEWPORT_GAP_M + SLIDER_STRIP_W_M / 2,
    0,
    0.004,
  );
  (sliderMesh as any).pointerEventsType = 'all';

  const headerCanvas = document.createElement('canvas');
  headerCanvas.width  = VIEW_HEADER_PX_W;
  headerCanvas.height = VIEW_HEADER_PX_H;
  const headerCtx = headerCanvas.getContext('2d')!;
  redrawViewPanelHeader(headerCtx, view, 1, 0);

  const headerTex    = new THREE.CanvasTexture(headerCanvas);
  const headerMesh   = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, HEADER_H),
    new THREE.MeshBasicMaterial({ map: headerTex, side: THREE.DoubleSide }),
  );
  headerMesh.position.set(0, PANEL_H / 2 + HEADER_H / 2, 0.002);

  const group = new THREE.Group();
  group.add(viewportMesh);
  group.add(sliderMesh);
  group.add(headerMesh);

  placePanelOnArc(group, view);
  const spawnPos = group.position.clone();

  // ── Main panel entity: Interactable only (no grab — handle only) ──
  const entity = world.createTransformEntity(group);
  entity.addComponent(Interactable, {});
  (entity.object3D as any).pointerEventsType = 'all';

  // ── Drag handle (center top) — the ONLY grabbable move target on the panel ──
  const col              = VIEW_COLORS_HEX[view];
  const dragHandleMesh   = makeDragHandleMesh(col);
  const initDragPos      = spawnPos.clone().add(
    DRAG_HANDLE_OFFSET.clone().applyQuaternion(group.quaternion),
  );
  dragHandleMesh.position.copy(initDragPos);
  dragHandleMesh.quaternion.copy(group.quaternion);
  const dragHandleEntity = world.createTransformEntity(dragHandleMesh);
  dragHandleEntity.addComponent(Interactable, {});
  dragHandleEntity.addComponent(OneHandGrabbable, {});
  (dragHandleEntity.object3D as any).pointerEventsType = 'all';

  // ── Resize handle (bottom-right) ──
  const resizeHandleMesh   = makeResizeHandleMesh();
  const initResizePos      = spawnPos.clone().add(
    RESIZE_HANDLE_OFFSET.clone().applyQuaternion(group.quaternion),
  );
  resizeHandleMesh.position.copy(initResizePos);
  resizeHandleMesh.quaternion.copy(group.quaternion);
  const resizeHandleEntity = world.createTransformEntity(resizeHandleMesh);
  resizeHandleEntity.addComponent(Interactable, {});
  resizeHandleEntity.addComponent(OneHandGrabbable, {});
  (resizeHandleEntity.object3D as any).pointerEventsType = 'all';

  const panel: ViewPanel = {
    view, vpId, domEl, panelCanvas, panelCtx,
    csCanvas: null, texture, entity,
    dragHandleEntity, resizeHandleEntity,
    lastResizePos: initResizePos.clone(),
    headerCanvas, headerCtx, headerTexture: headerTex,
    sliderCanvas, sliderCtx, sliderTexture,
    sliceStripPointerId: null,
    sliceJumpInFlight: false,
    sliceJumpQueued: null,
    sliceLastIndex: -1,
    lastPaintedSliceKey: '',
  };

  const stripPointerId = (e: any): number | null =>
    typeof e.pointerId === 'number' ? e.pointerId : null;

  sliderMesh.addEventListener('pointerdown', (e: any) => {
    panel.sliceStripPointerId = stripPointerId(e);
    applySliceStripUv(panel, e.uv as THREE.Vector2 | undefined);
  });
  sliderMesh.addEventListener('pointermove', (e: any) => {
    if (panel.sliceStripPointerId === null) return;
    const pid = stripPointerId(e);
    if (pid !== null && panel.sliceStripPointerId !== pid) return;
    applySliceStripUv(panel, e.uv as THREE.Vector2 | undefined);
  });
  const endStrip = (e: any): void => {
    const pid = stripPointerId(e);
    if (panel.sliceStripPointerId !== null && pid !== null && panel.sliceStripPointerId !== pid) return;
    panel.sliceStripPointerId = null;
  };
  sliderMesh.addEventListener('pointerup', endStrip);
  sliderMesh.addEventListener('pointercancel', endStrip);

  gPanels.set(view, panel);
}

// ── Dashboard factory ─────────────────────────────────────────────────────────

function createDashboard(
  world: World,
  imageId: string,
  nSlices: number,
): THREE.Mesh {
  const meta = getDicomStudyMeta(imageId, nSlices);

  // Store references so DicomSystem can redraw the dashboard
  gDashMeta   = meta;

  const canvas = document.createElement('canvas');
  canvas.width  = DASH_CW;
  canvas.height = DASH_CH;
  const ctx = canvas.getContext('2d')!;
  gDashCtx = ctx;

  const { exitXrRect, cacheBtnRects } = drawDashboard(ctx, meta);
  gExitXrRect    = exitXrRect;
  gCacheBtnRects = cacheBtnRects;

  const texture = new THREE.CanvasTexture(canvas);
  gDashTexture  = texture;

  const dashHMetres = DASH_W_M * (DASH_CH / DASH_CW);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DASH_W_M, dashHMetres),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  // Same XZ as coronal (center of the arc); above coronal with matching tilt.
  arcPointAtAngleDeg(VIEW_ARC_ANGLE_DEG.coronal, mesh.position);
  const coronalTopApprox =
    PANEL_ARC_CENTER.y + PANEL_H / 2 + HEADER_H + DASH_GAP_ABOVE_CORONAL_M;
  mesh.position.y = coronalTopApprox + dashHMetres / 2;
  mesh.lookAt(PANEL_LOOK_TARGET);

  gDashMeshRef = mesh;

  const entity = world.createTransformEntity(mesh);
  entity.addComponent(Interactable, {});
  // Dashboard body: clicks only (no grab). Moving uses the center-top handle.
  (entity.object3D as any).pointerEventsType = 'all';

  if (gDashDragEntity) {
    gDashDragEntity.destroy();
    gDashDragEntity = null;
  }
  const dashDragMesh = makeDragHandleMesh('#3d4a5c');
  mesh.getWorldPosition(_tmpDashWorldPos);
  mesh.getWorldQuaternion(_tmpDashWorldQuat);
  dashDragMesh.position
    .copy(_tmpDashWorldPos)
    .add(DASH_DRAG_HANDLE_OFFSET.clone().applyQuaternion(_tmpDashWorldQuat));
  dashDragMesh.quaternion.copy(_tmpDashWorldQuat);
  gDashDragEntity = world.createTransformEntity(dashDragMesh);
  gDashDragEntity.addComponent(Interactable, {});
  gDashDragEntity.addComponent(OneHandGrabbable, {});
  (gDashDragEntity.object3D as any).pointerEventsType = 'all';

  // ── Input event handling ──
  // A quick trigger tap (< 300 ms) synthesises a 'click' event via
  // @pmndrs/pointer-events regardless of grab state.

  mesh.addEventListener('click', (e: any) => {
    const uv = e.uv as THREE.Vector2 | undefined;
    if (!uv) return;
    // UV V=0 is texture bottom; canvas Y=0 is top → flip V
    const cx = uv.x * DASH_CW;
    const cy = (1 - uv.y) * DASH_CH;

    if (gExitXrRect) {
      const r = gExitXrRect;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
        world.exitXR();
        return;
      }
    }

    for (const cr of gCacheBtnRects) {
      if (cx >= cr.x && cx <= cr.x + cr.w && cy >= cr.y && cy <= cr.y + cr.h) {
        if (cr.action === 'clear') void runXRCacheClear();
        else void runXRCacheRebuild();
        return;
      }
    }

  });

  return mesh;
}

/** `?glb=` basename wins; otherwise uses the name from {@link manifest.json} (via caller). */
function glbFileFromQuery(manifestDefault: string): string {
  const raw = new URLSearchParams(window.location.search).get('glb');
  if (!raw?.trim()) return manifestDefault;
  const base = raw.split(/[/\\]/).pop() ?? manifestDefault;
  return base.length > 0 ? base : manifestDefault;
}

function brightenGltfMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (
        mat instanceof THREE.MeshStandardMaterial ||
        mat instanceof THREE.MeshPhysicalMaterial
      ) {
        mat.roughness = THREE.MathUtils.clamp(mat.roughness * 0.82, 0, 1);
        mat.envMapIntensity = (mat.envMapIntensity ?? 1) * 1.35;
      }
    }
  });
}

/**
 * Loads a lightweight GLB isosurface near the layout center (same asset as the GLB gallery).
 * Grabbable with one hand. Failure is non-fatal — volume slices still work without it.
 */
async function loadWebPreviewGlb(world: World, manifestGlbBasename: string): Promise<boolean> {
  const url = new URL(glbFileFromQuery(manifestGlbBasename), getDicomDataDirUrl()).href;
  const loader = new GLTFLoader();
  let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
  try {
    gltf = await loader.loadAsync(url);
  } catch {
    return false;
  }

  const root = gltf.scene;
  brightenGltfMaterials(root);

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  root.scale.setScalar(GLB_PREVIEW_MAX_AXIS_M / maxDim);
  root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const centeredBounds = new THREE.Box3().setFromObject(root, true);
  const centeredCenter = centeredBounds.getCenter(new THREE.Vector3());
  root.position.sub(centeredCenter);

  // Invisible sphere is the grab/rotate handle; pivot holds GLB + slice planes (siblings).
  const modelPivot = new THREE.Group();
  const grabHandle = new THREE.Mesh(
    new THREE.SphereGeometry(GLB_GRAB_HIT_RADIUS_M, 18, 14),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  grabHandle.position.copy(GLB_PREVIEW_POS);
  grabHandle.rotation.set(
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.x),
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.y),
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.z),
    'YXZ',
  );
  grabHandle.add(modelPivot);
  modelPivot.add(root);

  const glbHandleEntity = world.createTransformEntity(grabHandle);
  const pivotEntity = world.createTransformEntity(modelPivot, { parent: glbHandleEntity });
  root.updateMatrixWorld(true);
  const scaledBounds = new THREE.Box3().setFromObject(root, true);
  gGlbModelPivotObj = modelPivot;
  createSlicePlanes(world, modelPivot, root, scaledBounds, pivotEntity);

  glbHandleEntity.addComponent(Interactable, {});
  // Two-hand handle: reliable rotation (line between hands + wrist roll). One-hand is mostly translation.
  glbHandleEntity.addComponent(TwoHandsGrabbable, {
    translate: true,
    rotate: true,
    scale: false,
  });
  // Ensure controller rays can target this entity.
  (glbHandleEntity.object3D as any).pointerEventsType = 'all';
  gGlbRootObj = root;
  return true;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const overlay    = document.getElementById('xr-overlay')  as HTMLElement;
  const progressEl = document.getElementById('xr-progress') as HTMLElement;

  const setProgress = (msg: string): void => { progressEl.textContent = msg; };
  const hideOverlay = (): void => {
    overlay.classList.add('hidden');
    setTimeout(() => { overlay.style.display = 'none'; }, 400);
  };

  try {
    // ── 1. Cornerstone3D + DICOM ─────────────────────────────────────────────
    setProgress('Registering offline file cache…');
    await registerDicomServiceWorker();
    setProgress('Initialising Cornerstone3D…');
    await initCornerstone();

    let imageIds: string[];
    let xrPreviewGlb = XR_PREVIEW_GLB_DEFAULT;

    const session = loadSession();
    let usedSession = false;
    if (session) {
      usedSession = true;
      imageIds   = session.imageIds;
      gVoiRange  = session.voiRange;
      setProgress('Using cached session…');
      await prefetchAll(imageIds, (l, t) => setProgress(`Prefetching ${l}/${t}…`));
      xrPreviewGlb = await fetchXrPreviewGlbFilename();
    } else {
      const result = await loadFromManifest(setProgress);
      imageIds  = result.imageIds;
      gVoiRange = result.voiRange;
      xrPreviewGlb = result.xrPreviewGlb;
    }

    const nXr = imageIds.length;
    imageIds = imageIdsReadyForVolume(imageIds);
    if (imageIds.length === 0 && usedSession) {
      clearSession();
      const result = await loadFromManifest(setProgress);
      imageIds  = result.imageIds;
      gVoiRange = result.voiRange;
      xrPreviewGlb = result.xrPreviewGlb;
      imageIds = imageIdsReadyForVolume(imageIds);
    }
    if (imageIds.length === 0) {
      throw new Error(
        'No usable DICOM slices (missing metadata, bad session, or unsupported transfer syntax). Clear site data for this origin.',
      );
    }
    if (imageIds.length !== nXr) {
      gVoiRange = getVoiFromMetadata(imageIds[Math.floor(imageIds.length / 2)]);
    }
    saveSession({ imageIds, voiRange: gVoiRange });

    setProgress('Creating DICOM volume…');
    gRE = new RenderingEngine(RE_ID);
    const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
    volume.load();

    initXRCache(imageIds);
    await refreshXRCacheStatus();

    // ── 2. IWSDK World ────────────────────────────────────────────────────────
    setProgress('Starting XR scene…');
    const container = document.getElementById('scene-container') as HTMLDivElement;

    const world = await World.create(container, {
      xr: {
        sessionMode: SessionMode.ImmersiveAR, // passthrough on Quest 3/Pro
        offer: 'always',                      // show Enter AR button; Quest address-bar also works
        features: { handTracking: true },     // add 'hand-tracking' to optional XR features
      },
      features: {
        grabbing: true,
      },
      render: {
        defaultLighting: false, // MeshBasicMaterial panels don't need lights
      },
    });

    // Ambient + directional lights so IWSDK's AnimatedController / AnimatedHand
    // glTF models render with correct colour. Our DICOM panels use MeshBasicMaterial
    // and are unaffected by scene lighting.
    world.scene.add(new THREE.AmbientLight(0xffffff, 2.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(0.6, 2.2, 1.4);
    world.scene.add(key);
    const fill = new THREE.DirectionalLight(0xf2f6ff, 0.55);
    fill.position.set(-0.8, 1.2, 1.6);
    world.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(0, 1.5, -2.2);
    world.scene.add(rim);

    // Dark background for inline (non-XR) desktop preview.
    // IWSDK automatically switches to a transparent AR framebuffer on Quest.
    world.renderer.setClearColor(0x0a0e14, 1);
    world.renderer.toneMappingExposure = Math.max(world.renderer.toneMappingExposure, 1) * 1.12;

    // Quest Browser requires the WebGL context to be XR-compatible before
    // a session is requested.  Calling makeXRCompatible() here — eagerly,
    // before the user taps "Enter AR" — avoids a mid-session context loss
    // that can silently kill the XR session on Quest.
    try {
      const gl = world.renderer.getContext();
      if (typeof (gl as any).makeXRCompatible === 'function') {
        await (gl as any).makeXRCompatible();
      }
    } catch { /* ignore */ }

    world.registerSystem(DicomSystem, { priority: 50 });

    createDashboard(world, imageIds[0], imageIds.length);
    const glbOk = await loadWebPreviewGlb(world, xrPreviewGlb);
    if (!glbOk) {
      console.warn('[XR] Preview GLB failed to load', {
        requested: glbFileFromQuery(xrPreviewGlb),
        dataBase: getDicomDataDirUrl().href,
      });
      setProgress('Warning: GLB preview failed to load (slices still available).');
    }

    for (const view of PLANE_IDS) {
      await openViewPanel(world, view);
    }
    gPrevSliceSnapshot = '';
    gXrStartupBlitCountdown = XR_STARTUP_BLIT_FRAMES;
    gLastCornerstoneBlitMs = 0;
    gCornerstoneBlitBoostFrames = 0;
    gDashboardDirty = true;

    document.getElementById('xr-root')?.classList.add('xr-scene-ready');
    hideOverlay();
  } catch (err) {
    setProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
    progressEl.style.color = '#ef4444';
  }
}

main();
