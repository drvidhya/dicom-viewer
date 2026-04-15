/**
 * DICOM XR Viewer — WebXR entry point
 *
 * Architecture:
 *   • IWSDK `World` drives the Three.js scene and XR session lifecycle.
 *   • Cornerstone3D renders each view into a hidden off-screen DOM element.
 *   • Each frame, `DicomSystem` blits the Cornerstone canvas into a
 *     `THREE.CanvasTexture` that textures a grabbable panel mesh.
 *   • Dashboard panel (canvas-drawn): DICOM metadata + three vertical view boxes
 *     each with a slice slider.
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
  metaData,
  utilities,
  type Types,
} from '@cornerstonejs/core';
import { initCornerstone } from './cornerstone';
import { loadFromManifest, prefetchAll, ctVoiCallback } from './dicom';
import { loadSession, saveSession } from './session';

// ── Constants ─────────────────────────────────────────────────────────────────

const VOLUME_ID = 'cornerstoneStreamingImageVolume:dicomXrVol';
const RE_ID     = 'xr-re';

const PANEL_W    = 0.65;  // viewport panel width  (metres)
const PANEL_H    = 0.65;  // viewport panel height (metres)
const HEADER_H   = 0.065; // title-bar height      (metres)
const CANVAS_PX  = 512;   // Cornerstone canvas pixel size

const DASH_W     = 0.72;  // dashboard width  (metres)
const DASH_H     = 0.72;  // dashboard height (metres)
const DASH_PX    = 1024;  // dashboard canvas pixels

const VIEW_COLORS_HEX: Record<string, string> = {
  axial:    '#00d4aa',
  sagittal: '#ff6b9d',
  coronal:  '#7c5cff',
};
const VIEW_LABELS: Record<string, string> = {
  axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal',
};

const ORIENTATION_MAP: Record<string, Enums.OrientationAxis> = {
  axial:    Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal:  Enums.OrientationAxis.CORONAL,
};

// Spawn offsets relative to the dashboard (x, y, z)
const SPAWN_OFFSETS: Record<string, [number, number, number]> = {
  axial:    [-0.82, -0.10, -0.15],
  sagittal: [ 0.82, -0.10, -0.15],
  coronal:  [ 0,    0.82,  -0.15],
};

// ── Module-level state ────────────────────────────────────────────────────────

let gRE: RenderingEngine | null       = null;
let gVoiRange = { lower: -500, upper: 500 };
let gHoveredView: ViewPanel | null    = null;
let gScrollAccum                      = 0;

// Dashboard redraw state
let gDashCtx:     CanvasRenderingContext2D | null = null;
let gDashTexture: THREE.CanvasTexture | null      = null;
let gDashMeta:    DicomMeta | null                = null;
let gOpenViews:   Set<string> | null              = null;
let gDashboardDirty                               = false;

// Cached hit-test rects (updated every time the dashboard is redrawn)
let gBtnRects:    BtnRect[]    = [];
let gSliderRects: SliderRect[] = [];


type ViewPanel = {
  view:        'axial' | 'sagittal' | 'coronal';
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
  // Last-known positions for delta tracking
  lastDragPos:   THREE.Vector3;
  lastResizePos: THREE.Vector3;
};

// Local offsets from panel center to each handle (at scale 1.0).
// World position = panelPos + offset * currentScale.
const DRAG_HANDLE_OFFSET   = new THREE.Vector3(PANEL_W / 2 - 0.02,  PANEL_H / 2 + HEADER_H + 0.01, 0.005);
const RESIZE_HANDLE_OFFSET = new THREE.Vector3(PANEL_W / 2 - 0.02, -PANEL_H / 2 + 0.02,           0.005);

const gPanels = new Map<string, ViewPanel>();

// ── Cornerstone slice-state helpers ──────────────────────────────────────────

function getSliceStates(): Map<string, { current: number; total: number }> {
  const result = new Map<string, { current: number; total: number }>();
  if (!gRE) return result;
  for (const view of ['axial', 'sagittal', 'coronal'] as const) {
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
  view: 'axial' | 'sagittal' | 'coronal',
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

// ── ECS System: blit Cornerstone canvases + thumbstick slice-scroll ───────────

class DicomSystem extends createSystem({}) {
  update(delta: number, _time: number) {
    // ── Drag / Resize handle sync ─────────────────────────────────────────────
    // Each panel has two separate IWSDK entities (drag handle, resize handle).
    // When a handle is grabbed its position changes; we detect the delta and
    // apply it to the panel (drag) or recompute scale (resize).
    for (const panel of gPanels.values()) {
      const panelObj = panel.entity.object3D!;
      const dhPos    = panel.dragHandleEntity.object3D!.position;
      const rhPos    = panel.resizeHandleEntity.object3D!.position;

      // ── Drag: panel follows handle ──
      const dragDelta = dhPos.clone().sub(panel.lastDragPos);
      if (dragDelta.lengthSq() > 1e-10) {
        panelObj.position.add(dragDelta);
        rhPos.add(dragDelta);           // keep resize handle relative to panel
        panel.lastResizePos.add(dragDelta);
      }
      panel.lastDragPos.copy(dhPos);

      // ── Resize: scale panel to match handle distance ──
      const resizeDelta = rhPos.clone().sub(panel.lastResizePos);
      if (resizeDelta.lengthSq() > 1e-10) {
        const dist    = rhPos.distanceTo(panelObj.position);
        const base    = RESIZE_HANDLE_OFFSET.length();
        const scale   = THREE.MathUtils.clamp(dist / base, 0.3, 3.0);
        panelObj.scale.setScalar(scale);
        // Re-anchor drag handle to the scaled panel corner
        const newDragPos = panelObj.position.clone()
          .add(DRAG_HANDLE_OFFSET.clone().multiplyScalar(scale));
        dhPos.copy(newDragPos);
        panel.lastDragPos.copy(newDragPos);
      }
      panel.lastResizePos.copy(rhPos);
    }

    // ── Dashboard redraw ──────────────────────────────────────────────────────
    if (gDashboardDirty && gDashCtx && gDashTexture && gDashMeta && gOpenViews) {
      gDashboardDirty = false;
      const ss = getSliceStates();
      const { btnRects, sliderRects } = drawDashboard(gDashCtx, gDashMeta, gOpenViews, ss);
      gBtnRects    = btnRects;
      gSliderRects = sliderRects;
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

type DicomMeta = {
  patientName:      string;
  studyDescription: string;
  seriesDesc:       string;
  modality:         string;
  nSlices:          number;
  matrix:           string;
};

type BtnRect = {
  view: 'axial' | 'sagittal' | 'coronal';
  x: number; y: number; w: number; h: number;
};

type SliderRect = {
  view: 'axial' | 'sagittal' | 'coronal';
  trackX: number; trackY: number; trackW: number; trackH: number;
};

type DashRects = { btnRects: BtnRect[]; sliderRects: SliderRect[] };

/**
 * Redraws the full dashboard canvas.
 * View boxes are stacked vertically; each open box shows a slice slider.
 */
