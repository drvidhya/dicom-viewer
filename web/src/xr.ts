import {
  World,
  SessionMode,
  PlaneGeometry,
  MeshBasicMaterial,
  Mesh,
  CanvasTexture,
  DoubleSide,
  AmbientLight,
  DirectionalLight,
} from '@iwsdk/core';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  cache,
  setVolumesForViewports,
  type Types,
} from '@cornerstonejs/core';
import { loadSession } from './session';

const XR_ENGINE_ID = 'xr-rendering-engine';

let xrWorld: World | null = null;
let xrEngine: RenderingEngine | null = null;
let xrTextures: CanvasTexture[] = [];
let transferCanvases: HTMLCanvasElement[] = [];
let textureInterval: number | null = null;

function vpCanvas(id: string): HTMLCanvasElement | null {
  return document.getElementById(id)?.querySelector('canvas') ?? null;
}

function ctCallback(lower: number, upper: number) {
  return ({ volumeActor }: { volumeActor: any }) => {
    volumeActor.getProperty().getRGBTransferFunction(0).setMappingRange(lower, upper);
  };
}

export async function initXR(volumeId: string): Promise<void> {
  if (xrWorld) return;

  const session = loadSession();
  if (!session) throw new Error('No DICOM session found. Load the main window first.');
  const { imageIds, voiRange } = session;

  console.log('[XR] initXR — volumeId:', volumeId, 'imageIds:', imageIds.length, 'voiRange:', voiRange);

  const container = document.getElementById('xr-scene-container') as HTMLDivElement;
  container.style.display = 'block';

  console.log('[XR] Creating iWSDK World...');
  xrWorld = await World.create(container, {
    xr: { sessionMode: SessionMode.ImmersiveVR, offer: 'none', features: { layers: false } },
    render: { defaultLighting: false, fov: 75, near: 0.05, far: 100 },
    features: { spatialUI: false },
  });
  console.log('[XR] World created');

  xrWorld.scene.add(new AmbientLight(0xffffff, 1.0));
  const sun = new DirectionalLight(0xffffff, 0.4);
  sun.position.set(0, 3, 3);
  xrWorld.scene.add(sun);

  xrEngine = new RenderingEngine(XR_ENGINE_ID);
  console.log('[XR] Cornerstone XR rendering engine created');

  const mprDefs = [
    { id: 'xr-vp-axial',    orientation: Enums.OrientationAxis.AXIAL },
    { id: 'xr-vp-sagittal', orientation: Enums.OrientationAxis.SAGITTAL },
    { id: 'xr-vp-coronal',  orientation: Enums.OrientationAxis.CORONAL },
  ];

  xrEngine.setViewports(
    mprDefs.map(({ id, orientation }) => ({
      viewportId: id,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: document.getElementById(id) as HTMLDivElement,
      defaultOptions: {
        orientation,
        background: [0.05, 0.05, 0.05] as Types.Point3,
      },
    })),
  );

  // Reuse the volume already loaded by the main viewport; only create if not cached.
  let volume = cache.getVolume(volumeId);
  if (volume) {
    console.log('[XR] Reusing cached volume');
  } else {
    console.log('[XR] Volume not in cache — creating from session imageIds');
    volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
    volume.load();
  }

  const mprIds = mprDefs.map((d) => d.id);
  console.log('[XR] Assigning volume to MPR viewports:', mprIds);
  await setVolumesForViewports(
    xrEngine,
    [{ volumeId, callback: ctCallback(voiRange.lower, voiRange.upper) }],
    mprIds,
  );

  for (const id of mprIds) {
    const vp = xrEngine.getViewport(id) as Types.IVolumeViewport;
    vp.setProperties({
      voiRange,
      VOILUTFunction: Enums.VOILUTFunctionType.LINEAR,
      colormap: { name: 'Grayscale' },
    });
  }
  xrEngine.renderViewports(mprIds);
  console.log('[XR] MPR viewports rendered');

  let has3D = false;
  try {
    xrEngine.enableElement({
      viewportId: 'xr-vp-3d',
      type: Enums.ViewportType.VOLUME_3D,
      element: document.getElementById('xr-vp-3d') as HTMLDivElement,
      defaultOptions: {
        orientation: Enums.OrientationAxis.CORONAL,
        background: [0.05, 0.05, 0.12] as Types.Point3,
      },
    });
    await setVolumesForViewports(xrEngine, [{ volumeId }], ['xr-vp-3d']);
    const vp3d = xrEngine.getViewport('xr-vp-3d') as Types.IVolumeViewport;
    vp3d.setProperties({ preset: 'CT-Bone' });
    xrEngine.renderViewports(['xr-vp-3d']);
    has3D = true;
    console.log('[XR] 3D volume viewport ready');
  } catch (e) {
    console.warn('[XR] 3D volume viewport unavailable:', e);
  }

  type PanelDef = { vpId: string; pos: [number, number, number]; w: number; h: number };
  const panels: PanelDef[] = has3D
    ? [
        { vpId: 'xr-vp-3d',       pos: [ 0.0,  1.60, -2.5], w: 0.80, h: 0.80 },
        { vpId: 'xr-vp-sagittal', pos: [-1.00, 1.60, -2.5], w: 0.60, h: 0.60 },
        { vpId: 'xr-vp-coronal',  pos: [ 1.00, 1.60, -2.5], w: 0.60, h: 0.60 },
        { vpId: 'xr-vp-axial',    pos: [ 0.0,  0.85, -2.5], w: 0.60, h: 0.60 },
      ]
    : [
        { vpId: 'xr-vp-sagittal', pos: [-0.85, 1.6, -2.5], w: 0.65, h: 0.65 },
        { vpId: 'xr-vp-axial',    pos: [ 0.0,  1.6, -2.5], w: 0.65, h: 0.65 },
        { vpId: 'xr-vp-coronal',  pos: [ 0.85, 1.6, -2.5], w: 0.65, h: 0.65 },
      ];

  xrTextures = [];
  transferCanvases = [];

  type ActivePanel = { vpId: string; transfer: HTMLCanvasElement; tex: CanvasTexture };
  const activePanels: ActivePanel[] = [];

  console.log(`[XR] Building ${panels.length} panels (has3D=${has3D})`);

  for (const { vpId, pos, w, h } of panels) {
    const src = vpCanvas(vpId);
    if (!src) { console.warn(`[XR] No canvas found for ${vpId}`); continue; }

    console.log(`[XR] Panel ${vpId}: canvas=${src.width}x${src.height} pos=[${pos}] size=${w}x${h}m`);

    // Intermediate 2D canvas — avoids WebGL cross-context errors when wrapping
    // Cornerstone's WebGL canvas directly in CanvasTexture.
    const transfer = document.createElement('canvas');
    transfer.width = 512;
    transfer.height = 512;
    transfer.getContext('2d')!.drawImage(src, 0, 0, 512, 512);
    transferCanvases.push(transfer);

    const tex = new CanvasTexture(transfer);
    tex.needsUpdate = true;
    xrTextures.push(tex);

    const mesh = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ map: tex, side: DoubleSide }),
    );
    mesh.position.set(...pos);
    xrWorld.scene.add(mesh);

    activePanels.push({ vpId, transfer, tex });
  }

  let tickCount = 0;
  textureInterval = window.setInterval(() => {
    for (const { vpId, transfer, tex } of activePanels) {
      const src = vpCanvas(vpId);
      if (src) {
        transfer.getContext('2d')!.drawImage(src, 0, 0, transfer.width, transfer.height);
        tex.needsUpdate = true;
      }
    }
    tickCount++;
    if (tickCount === 1 || tickCount % 50 === 0) {
      console.log(`[XR] Texture tick #${tickCount} — updated ${activePanels.length} panels`);
    }
  }, 100);

  console.log('[XR] initXR complete');
}

export function launchXR(): void {
  console.log('[XR] launchXR — requesting immersive-vr session (layers=false)');
  xrWorld?.launchXR({ sessionMode: SessionMode.ImmersiveVR, features: { layers: false } });
}

export function exitXR(): void {
  xrWorld?.exitXR();
}

export function isXRInitialized(): boolean {
  return xrWorld !== null;
}

export function destroyXR(): void {
  if (textureInterval !== null) {
    clearInterval(textureInterval);
    textureInterval = null;
  }
  xrTextures.forEach((t) => t.dispose());
  xrTextures = [];
  transferCanvases = [];

  xrEngine?.destroy();
  xrEngine = null;

  const container = document.getElementById('xr-scene-container');
  if (container) container.style.display = 'none';

  xrWorld = null;
}
