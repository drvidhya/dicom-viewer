/**
 * Standalone Three.js viewer for GLBs under `dicom/data`.
 *
 * Lighting, renderer exposure, material tuning, scale/centering, and model
 * orientation match the XR preview GLB in `xr-main.ts`.
 *
 * Query: `?glb=model.glb` (basename under dicom/data). Default: manifest or `web-preview.glb`.
 *
 * Env: `VITE_DICOM_DATA_BASE` — same as main app (`dicom.ts`).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const PANEL_M = 0.65;
const GLB_PREVIEW_MAX_AXIS_M = Math.min(PANEL_M, PANEL_M) * 0.4;
const GLB_PREVIEW_WORLD_YXZ_DEG = { x: -90, y: 0, z: 0 } as const;

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

function getDicomDataDirUrl(): URL {
  const envRaw = import.meta.env.VITE_DICOM_DATA_BASE?.trim();
  if (envRaw) {
    if (envRaw.startsWith('http://') || envRaw.startsWith('https://')) {
      return new URL(envRaw.endsWith('/') ? envRaw : `${envRaw}/`);
    }
    const path = envRaw.replace(/^\/+/, '');
    const withSlash = path.endsWith('/') ? path : `${path}/`;
    return new URL(withSlash, window.location.origin);
  }

  const base = (import.meta.env.BASE_URL ?? './').trim() || './';
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  const appRootUrl = withSlash.startsWith('/')
    ? new URL(withSlash, window.location.origin)
    : new URL(withSlash, window.location.href);
  return new URL('dicom/data/', appRootUrl);
}

function basenameFromPath(p: string): string {
  const t = p.replace(/^\/+/, '');
  const parts = t.split(/[/\\]/);
  return parts[parts.length - 1] ?? t;
}

async function resolveGlbBasename(): Promise<string> {
  const raw = new URLSearchParams(window.location.search).get('glb')?.trim();
  if (raw) return basenameFromPath(raw);

  const dir = getDicomDataDirUrl();
  const res = await fetch(new URL('manifest.json', dir));
  if (!res.ok) throw new Error(`manifest.json ${res.status}`);
  const json = await res.json();
  const files: string[] = json.files ?? json;
  if (!Array.isArray(files)) throw new Error('manifest has no files array');
  const glbs = files
    .filter((f) => basenameFromPath(f).toLowerCase().endsWith('.glb'))
    .map(basenameFromPath);
  if (glbs.includes('model.glb')) return 'model.glb';
  if (glbs.includes('web-preview.glb')) return 'web-preview.glb';
  if (glbs.length > 0) return [...glbs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]!;
  return 'web-preview.glb';
}

function showError(message: string): void {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
}

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const dist = maxDim * 2.2;
  camera.near = Math.max(0.001, dist / 500);
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  camera.position.set(center.x + dist * 0.45, center.y + dist * 0.35, center.z + dist * 0.45);
  controls.target.copy(center);
  controls.update();
}

async function main(): Promise<void> {
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap) throw new Error('#canvas-wrap missing');

  const basename = await resolveGlbBasename();
  const url = new URL(basename, getDicomDataDirUrl()).href;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 5000);
  camera.position.set(2, 1.5, 2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Math.max(renderer.toneMappingExposure, 1) * 1.12;
  renderer.setClearColor(0x0a0e14, 1);
  wrap.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;

  scene.add(new THREE.AmbientLight(0xffffff, 2.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(0.6, 2.2, 1.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xf2f6ff, 0.55);
  fill.position.set(-0.8, 1.2, 1.6);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.45);
  rim.position.set(0, 1.5, -2.2);
  scene.add(rim);

  const grid = new THREE.GridHelper(4, 20, 0x2a323d, 0x1a2028);
  grid.position.y = -0.001;
  scene.add(grid);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  brightenGltfMaterials(root);

  root.updateMatrixWorld(true);
  const preBox = new THREE.Box3().setFromObject(root, true);
  const preSize = preBox.getSize(new THREE.Vector3());
  const preCenter = preBox.getCenter(new THREE.Vector3());
  root.position.sub(preCenter);
  const maxDim = Math.max(preSize.x, preSize.y, preSize.z, 1e-6);
  root.scale.setScalar(GLB_PREVIEW_MAX_AXIS_M / maxDim);
  root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const centeredBounds = new THREE.Box3().setFromObject(root, true);
  const centeredCenter = centeredBounds.getCenter(new THREE.Vector3());
  root.position.sub(centeredCenter);

  const orient = new THREE.Group();
  orient.rotation.set(
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.x),
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.y),
    THREE.MathUtils.degToRad(GLB_PREVIEW_WORLD_YXZ_DEG.z),
    'YXZ',
  );
  orient.add(root);
  scene.add(orient);

  fitCameraToObject(camera, controls, orient);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  showError(e instanceof Error ? e.message : String(e));
});