function drawDashboard(
  ctx: CanvasRenderingContext2D,
  meta: DicomMeta,
  openViews: Set<string>,
  sliceStates: Map<string, { current: number; total: number }>,
): DashRects {
  const W = DASH_PX, H = DASH_PX;
  ctx.clearRect(0, 0, W, H);

  // ── background ──
  ctx.fillStyle = '#131920';
  rrect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // ── title bar ──
  const hGrad = ctx.createLinearGradient(0, 0, W, 0);
  hGrad.addColorStop(0, '#1c2430');
  hGrad.addColorStop(1, '#131920');
  ctx.fillStyle = hGrad;
  ctx.fillRect(0, 0, W, 96);

  // Logo badge
  const bdGrad = ctx.createLinearGradient(32, 20, 80, 68);
  bdGrad.addColorStop(0, '#00d4aa');
  bdGrad.addColorStop(1, '#7c5cff');
  ctx.fillStyle = bdGrad;
  rrect(ctx, 32, 20, 52, 52, 12);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 24px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Rx', 58, 54);

  // Title
  ctx.fillStyle = '#e6e6e6';
  ctx.font = 'bold 46px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('DICOM XR Viewer', 100, 62);

  // Separator
  ctx.fillStyle = '#2a323d';
  ctx.fillRect(28, 98, W - 56, 1);

  // ── DICOM metadata (compact) ──
  const metaRows: [string, string][] = [
    ['Patient',  meta.patientName],
    ['Study',    meta.studyDescription],
    ['Series',   meta.seriesDesc],
    ['Modality', meta.modality],
    ['Slices',   String(meta.nSlices)],
    ['Matrix',   meta.matrix],
  ];
  const mY0 = 108, mLH = 40;
  metaRows.forEach(([label, val], i) => {
    const y = mY0 + i * mLH + 28;
    ctx.fillStyle = '#8a919b';
    ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, 40, y);
    ctx.fillStyle = '#e6e6e6';
    ctx.fillText(String(val).slice(0, 34), 240, y);
  });

  // ── hint text ──
  const hintY = mY0 + metaRows.length * mLH + 36;
  ctx.fillStyle = '#2a323d';
  ctx.fillRect(28, hintY - 14, W - 56, 1);
  ctx.fillStyle = '#8a919b';
  ctx.font = 'italic 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Thumbstick ↑↓ = scroll slices   Grip = grab & move', W / 2, hintY + 10);

  // ── vertical view boxes ──
  const views = ['axial', 'sagittal', 'coronal'] as const;
  const boxX  = 28;
  const boxW  = W - 56;   // 968 px
  const boxH  = 182;
  const boxGap = 14;
  const boxesY0 = hintY + 30;

  const btnRects:    BtnRect[]    = [];
  const sliderRects: SliderRect[] = [];

  views.forEach((view, i) => {
    const by    = boxesY0 + i * (boxH + boxGap);
    const isOpen = openViews.has(view);
    const col   = VIEW_COLORS_HEX[view];
    const ss    = sliceStates.get(view);

    // Box background + border
    ctx.fillStyle = isOpen ? col + '1e' : '#1a2028';
    rrect(ctx, boxX, by, boxW, boxH, 16);
    ctx.fill();
    ctx.strokeStyle = isOpen ? col : '#2d3744';
    ctx.lineWidth   = isOpen ? 2.5 : 1.5;
    rrect(ctx, boxX, by, boxW, boxH, 16);
    ctx.stroke();

    // Toggle area covers the top 68 px of the box
    btnRects.push({ view, x: boxX, y: by, w: boxW, h: 68 });

    // Status dot
    ctx.fillStyle = isOpen ? col : '#4a5260';
    ctx.beginPath();
    ctx.arc(boxX + 28, by + 30, 10, 0, Math.PI * 2);
    ctx.fill();

    // View name
    ctx.fillStyle = isOpen ? col : '#e6e6e6';
    ctx.font      = 'bold 36px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(VIEW_LABELS[view], boxX + 52, by + 38);

    // Open / closed status hint
    ctx.fillStyle = isOpen ? col : '#8a919b';
    ctx.font      = '22px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(isOpen ? '● Open – tap to close' : 'Tap to open', boxX + boxW - 22, by + 56);

    // Inner separator
    ctx.fillStyle = '#2a323d';
    ctx.fillRect(boxX + 14, by + 70, boxW - 28, 1);

    // ── Slider section ──
    const trackX = boxX + 22;
    const trackY = by + 118;
    const trackW = boxW - 44;
    const trackH = 30;

    if (isOpen && ss) {
      const fraction = ss.total > 1 ? (ss.current - 1) / (ss.total - 1) : 0;

      // Slice label
      ctx.fillStyle = '#8a919b';
      ctx.font      = '22px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Slice', boxX + 22, by + 102);
      ctx.fillStyle = col;
      ctx.font      = 'bold 22px system-ui, sans-serif';
      ctx.fillText(`${ss.current} / ${ss.total}`, boxX + 88, by + 102);

      // Track background
      ctx.fillStyle = '#2a323d';
      rrect(ctx, trackX, trackY, trackW, trackH, 15);
      ctx.fill();

      // Track fill (progress up to thumb)
      const fillW = Math.max(trackH, fraction * trackW);
      ctx.fillStyle = col + 'aa';
      rrect(ctx, trackX, trackY, fillW, trackH, 15);
      ctx.fill();

      // Thumb circle
      const thumbCx = trackX + fraction * trackW;
      const thumbCy = trackY + trackH / 2;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(thumbCx, thumbCy, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(thumbCx, thumbCy, 7, 0, Math.PI * 2);
      ctx.fill();

      sliderRects.push({ view, trackX, trackY, trackW, trackH });
    } else {
      // Disabled / not-yet-open state
      ctx.fillStyle = '#4a5260';
      ctx.font      = '22px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Slice  — / —', boxX + 22, by + 102);

      ctx.fillStyle = '#2a323d';
      rrect(ctx, trackX, trackY, trackW, trackH, 15);
      ctx.fill();

      ctx.fillStyle = '#4a5260';
      ctx.font      = '20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isOpen ? 'Loading…' : 'Open to use slider', boxX + boxW / 2, trackY + 21);
    }
  });

  return { btnRects, sliderRects };
}

