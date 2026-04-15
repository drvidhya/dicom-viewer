/**
 * DICOM XR Viewer — WebXR entry point
 *
 * Architecture:
 *   • IWSDK `World` drives the Three.js scene and XR session lifecycle.
 *   • Cornerstone3D renders each view into a hidden off-screen DOM element.
 *   • Each frame, `DicomSystem` blits the Cornerstone canvas into a
 *     `THREE.CanvasTexture` that textures a grabbable panel mesh.
 *   • Dashboard panel (canvas-drawn): same layout as index.html — metadata, hint,
 *     cache bar, view cards with Open + slice slider (raycast hit targets).
 *   • View panels (Axial / Sagittal / Coronal): appear when the box is tapped
 *     and can be grabbed/repositioned.  Thumbstick Y scrolls through slices.
 */

import {
  World,
  OneHandGrabbable,
  Interactable,
  createSystem,
  SessionMode,
} from '@iwsdk/core';
import * as THREE from 'three';
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
  CACHE_BTN_CLEAR,
  CACHE_BTN_REBUILD,
  DASH_HINT_XR_PLAIN,
  DASH_TITLE,
} from './dashboard-copy';
import { getDicomStudyMeta, type DicomStudyMeta } from './dicom-study-meta';
import {
  ORIENTATION_MAP,
  PLANE_IDS,
  VIEW_COLORS_HEX,
  VIEW_LABELS,
  type PlaneId,
} from './viewer-planes';
import { loadSession, saveSession } from './session';

// ── Constants ─────────────────────────────────────────────────────────────────

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomXrVol';
const RE_ID     = 'xr-re';

const PANEL_W    = 0.65;  // viewport panel width  (metres)
const PANEL_H    = 0.65;  // viewport panel height (metres)
const HEADER_H   = 0.065; // title-bar height      (metres)
const CANVAS_PX  = 512;   // Cornerstone canvas pixel size

const DASH_W_M  = 0.72;   // dashboard width in scene (metres)
const DASH_CW   = 1024;   // dashboard texture width (px)
const DASH_CH   = 1180;   // dashboard texture height (px)
const DASH_H_METRES = DASH_W_M * (DASH_CH / DASH_CW);

const VIEW_HEADER_PX_W = 512;
const VIEW_HEADER_PX_H = 48;

// Spawn offsets relative to the dashboard (x, y, z)
const SPAWN_OFFSETS: Record<PlaneId, [number, number, number]> = {
  axial:    [-0.82, -0.10, -0.15],
  sagittal: [ 0.82, -0.10, -0.15],
  coronal:  [ 0,    0.82,  -0.15],
};

type CacheBtnRect = {
  action: 'clear' | 'rebuild';
  x: number; y: number; w: number; h: number;
};

// ── Module-level state ────────────────────────────────────────────────────────

let gRE: RenderingEngine | null       = null;
let gVoiRange = { lower: -500, upper: 500 };
let gHoveredView: ViewPanel | null    = null;
let gScrollAccum                      = 0;

// Dashboard redraw state
let gDashCtx:     CanvasRenderingContext2D | null = null;
let gDashTexture: THREE.CanvasTexture | null      = null;
let gDashMeta:    DicomStudyMeta | null            = null;
let gOpenViews:   Set<string> | null              = null;
let gDashboardDirty                               = false;

// Cached hit-test rects (updated every time the dashboard is redrawn)
let gOpenBtnRects: BtnRect[] = [];
let gSliderRects: SliderRect[] = [];
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

// ── Cornerstone slice-state helpers ──────────────────────────────────────────

function getSliceStates(): Map<string, { current: number; total: number }> {
  const result = new Map<string, { current: number; total: number }>();
  if (!gRE) return result;
  for (const view of PLANE_IDS) {
    const panel = gPanels.get(view);
    if (!panel) continue;
    try {
      const vp   = gRE.getViewport(panel.vpId) as Types.IVolumeViewport;
      const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
      result.set(view, { current: info.currentStepIndex + 1, total: info.numScrollSteps });
    } catch { /* viewport not ready yet */ }
  }
  return result;
}