/** Draws the coloured title-bar canvas for a view panel. */
function makeHeaderCanvas(view: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width  = 512;
  c.height = 48;
  const ctx = c.getContext('2d')!;

  const col = VIEW_COLORS_HEX[view];
  const g   = ctx.createLinearGradient(0, 0, 512, 0);
  g.addColorStop(0, col);
  g.addColorStop(1, col + 'cc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 48);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font      = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(VIEW_LABELS[view], 14, 32);

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.font      = '20px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('↑↓ scroll  •  ⠿ drag  •  ⊿ resize', 498, 32);

  return c;
}

// ── Handle mesh factories ─────────────────────────────────────────────────────

/** Grab-handle badge drawn at the top-right of each view panel. */
function makeDragHandleMesh(col: string): THREE.Mesh {
  const c   = document.createElement('canvas');
  c.width   = 144;
  c.height  = 72;
  const ctx = c.getContext('2d')!;

  // Rounded background
  const g = ctx.createLinearGradient(0, 0, 144, 0);
  g.addColorStop(0, col + 'dd');
  g.addColorStop(1, col);
  ctx.fillStyle = g;
  rrect(ctx, 4, 4, 136, 64, 16);
  ctx.fill();

  // Three horizontal grip lines
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(24, 20 + i * 14, 56, 5);
  }
  // Arrow icon on the right
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font      = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('⠿', 112, 47);

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
  view: 'axial' | 'sagittal' | 'coronal',
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

  const headerCanvas = makeHeaderCanvas(view);
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

  viewportMesh.addEventListener('pointerenter', () => { gHoveredView = panel; });
  viewportMesh.addEventListener('pointerleave', () => {
    if (gHoveredView === panel) gHoveredView = null;
  });

  // ── Drag handle (top-right) — the ONLY grabbable part of the panel ──
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
    lastDragPos:   initDragPos.clone(),
    lastResizePos: initResizePos.clone(),
  };

  gPanels.set(view, panel);
}

function closeViewPanel(view: string): void {
  const panel = gPanels.get(view);
  if (!panel) return;

  if (gHoveredView === panel) gHoveredView = null;

  panel.entity.destroy();
  panel.dragHandleEntity.destroy();
  panel.resizeHandleEntity.destroy();
  try { gRE?.disableElement(panel.vpId); } catch { /* ignore */ }
  document.body.removeChild(panel.domEl);
  panel.texture.dispose();

  gPanels.delete(view);
}

// ── Dashboard factory ─────────────────────────────────────────────────────────

async function createDashboard(
  world: World,
  imageId: string,
  nSlices: number,
): Promise<THREE.Mesh> {
  // Gather DICOM metadata
  const pm = metaData.get('patientModule',      imageId) ?? {};
  const sm = metaData.get('generalStudyModule',  imageId) ?? {};
  const se = metaData.get('generalSeriesModule', imageId) ?? {};
  const px = metaData.get('imagePixelModule',    imageId) ?? {};

  const meta: DicomMeta = {
    patientName:      pm.patientName       ?? '—',
    studyDescription: sm.studyDescription  ?? '—',
    seriesDesc:       se.seriesDescription ?? '—',
    modality:         se.modality          ?? 'CT',
    nSlices,
    matrix: px.columns && px.rows ? `${px.columns} × ${px.rows}` : '—',
  };

  // Store references so DicomSystem can redraw the dashboard
  gDashMeta   = meta;
  gOpenViews  = new Set<string>();

  const canvas = document.createElement('canvas');
  canvas.width  = DASH_PX;
  canvas.height = DASH_PX;
  const ctx = canvas.getContext('2d')!;
  gDashCtx = ctx;

  // Initial draw (no panels open yet, empty slice states)
  const { btnRects, sliderRects } = drawDashboard(ctx, meta, gOpenViews, new Map());
  gBtnRects    = btnRects;
  gSliderRects = sliderRects;

  const texture = new THREE.CanvasTexture(canvas);
  gDashTexture  = texture;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DASH_W, DASH_H),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  mesh.position.set(0, 1.5, -1.7);

  const entity = world.createTransformEntity(mesh);
  entity.addComponent(Interactable, {});
  entity.addComponent(OneHandGrabbable, {});
  // GrabSystem sets pointerEventsType = { deny: 'ray' } when OneHandGrabbable
  // is attached, which blocks click events.  Restore ray access immediately.
  (entity.object3D as any).pointerEventsType = 'all';

  // ── Input event handling ──
  // A quick trigger tap (< 300 ms) synthesises a 'click' event via
  // @pmndrs/pointer-events regardless of grab state, so we only need a
  // single click handler for both toggle buttons and slider click-to-jump.

  mesh.addEventListener('click', async (e: any) => {
    const uv = e.uv as THREE.Vector2 | undefined;
    if (!uv) return;
    // UV V=0 is texture bottom; canvas Y=0 is top → flip V
    const cx = uv.x * DASH_PX;
    const cy = (1 - uv.y) * DASH_PX;

    // Check toggle buttons first (top 68 px of each view box)
    for (const rect of gBtnRects) {
      if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
        const { view } = rect;
        if (gPanels.has(view)) {
          closeViewPanel(view);
          gOpenViews!.delete(view);
        } else {
          await openViewPanel(world, view, mesh);
          gOpenViews!.add(view);
        }
        gDashboardDirty = true;
        return;
      }
    }

    // Check slider tracks (click-to-jump)
    for (const sr of gSliderRects) {
      if (
        cx >= sr.trackX && cx <= sr.trackX + sr.trackW &&
        cy >= sr.trackY - 14 && cy <= sr.trackY + sr.trackH + 14
      ) {
        const fraction = Math.max(0, Math.min(1, (cx - sr.trackX) / sr.trackW));
        handleSliderJump(sr.view, fraction);
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
      saveSession(result);
    }

    setProgress('Creating DICOM volume…');
    gRE = new RenderingEngine(RE_ID);
    const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
    volume.load();

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

    hideOverlay();
  } catch (err) {
    console.error('[DICOM XR]', err);
    setProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
    progressEl.style.color = '#ef4444';
  }
}

main();