async function handleSliderJump(
  view: PlaneId,
  fraction: number,
): Promise<void> {
  const panel = gPanels.get(view);
  if (!panel || !gRE) return;
  try {
    const vp   = gRE.getViewport(panel.vpId) as Types.IVolumeViewport;
    const info = utilities.getVolumeViewportScrollInfo(vp, VOLUME_ID);
    const idx  = Math.round(fraction * (info.numScrollSteps - 1));
    await utilities.jumpToSlice(panel.domEl as HTMLDivElement, { imageIndex: idx, volumeId: VOLUME_ID });
    gDashboardDirty = true;
  } catch { /* ignore */ }
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
    console.error(e);
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
  update(delta: number, _time: number) {
    const sliceStates = getSliceStates();

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
      const resizeDelta = rhPos.clone().sub(panel.lastResizePos);
      if (resizeDelta.lengthSq() > 1e-10) {
        const center   = panelObj.position;
        const worldDir = resizeHandleWorldDir(panelObj, _tmpResizeDir);
        const tAlong   = rhPos.clone().sub(center).dot(worldDir);
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
      redrawViewPanelHeader(
        panel.headerCtx,
        panel.view,
        ss?.current ?? 1,
        ss?.total ?? 0,
      );
      panel.headerTexture.needsUpdate = true;
    }

    // ── Dashboard redraw ──────────────────────────────────────────────────────
    if (gDashboardDirty && gDashCtx && gDashTexture && gDashMeta && gOpenViews) {
      gDashboardDirty = false;
      const { openBtnRects, sliderRects, cacheBtnRects } = drawDashboard(
        gDashCtx, gDashMeta, gOpenViews, sliceStates,
      );
      gOpenBtnRects  = openBtnRects;
      gSliderRects   = sliderRects;
      gCacheBtnRects = cacheBtnRects;
      gDashTexture.needsUpdate = true;
    }

    // ── Blit Cornerstone frames ───────────────────────────────────────────────
    // vp.render() only schedules a window.requestAnimationFrame callback —
    // it never renders synchronously.  In WebXR mode, Quest Browser throttles
    // window.rAF, so Cornerstone's callback never fires.
    // Fix: write viewport IDs directly into Cornerstone's _needsRender Set and
    // call _renderFlaggedViewports() ourselves, bypassing the rAF gate entirely.
    if (gRE && gPanels.size > 0) {
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

    // ── Thumbstick slice scrolling ────────────────────────────────────────────
    if (!gHoveredView || !gRE) return;
    const gp = this.input.gamepads.right ?? this.input.gamepads.left;
    if (!gp) return;
    const axes = gp.getAxesValues('xr-standard-thumbstick');
    if (!axes || Math.abs(axes.y) < 0.25) { gScrollAccum = 0; return; }

    gScrollAccum += -axes.y * delta * 18;
    const steps = Math.trunc(gScrollAccum);
    if (steps === 0) return;
    gScrollAccum -= steps;

    try {
      const vp  = gRE.getViewport(gHoveredView.vpId) as Types.IVolumeViewport;
      const cam = vp.getCamera();
      const n   = cam.viewPlaneNormal!;
      const fp  = cam.focalPoint!;
      vp.setCamera({
        focalPoint: [fp[0] + n[0] * steps, fp[1] + n[1] * steps, fp[2] + n[2] * steps],
      });
      // Mark viewport dirty — _renderFlaggedViewports() above will pick it up
      // next frame (or this frame if scroll happens before the blit block).
      (gRE as any)._needsRender.add(gHoveredView.vpId);
      gDashboardDirty = true;
    } catch { /* viewport might not be ready yet */ }
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

type BtnRect = {
  view: PlaneId;
  x: number; y: number; w: number; h: number;
};

type SliderRect = {
  view: PlaneId;
  trackX: number; trackY: number; trackW: number; trackH: number;
};

type DashRects = {
  openBtnRects: BtnRect[];
  sliderRects: SliderRect[];
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
 * Redraws the full dashboard canvas (layout aligned with index.html).
 */
function drawDashboard(
  ctx: CanvasRenderingContext2D,
  meta: DicomStudyMeta,
  openViews: Set<string>,
  sliceStates: Map<string, { current: number; total: number }>,
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

  // ── view cards (stacked, index-style) ──
  const boxX = padX;
  const boxW = W - padX * 2;
  const boxH = 172;
  const boxGap = 12;
  const boxesY0 = cacheTop + cacheH + 16;
  const headH = 64;
  const openBtnW = 148;
  const openBtnH = 46;

  const openBtnRects: BtnRect[] = [];
  const sliderRects: SliderRect[] = [];

  PLANE_IDS.forEach((view, i) => {
    const by = boxesY0 + i * (boxH + boxGap);
    const isOpen = openViews.has(view);
    const col = VIEW_COLORS_HEX[view];
    const ss = sliceStates.get(view);

    ctx.fillStyle = isOpen ? col + '1e' : '#1a2028';
    rrect(ctx, boxX, by, boxW, boxH, 18);
    ctx.fill();
    ctx.strokeStyle = isOpen ? col : '#2d3744';
    ctx.lineWidth = isOpen ? 2.5 : 1.5;
    rrect(ctx, boxX, by, boxW, boxH, 18);
    ctx.stroke();

    ctx.fillStyle = isOpen ? col : '#4a5260';
    ctx.beginPath();
    ctx.arc(boxX + 26, by + headH / 2, 12, 0, Math.PI * 2);
    ctx.fill();

    // Name
    ctx.fillStyle = isOpen ? col : '#e6e6e6';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(VIEW_LABELS[view], boxX + 52, by + 42);

    // State (between name and Open)
    ctx.fillStyle = isOpen ? col : '#8a919b';
    ctx.font = '22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(isOpen ? 'Panel open' : 'Closed', boxX + 52 + 160, by + 40);

    // Open / Close button (hit target)
    const obx = boxX + boxW - 18 - openBtnW;
    const oby = by + 9;
    const openLabel = isOpen ? 'Close' : 'Open';
    drawPillButton(ctx, obx, oby, openBtnW, openBtnH, openLabel, col, true);
    openBtnRects.push({ view, x: obx, y: oby, w: openBtnW, h: openBtnH });

    ctx.fillStyle = '#2a323d';
    ctx.fillRect(boxX + 16, by + headH, boxW - 32, 1);

    const trackX = boxX + 22;
    const trackY = by + headH + 56;
    const trackW = boxW - 44;
    const trackH = 32;

    if (isOpen && ss) {
      const fraction = ss.total > 1 ? (ss.current - 1) / (ss.total - 1) : 0;

      ctx.fillStyle = '#8a919b';
      ctx.font = '24px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Slice', boxX + 22, by + headH + 36);
      ctx.fillStyle = col;
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${ss.current} / ${ss.total}`, boxX + boxW - 22, by + headH + 36);
      ctx.textAlign = 'left';

      ctx.fillStyle = '#2a323d';
      rrect(ctx, trackX, trackY, trackW, trackH, 16);
      ctx.fill();

      const fillW = Math.max(trackH, fraction * trackW);
      ctx.fillStyle = col + 'aa';
      rrect(ctx, trackX, trackY, fillW, trackH, 16);
      ctx.fill();

      const thumbCx = trackX + fraction * trackW;
      const thumbCy = trackY + trackH / 2;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(thumbCx, thumbCy, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(thumbCx, thumbCy, 6, 0, Math.PI * 2);
      ctx.fill();

      sliderRects.push({ view, trackX, trackY, trackW, trackH });
    } else {
      ctx.fillStyle = '#8a919b';
      ctx.font = '24px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Slice', boxX + 22, by + headH + 36);
      ctx.fillStyle = '#4a5260';
      ctx.textAlign = 'right';
      ctx.fillText('— / —', boxX + boxW - 22, by + headH + 36);

      ctx.fillStyle = '#2a323d';
      rrect(ctx, trackX, trackY, trackW, trackH, 16);
      ctx.fill();
      ctx.fillStyle = '#4a5260';
      ctx.font = '22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isOpen ? 'Loading…' : 'Open to use slider', boxX + boxW / 2, trackY + 22);
    }
  });

  return { openBtnRects, sliderRects, cacheBtnRects };
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

async function openViewPanel(
  world: World,
  view: PlaneId,
  dashMesh: THREE.Mesh,
): Promise<void> {
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
  group.add(headerMesh);

  const dashPos   = dashMesh.getWorldPosition(new THREE.Vector3());
  const [ox, oy, oz] = SPAWN_OFFSETS[view];
  const spawnPos  = new THREE.Vector3(dashPos.x + ox, dashPos.y + oy, dashPos.z + oz);
  group.position.copy(spawnPos);

  // ── Main panel entity: Interactable only (no grab — handle only) ──
  const entity = world.createTransformEntity(group);
  entity.addComponent(Interactable, {});
  (entity.object3D as any).pointerEventsType = 'all';

  // ── Drag handle (center top) — the ONLY grabbable move target on the panel ──
  const col              = VIEW_COLORS_HEX[view];
  const dragHandleMesh   = makeDragHandleMesh(col);
  const initDragPos      = spawnPos.clone().add(DRAG_HANDLE_OFFSET);
  dragHandleMesh.position.copy(initDragPos);
  const dragHandleEntity = world.createTransformEntity(dragHandleMesh);
  dragHandleEntity.addComponent(Interactable, {});
  dragHandleEntity.addComponent(OneHandGrabbable, {});
  (dragHandleEntity.object3D as any).pointerEventsType = 'all';

  // ── Resize handle (bottom-right) ──
  const resizeHandleMesh   = makeResizeHandleMesh();
  const initResizePos      = spawnPos.clone().add(RESIZE_HANDLE_OFFSET);
  resizeHandleMesh.position.copy(initResizePos);
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
  };

  viewportMesh.addEventListener('pointerenter', () => { gHoveredView = panel; });
  viewportMesh.addEventListener('pointerleave', () => {
    if (gHoveredView === panel) gHoveredView = null;
  });

  gPanels.set(view, panel);
}

function closeViewPanel(view: PlaneId): void {
  const panel = gPanels.get(view);
  if (!panel) return;

  if (gHoveredView === panel) gHoveredView = null;

  panel.entity.destroy();
  panel.dragHandleEntity.destroy();
  panel.resizeHandleEntity.destroy();
  try { gRE?.disableElement(panel.vpId); } catch { /* ignore */ }
  document.body.removeChild(panel.domEl);
  panel.texture.dispose();
  panel.headerTexture.dispose();

  gPanels.delete(view);
}

// ── Dashboard factory ─────────────────────────────────────────────────────────

async function createDashboard(
  world: World,
  imageId: string,
  nSlices: number,
): Promise<THREE.Mesh> {
  const meta = getDicomStudyMeta(imageId, nSlices);

  // Store references so DicomSystem can redraw the dashboard
  gDashMeta   = meta;
  gOpenViews  = new Set<string>();

  const canvas = document.createElement('canvas');
  canvas.width  = DASH_CW;
  canvas.height = DASH_CH;
  const ctx = canvas.getContext('2d')!;
  gDashCtx = ctx;

  // Initial draw (no panels open yet, empty slice states)
  const { openBtnRects, sliderRects, cacheBtnRects } = drawDashboard(
    ctx, meta, gOpenViews, new Map(),
  );
  gOpenBtnRects  = openBtnRects;
  gSliderRects   = sliderRects;
  gCacheBtnRects = cacheBtnRects;

  const texture = new THREE.CanvasTexture(canvas);
  gDashTexture  = texture;

  const dashHMetres = DASH_W_M * (DASH_CH / DASH_CW);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DASH_W_M, dashHMetres),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  mesh.position.set(0, 1.5, -1.7);

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
  // @pmndrs/pointer-events regardless of grab state, so we only need a
  // single click handler for both toggle buttons and slider click-to-jump.

  mesh.addEventListener('click', async (e: any) => {
    const uv = e.uv as THREE.Vector2 | undefined;
    if (!uv) return;
    // UV V=0 is texture bottom; canvas Y=0 is top → flip V
    const cx = uv.x * DASH_CW;
    const cy = (1 - uv.y) * DASH_CH;

    for (const cr of gCacheBtnRects) {
      if (cx >= cr.x && cx <= cr.x + cr.w && cy >= cr.y && cy <= cr.y + cr.h) {
        if (cr.action === 'clear') void runXRCacheClear();
        else void runXRCacheRebuild();
        return;
      }
    }

    for (const rect of gOpenBtnRects) {
      if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
        const { view } = rect;
        if (gPanels.has(view)) {
          gOpenViews!.delete(view);
          closeViewPanel(view);
        } else {
          await openViewPanel(world, view, mesh);
          gOpenViews!.add(view);
        }
        gDashboardDirty = true;
        return;
      }
    }

    for (const sr of gSliderRects) {
      if (
        cx >= sr.trackX && cx <= sr.trackX + sr.trackW &&
        cy >= sr.trackY - 14 && cy <= sr.trackY + sr.trackH + 14
      ) {
        const fraction = Math.max(0, Math.min(1, (cx - sr.trackX) / sr.trackW));
        void handleSliderJump(sr.view, fraction);
        return;
      }
    }
  });

  return mesh;
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

    const session = loadSession();
    if (session) {
      imageIds   = session.imageIds;
      gVoiRange  = session.voiRange;
      setProgress('Using cached session…');
      await prefetchAll(imageIds, (l, t) => setProgress(`Prefetching ${l}/${t}…`));
    } else {
      const result = await loadFromManifest(setProgress);
      imageIds  = result.imageIds;
      gVoiRange = result.voiRange;
    }

    const nXr = imageIds.length;
    imageIds = imageIdsReadyForVolume(imageIds);
    if (imageIds.length === 0) {
      throw new Error(
        'No usable DICOM slices (missing metadata — often load/parse failure or unsupported transfer syntax).',
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
    world.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0, 2, 2);
    world.scene.add(dirLight);

    // Dark background for inline (non-XR) desktop preview.
    // IWSDK automatically switches to a transparent AR framebuffer on Quest.
    world.renderer.setClearColor(0x0a0e14, 1);

    // Quest Browser requires the WebGL context to be XR-compatible before
    // a session is requested.  Calling makeXRCompatible() here — eagerly,
    // before the user taps "Enter AR" — avoids a mid-session context loss
    // that can silently kill the XR session on Quest.
    try {
      const gl = world.renderer.getContext();
      if (typeof (gl as any).makeXRCompatible === 'function') {
        await (gl as any).makeXRCompatible();
      }
    } catch (e) {
      console.warn('[DICOM XR] makeXRCompatible failed:', e);
    }

    world.registerSystem(DicomSystem);

    await createDashboard(world, imageIds[0], imageIds.length);

    document.getElementById('xr-root')?.classList.add('xr-scene-ready');
    hideOverlay();
  } catch (err) {
    console.error('[DICOM XR]', err);
    setProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
    progressEl.style.color = '#ef4444';
  }
}

main();
