#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import dicomParser from 'dicom-parser';
import { vec3 } from 'gl-matrix';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray.js';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray.js';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points.js';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData.js';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData.js';
import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals.js';
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes.js';
import vtkWindowedSincPolyDataFilter from '@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter.js';

const DEFAULTS = {
  hu: null, // auto-detect from VOI (voiLutModule lower bound, same logic Cornerstone uses for rendering)
  smooth: 20,
  simplify: 0.3,
  maxTris: 150_000,
};

const metaDataProviders = [];
const dataSetCache = new Map();

const metaData = {
  addProvider(provider, priority = 0) {
    metaDataProviders.push({ provider, priority });
    metaDataProviders.sort((a, b) => b.priority - a.priority);
  },
  get(type, imageId) {
    for (let i = 0; i < metaDataProviders.length; i += 1) {
      const result = metaDataProviders[i].provider(type, imageId);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  },
};

function parseNumberList(value) {
  if (!value || typeof value !== 'string') {
    return undefined;
  }
  const numbers = value
    .split('\\')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
  return numbers.length > 0 ? numbers : undefined;
}

function toNumberOrUndefined(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function getImagePlaneModule(dataSet) {
  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  const imageOrientationPatient = parseNumberList(dataSet.string('x00200037'));
  const imagePositionPatient = parseNumberList(dataSet.string('x00200032'));
  const pixelSpacing = parseNumberList(dataSet.string('x00280030')) || [1, 1];

  if (
    !rows ||
    !columns ||
    !imageOrientationPatient ||
    imageOrientationPatient.length < 6 ||
    !imagePositionPatient ||
    imagePositionPatient.length < 3
  ) {
    return undefined;
  }

  return {
    rows,
    columns,
    imageOrientationPatient: imageOrientationPatient.slice(0, 6),
    imagePositionPatient: imagePositionPatient.slice(0, 3),
    rowPixelSpacing: toNumberOrUndefined(pixelSpacing[0]) ?? 1,
    columnPixelSpacing: toNumberOrUndefined(pixelSpacing[1]) ?? 1,
    spacingBetweenSlices: toNumberOrUndefined(dataSet.string('x00180088')),
    sliceThickness: toNumberOrUndefined(dataSet.string('x00180050')),
  };
}

function getModalityLutModule(dataSet) {
  return {
    rescaleSlope: toNumberOrUndefined(dataSet.string('x00281053')) ?? 1,
    rescaleIntercept: toNumberOrUndefined(dataSet.string('x00281052')) ?? 0,
  };
}

function getVoiLutModule(dataSet) {
  // Tags x00281050 = WindowCenter, x00281051 = WindowWidth
  // Values may be multi-valued (backslash-separated); take the first.
  const wcRaw = dataSet.string('x00281050');
  const wwRaw = dataSet.string('x00281051');
  const wc = toNumberOrUndefined(wcRaw?.split('\\')[0]);
  const ww = toNumberOrUndefined(wwRaw?.split('\\')[0]);
  if (wc === undefined || ww === undefined) {
    return undefined;
  }
  return { windowCenter: wc, windowWidth: ww };
}

const wadouri = {
  metaData: {
    metaDataProvider(type, imageId) {
      const dataSet = dataSetCache.get(imageId);
      if (!dataSet) {
        return undefined;
      }

      if (type === 'imagePlaneModule') {
        return getImagePlaneModule(dataSet);
      }

      if (type === 'modalityLutModule') {
        return getModalityLutModule(dataSet);
      }

      if (type === 'voiLutModule') {
        return getVoiLutModule(dataSet);
      }

      return undefined;
    },
  },
  dataSetCacheManager: {
    async load(uri, loadRequest, imageId) {
      const arrayBuffer = await loadRequest(uri, imageId);
      const byteArray = new Uint8Array(arrayBuffer);
      const dataSet = dicomParser.parseDicom(byteArray);
      dataSetCache.set(uri, dataSet);
      return dataSet;
    },
    get(uri) {
      return dataSetCache.get(uri);
    },
  },
};

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[${new Date().toISOString()}] WARN: ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function parseCli(argv) {
  const args = [...argv];
  const positional = [];
  const options = { ...DEFAULTS };

  while (args.length > 0) {
    const token = args.shift();

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const value = args.shift();
    if (value === undefined) {
      fail(`Missing value for option ${token}`);
    }

    if (token === '--hu') {
      options.hu = Number(value);
      if (!Number.isFinite(options.hu)) {
        fail('--hu must be a finite number');
      }
    } else if (token === '--smooth') {
      options.smooth = Number(value);
    } else if (token === '--simplify') {
      options.simplify = Number(value);
    } else if (token === '--max-tris') {
      options.maxTris = Number(value);
    } else {
      fail(`Unknown option: ${token}`);
    }
  }

  const [inputFolder, outputPathRaw] = positional;
  if (!inputFolder) {
    fail(
      'Usage: node scripts/dicom-to-gltf.mjs <dicom-folder> [output.glb] --hu <value> --smooth <n> --simplify <ratio> --max-tris <n>\n' +
        '  (default output: glb/<input-folder-name>.glb; --max-tris caps triangles for web-friendly GLB)',
    );
  }

  if (!Number.isInteger(options.smooth) || options.smooth < 0) {
    fail('--smooth must be a non-negative integer');
  }

  if (!Number.isFinite(options.simplify) || options.simplify <= 0 || options.simplify > 1) {
    fail('--simplify must be in (0.0, 1.0]');
  }

  if (!Number.isInteger(options.maxTris) || options.maxTris < 1000) {
    fail('--max-tris must be an integer >= 1000');
  }

  const inputPath = path.resolve(inputFolder);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
    fail(`Input folder does not exist or is not a directory: ${inputPath}`);
  }

  const glbDir = path.resolve(process.cwd(), 'glb');
  const outputPath = outputPathRaw
    ? path.resolve(outputPathRaw)
    : path.join(glbDir, `${path.basename(inputPath)}.glb`);

  return {
    inputPath,
    outputPath,
    huValueOverride: options.hu, // null = auto-detect from VOI after loading
    smoothIter: options.smooth,
    simplifyRatio: options.simplify,
    maxTris: options.maxTris,
  };
}

/**
 * Auto-detect HU isovalue from the VOI stored in DICOM — same logic Cornerstone uses for rendering.
 * windowCenter - windowWidth/2 = the lower display boundary, which is the surface of the
 * clinically relevant tissue. For abdomen CT this is ~-160 HU (skin surface). For bone CT ~-350 HU.
 * Falls back to -100 HU (skin/soft-tissue boundary) if no VOI is stored.
 */
function autoDetectHuFromVoi(imageIds) {
  for (const imageId of imageIds) {
    const voi = metaData.get('voiLutModule', imageId);
    if (!voi) continue;
    const wc = voi.windowCenter;
    const ww = voi.windowWidth;
    if (Number.isFinite(wc) && Number.isFinite(ww) && ww > 0) {
      const lower = wc - ww / 2;
      log(`Auto HU from VOI: windowCenter=${wc}, windowWidth=${ww} → lower bound=${lower} HU`);
      return lower;
    }
  }
  log('No VOI metadata found; using fallback HU=-100 (skin/soft-tissue surface)');
  return -100;
}

function listFilesRecursive(rootDir) {
  const allFiles = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(resolved);
      } else if (entry.isFile()) {
        allFiles.push(resolved);
      }
    }
  }

  return allFiles;
}

function parseFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function isUncompressedTransferSyntax(uid) {
  return (
    uid === '1.2.840.10008.1.2' || // Implicit VR Little Endian
    uid === '1.2.840.10008.1.2.1' || // Explicit VR Little Endian
    uid === '1.2.840.10008.1.2.2'
  ); // Explicit VR Big Endian
}

function summarizeSeries(imageIds) {
  const bySeries = new Map();
  for (const imageId of imageIds) {
    const dataSet = wadouri.dataSetCacheManager.get(imageId);
    const seriesUid = dataSet?.string('x0020000e') || '__missing_series_uid__';
    let bucket = bySeries.get(seriesUid);
    if (!bucket) {
      bucket = [];
      bySeries.set(seriesUid, bucket);
    }
    bucket.push(imageId);
  }

  const ordered = [...bySeries.entries()].sort((a, b) => b[1].length - a[1].length);
  return {
    seriesUid: ordered[0]?.[0],
    imageIds: ordered[0]?.[1] || [],
    totalSeries: ordered.length,
  };
}

function orientationCompatible(referenceIop, candidateIop) {
  if (!referenceIop || !candidateIop || referenceIop.length < 6 || candidateIop.length < 6) {
    return false;
  }
  const refRow = normalize3(referenceIop.slice(0, 3));
  const refCol = normalize3(referenceIop.slice(3, 6));
  const row = normalize3(candidateIop.slice(0, 3));
  const col = normalize3(candidateIop.slice(3, 6));
  return Math.abs(dot3(refRow, row)) > 0.995 && Math.abs(dot3(refCol, col)) > 0.995;
}

function sortImageIdsAndGetSpacing(imageIds, scanAxisNormal) {
  const firstPlane = metaData.get('imagePlaneModule', imageIds[0]);
  if (!firstPlane) {
    fail('Missing imagePlaneModule for first slice');
  }

  const referenceImagePositionPatient = firstPlane.imagePositionPatient;
  if (!scanAxisNormal) {
    const rowCosineVec = vec3.fromValues(...firstPlane.imageOrientationPatient.slice(0, 3));
    const colCosineVec = vec3.fromValues(...firstPlane.imageOrientationPatient.slice(3, 6));
    scanAxisNormal = vec3.create();
    vec3.cross(scanAxisNormal, rowCosineVec, colCosineVec);
  }

  const getDistance = (imageId) => {
    const plane = metaData.get('imagePlaneModule', imageId);
    if (!plane) {
      fail(`Missing imagePlaneModule during sorting for ${imageId}`);
    }
    const positionVector = vec3.create();
    vec3.sub(positionVector, referenceImagePositionPatient, plane.imagePositionPatient);
    return vec3.dot(positionVector, scanAxisNormal);
  };

  const distanceImagePairs = imageIds.map((imageId) => ({
    imageId,
    distance: getDistance(imageId),
  }));
  distanceImagePairs.sort((a, b) => b.distance - a.distance);

  const sortedImageIds = distanceImagePairs.map((entry) => entry.imageId);
  let zSpacing = 0;
  if (sortedImageIds.length > 1) {
    zSpacing =
      Math.abs(
        distanceImagePairs[distanceImagePairs.length - 1].distance - distanceImagePairs[0].distance,
      ) /
      (sortedImageIds.length - 1);
  }

  const originPlane = metaData.get('imagePlaneModule', sortedImageIds[0]);
  let { spacingBetweenSlices, sliceThickness } = originPlane;
  if (zSpacing === 0) {
    zSpacing = spacingBetweenSlices || sliceThickness || 1;
  }

  return {
    sortedImageIds,
    zSpacing,
    origin: originPlane.imagePositionPatient,
  };
}

function uriToPath(uri) {
  if (!uri.startsWith('file://')) {
    return uri;
  }

  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.replace('file://', ''));
  }
}

function nodeFileLoader(uri) {
  const filePath = uriToPath(uri);
  const fileBuffer = fs.readFileSync(filePath);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );
  return Promise.resolve(arrayBuffer);
}

function extractPixelArray(dataSet, expectedPixels) {
  const element = dataSet?.elements?.x7fe00010;
  if (!element) {
    throw new Error('Missing PixelData (x7fe00010)');
  }

  const bitsAllocated = dataSet.uint16('x00280100');
  const pixelRepresentation = dataSet.uint16('x00280103') || 0;
  const byteArray = dataSet.byteArray;
  const byteOffset = byteArray.byteOffset + element.dataOffset;

  if (bitsAllocated === 8) {
    return new Uint8Array(byteArray.buffer, byteOffset, expectedPixels);
  }

  if (bitsAllocated === 16) {
    if (pixelRepresentation === 1) {
      return new Int16Array(byteArray.buffer, byteOffset, expectedPixels);
    }
    return new Uint16Array(byteArray.buffer, byteOffset, expectedPixels);
  }

  throw new Error(`Unsupported bitsAllocated=${bitsAllocated}. Only 8/16-bit supported.`);
}

function normalizeTriangleIndicesFromCells(cells) {
  const indices = [];
  for (let i = 0; i < cells.length; ) {
    const n = cells[i++];
    if (n < 3) {
      i += n;
      continue;
    }

    const first = cells[i];
    for (let j = 1; j < n - 1; j += 1) {
      indices.push(first, cells[i + j], cells[i + j + 1]);
    }
    i += n;
  }
  return new Uint32Array(indices);
}

function computeTriangleCountFromCells(cells) {
  let triangles = 0;
  for (let i = 0; i < cells.length; ) {
    const n = cells[i++];
    if (n >= 3) {
      triangles += n - 2;
    }
    i += n;
  }
  return triangles;
}

function keepLargestConnectedComponent(positions, indices) {
  const numVerts = Math.floor(positions.length / 3);
  const numTris = Math.floor(indices.length / 3);

  if (numTris === 0) {
    return { positions, indices };
  }

  // Marching cubes can emit duplicated vertices per triangle. Build connectivity
  // on quantized vertex positions so triangles still connect spatially.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
  const invEps = 1 / (span * 1e-5);
  const canonicalByKey = new Map();
  const canonicalForVertex = new Uint32Array(numVerts);
  let canonicalCount = 0;
  for (let vi = 0; vi < numVerts; vi += 1) {
    const p = vi * 3;
    const key = `${Math.round(positions[p] * invEps)}|${Math.round(positions[p + 1] * invEps)}|${Math.round(positions[p + 2] * invEps)}`;
    let canonical = canonicalByKey.get(key);
    if (canonical === undefined) {
      canonical = canonicalCount++;
      canonicalByKey.set(key, canonical);
    }
    canonicalForVertex[vi] = canonical;
  }

  const vertexToTris = Array.from({ length: canonicalCount }, () => []);
  for (let t = 0; t < numTris; t += 1) {
    const base = t * 3;
    vertexToTris[canonicalForVertex[indices[base]]].push(t);
    vertexToTris[canonicalForVertex[indices[base + 1]]].push(t);
    vertexToTris[canonicalForVertex[indices[base + 2]]].push(t);
  }

  const visited = new Uint8Array(numTris);
  let largest = [];

  for (let start = 0; start < numTris; start += 1) {
    if (visited[start]) {
      continue;
    }

    const stack = [start];
    visited[start] = 1;
    const component = [];

    while (stack.length > 0) {
      const tri = stack.pop();
      component.push(tri);

      const triBase = tri * 3;
      const a = canonicalForVertex[indices[triBase]];
      const b = canonicalForVertex[indices[triBase + 1]];
      const c = canonicalForVertex[indices[triBase + 2]];

      const neighbors = [a, b, c];
      for (const v of neighbors) {
        const adjacent = vertexToTris[v];
        for (let i = 0; i < adjacent.length; i += 1) {
          const nextTri = adjacent[i];
          if (!visited[nextTri]) {
            visited[nextTri] = 1;
            stack.push(nextTri);
          }
        }
      }
    }

    if (component.length > largest.length) {
      largest = component;
    }
  }

  const oldToNew = new Int32Array(numVerts);
  oldToNew.fill(-1);
  const outPositions = [];
  const outIndices = [];

  for (let i = 0; i < largest.length; i += 1) {
    const tri = largest[i];
    const base = tri * 3;
    for (let k = 0; k < 3; k += 1) {
      const oldIndex = indices[base + k];
      let newIndex = oldToNew[oldIndex];
      if (newIndex === -1) {
        newIndex = outPositions.length / 3;
        oldToNew[oldIndex] = newIndex;
        const p = oldIndex * 3;
        outPositions.push(positions[p], positions[p + 1], positions[p + 2]);
      }
      outIndices.push(newIndex);
    }
  }

  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices),
  };
}

/** Uniform grid vertex clustering. Larger `gridCells` = finer bins = more detail = more triangles. */
function vertexClusteringWithGridCells(positions, indices, gridCells) {
  const numTris = Math.floor(indices.length / 3);
  const G = Math.max(1, Math.floor(gridCells));
  if (numTris === 0) {
    return { positions, indices };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const spanX = Math.max(maxX - minX, Number.EPSILON);
  const spanY = Math.max(maxY - minY, Number.EPSILON);
  const spanZ = Math.max(maxZ - minZ, Number.EPSILON);

  const representativeByCell = new Map();
  const mappedVertex = new Uint32Array(positions.length / 3);

  for (let vi = 0; vi < mappedVertex.length; vi += 1) {
    const p = vi * 3;
    const nx = (positions[p] - minX) / spanX;
    const ny = (positions[p + 1] - minY) / spanY;
    const nz = (positions[p + 2] - minZ) / spanZ;
    const ix = Math.min(G - 1, Math.floor(nx * G));
    const iy = Math.min(G - 1, Math.floor(ny * G));
    const iz = Math.min(G - 1, Math.floor(nz * G));
    const key = `${ix}|${iy}|${iz}`;

    let representative = representativeByCell.get(key);
    if (representative === undefined) {
      representative = vi;
      representativeByCell.set(key, representative);
    }
    mappedVertex[vi] = representative;
  }

  const repToNew = new Map();
  const outPositions = [];
  const outIndices = [];

  for (let tri = 0; tri < numTris; tri += 1) {
    const base = tri * 3;
    const a = mappedVertex[indices[base]];
    const b = mappedVertex[indices[base + 1]];
    const c = mappedVertex[indices[base + 2]];

    if (a === b || b === c || a === c) {
      continue;
    }

    for (let i = 0; i < 3; i += 1) {
      const rep = [a, b, c][i];
      let next = repToNew.get(rep);
      if (next === undefined) {
        next = outPositions.length / 3;
        repToNew.set(rep, next);
        const p = rep * 3;
        outPositions.push(positions[p], positions[p + 1], positions[p + 2]);
      }
      outIndices.push(next);
    }
  }

  if (outIndices.length === 0) {
    return { positions, indices };
  }

  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices),
  };
}

function countTriangles(mesh) {
  return Math.floor(mesh.indices.length / 3);
}

/**
 * Reduce to <= targetTris. Larger gridCells => more triangles (monotone for practical meshes).
 * For meshes under ~3M triangles, binary search on grid resolution hits the budget accurately.
 */
function decimateToTriangleBudget(positions, indices, targetTris) {
  const numTris = Math.floor(indices.length / 3);
  if (numTris <= targetTris) {
    return { positions, indices };
  }

  if (numTris > 3_000_000) {
    let G = Math.min(768, Math.max(4, Math.ceil(Math.cbrt(numTris / Math.max(targetTris, 1)) * 3)));
    let mesh = vertexClusteringWithGridCells(positions, indices, G);
    let t = countTriangles(mesh);
    for (let guard = 0; guard < 22 && t > targetTris && G > 1; guard += 1) {
      G = Math.max(1, Math.floor(G * Math.pow(targetTris / Math.max(t, 1), 0.4)));
      mesh = vertexClusteringWithGridCells(positions, indices, G);
      t = countTriangles(mesh);
    }
    return mesh;
  }

  let lo = 1;
  let hi = 1024;
  let best = vertexClusteringWithGridCells(positions, indices, 1);
  let bestTris = countTriangles(best);

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mesh = vertexClusteringWithGridCells(positions, indices, mid);
    const t = countTriangles(mesh);
    if (t === 0) {
      hi = mid - 1;
      continue;
    }
    if (t <= targetTris) {
      best = mesh;
      bestTris = t;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestTris === 0) {
    return vertexClusteringWithGridCells(positions, indices, 1);
  }

  return best;
}

function buildPolyDataFromMesh(positions, indices) {
  const polyData = vtkPolyData.newInstance();
  polyData.setPoints(
    vtkPoints.newInstance({
      numberOfComponents: 3,
      values: positions,
    }),
  );

  const cells = new Uint32Array((indices.length / 3) * 4);
  for (let i = 0, c = 0; i < indices.length; i += 3) {
    cells[c++] = 3;
    cells[c++] = indices[i];
    cells[c++] = indices[i + 1];
    cells[c++] = indices[i + 2];
  }
  polyData.setPolys(vtkCellArray.newInstance({ values: cells }));
  return polyData;
}

function computeMinMaxVec3(positions) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }

  return { min, max };
}

function padBuffer(buffer, paddingByte) {
  const paddedLength = Math.ceil(buffer.length / 4) * 4;
  if (paddedLength === buffer.length) {
    return buffer;
  }

  const out = Buffer.alloc(paddedLength, paddingByte);
  buffer.copy(out, 0, 0, buffer.length);
  return out;
}

function downsampleVolumeNearest(src, dims, factor) {
  const [srcCols, srcRows, srcSlices] = dims;
  const dstCols = Math.max(2, Math.floor(srcCols / factor));
  const dstRows = Math.max(2, Math.floor(srcRows / factor));
  const dstSlices = Math.max(2, Math.floor(srcSlices / factor));
  const dst = new Float32Array(dstCols * dstRows * dstSlices);

  for (let z = 0; z < dstSlices; z += 1) {
    const srcZ = Math.min(srcSlices - 1, Math.floor(z * factor));
    for (let y = 0; y < dstRows; y += 1) {
      const srcY = Math.min(srcRows - 1, Math.floor(y * factor));
      for (let x = 0; x < dstCols; x += 1) {
        const srcX = Math.min(srcCols - 1, Math.floor(x * factor));
        const srcIdx = srcZ * srcRows * srcCols + srcY * srcCols + srcX;
        const dstIdx = z * dstRows * dstCols + y * dstCols + x;
        dst[dstIdx] = src[srcIdx];
      }
    }
  }

  return {
    values: dst,
    dims: [dstCols, dstRows, dstSlices],
  };
}

function createGlb(positions, normals, indices) {
  if (positions.length !== normals.length) {
    fail('Normals array length does not match positions array length');
  }

  const useUint16 = positions.length / 3 <= 65535;
  const indexArray = useUint16 ? Uint16Array.from(indices) : Uint32Array.from(indices);
  const indexComponentType = useUint16 ? 5123 : 5125;

  const positionBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const normalBytes = Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength);
  const indexBytes = Buffer.from(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength);

  const binChunks = [];
  let currentOffset = 0;
  const pushChunk = (buffer) => {
    const padded = padBuffer(buffer, 0x00);
    const start = currentOffset;
    binChunks.push(padded);
    currentOffset += padded.length;
    return { byteOffset: start, byteLength: buffer.length };
  };

  const positionView = pushChunk(positionBytes);
  const normalView = pushChunk(normalBytes);
  const indexView = pushChunk(indexBytes);
  const totalBinByteLength = currentOffset;

  const { min, max } = computeMinMaxVec3(positions);
  const vertexCount = positions.length / 3;
  const indexCount = indices.length;

  const gltf = {
    asset: { version: '2.0', generator: 'dicom-to-gltf.mjs' },
    buffers: [{ byteLength: totalBinByteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionView.byteOffset, byteLength: positionView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: normalView.byteOffset, byteLength: normalView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexView.byteOffset, byteLength: indexView.byteLength, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3',
        min,
        max,
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: indexComponentType,
        count: indexCount,
        type: 'SCALAR',
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            mode: 4,
          },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadded = padBuffer(jsonBytes, 0x20);
  const binPadded = Buffer.concat(binChunks);

  const totalLength =
    12 + // GLB header
    8 +
    jsonPadded.length +
    8 +
    binPadded.length;

  const glb = Buffer.alloc(totalLength);
  let offset = 0;

  glb.writeUInt32LE(0x46546c67, offset); // glTF magic
  offset += 4;
  glb.writeUInt32LE(2, offset); // version
  offset += 4;
  glb.writeUInt32LE(totalLength, offset);
  offset += 4;

  glb.writeUInt32LE(jsonPadded.length, offset);
  offset += 4;
  glb.writeUInt32LE(0x4e4f534a, offset); // JSON chunk
  offset += 4;
  jsonPadded.copy(glb, offset);
  offset += jsonPadded.length;

  glb.writeUInt32LE(binPadded.length, offset);
  offset += 4;
  glb.writeUInt32LE(0x004e4942, offset); // BIN chunk
  offset += 4;
  binPadded.copy(glb, offset);

  return glb;
}

function validateGlb(glbBuffer) {
  if (!Buffer.isBuffer(glbBuffer)) {
    fail('GLB validation failed: input is not a Buffer');
  }
  if (glbBuffer.length < 20) {
    fail('GLB validation failed: file too small');
  }

  const magic = glbBuffer.readUInt32LE(0);
  const version = glbBuffer.readUInt32LE(4);
  const declaredLength = glbBuffer.readUInt32LE(8);

  if (magic !== 0x46546c67) {
    fail('GLB validation failed: invalid magic number');
  }
  if (version !== 2) {
    fail(`GLB validation failed: unsupported version ${version}`);
  }
  if (declaredLength !== glbBuffer.length) {
    fail('GLB validation failed: declared length mismatch');
  }

  let offset = 12;
  let json = null;
  let binChunkLength = -1;
  while (offset + 8 <= glbBuffer.length) {
    const chunkLength = glbBuffer.readUInt32LE(offset);
    const chunkType = glbBuffer.readUInt32LE(offset + 4);
    offset += 8;

    if (offset + chunkLength > glbBuffer.length) {
      fail('GLB validation failed: chunk exceeds file size');
    }

    const chunkData = glbBuffer.subarray(offset, offset + chunkLength);
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(chunkData.toString('utf8').trimEnd());
    } else if (chunkType === 0x004e4942) {
      binChunkLength = chunkLength;
    }
    offset += chunkLength;
  }

  if (!json) {
    fail('GLB validation failed: missing JSON chunk');
  }
  if (binChunkLength < 0) {
    fail('GLB validation failed: missing BIN chunk');
  }
  if (!json.buffers?.[0] || json.buffers[0].byteLength > binChunkLength) {
    fail('GLB validation failed: JSON buffer metadata inconsistent with BIN chunk');
  }
  if (!json.meshes?.length || !json.accessors?.length) {
    fail('GLB validation failed: missing mesh/accessor data');
  }
}

function toMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function main() {
  const { inputPath, outputPath, huValueOverride, smoothIter, simplifyRatio, maxTris } = parseCli(
    process.argv.slice(2),
  );

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  metaData.addProvider(wadouri.metaData.metaDataProvider);

  const allFiles = listFilesRecursive(inputPath);
  log(`DICOM files found: ${allFiles.length}`);
  if (allFiles.length === 0) {
    fail(`No files found in input folder: ${inputPath}`);
  }

  const loadedImageIds = [];
  for (const file of allFiles) {
    const imageId = pathToFileURL(path.resolve(file)).href;
    try {
      await wadouri.dataSetCacheManager.load(imageId, nodeFileLoader, imageId);
      loadedImageIds.push(imageId);
    } catch (error) {
      warn(`Skipping unreadable/non-DICOM file "${file}": ${error.message}`);
    }
  }

  log(`Slices loaded successfully: ${loadedImageIds.length}`);
  // Resolve HU: explicit override wins; otherwise auto-detect from VOI metadata
  const huValue = huValueOverride !== null ? huValueOverride : autoDetectHuFromVoi(loadedImageIds);
  log(`Using isovalue: ${huValue} HU${huValueOverride !== null ? ' (explicit)' : ' (auto from VOI)'}`);
  const withPlane = [];
  for (const imageId of loadedImageIds) {
    const dataSet = wadouri.dataSetCacheManager.get(imageId);
    const transferSyntaxUid = dataSet?.string('x00020010');
    if (!isUncompressedTransferSyntax(transferSyntaxUid)) {
      warn(
        `Skipping compressed/unsupported transfer syntax (${transferSyntaxUid || 'unknown'}) for ${imageId}`,
      );
      continue;
    }

    const plane = metaData.get('imagePlaneModule', imageId);
    if (!plane) {
      warn(`Skipping slice with missing imagePlaneModule: ${imageId}`);
      continue;
    }
    withPlane.push(imageId);
  }

  if (withPlane.length < 3) {
    fail(`Fewer than 3 slices remain after filtering metadata (${withPlane.length}).`);
  }

  const dominantSeries = summarizeSeries(withPlane);
  if (dominantSeries.imageIds.length < 3) {
    fail('Could not find a series with at least 3 compatible slices.');
  }
  log(
    `Selected dominant series: uid=${dominantSeries.seriesUid}, slices=${dominantSeries.imageIds.length}, totalSeries=${dominantSeries.totalSeries}`,
  );

  const firstSeriesPlane = metaData.get('imagePlaneModule', dominantSeries.imageIds[0]);
  const referenceIop = firstSeriesPlane?.imageOrientationPatient;
  const orientationFilteredIds = [];
  for (const imageId of dominantSeries.imageIds) {
    const plane = metaData.get('imagePlaneModule', imageId);
    if (!orientationCompatible(referenceIop, plane?.imageOrientationPatient)) {
      warn(`Skipping orientation-outlier slice: ${imageId}`);
      continue;
    }
    orientationFilteredIds.push(imageId);
  }

  if (orientationFilteredIds.length < 3) {
    fail(
      `Fewer than 3 slices remain after orientation filtering (${orientationFilteredIds.length}).`,
    );
  }

  const firstPlane = metaData.get('imagePlaneModule', orientationFilteredIds[0]);
  const rows = Number(firstPlane.rows);
  const cols = Number(firstPlane.columns);
  const rowSpacing = parseFiniteNumber(firstPlane.rowPixelSpacing, 1);
  const colSpacing = parseFiniteNumber(firstPlane.columnPixelSpacing, 1);

  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) {
    fail('Invalid Rows/Columns metadata on first slice');
  }

  const extractableIds = [];
  for (const imageId of orientationFilteredIds) {
    const plane = metaData.get('imagePlaneModule', imageId);
    const sliceRows = Number(plane?.rows);
    const sliceCols = Number(plane?.columns);
    if (sliceRows !== rows || sliceCols !== cols) {
      warn(`Skipping mismatched slice dimensions (${sliceRows}x${sliceCols}) for ${imageId}`);
      continue;
    }

    const thisRowSpacing = parseFiniteNumber(plane.rowPixelSpacing, rowSpacing);
    const thisColSpacing = parseFiniteNumber(plane.columnPixelSpacing, colSpacing);
    if (
      Math.abs(thisRowSpacing - rowSpacing) > Math.max(0.05 * rowSpacing, 1e-3) ||
      Math.abs(thisColSpacing - colSpacing) > Math.max(0.05 * colSpacing, 1e-3)
    ) {
      warn(
        `Skipping spacing-outlier slice ([${thisRowSpacing},${thisColSpacing}] vs [${rowSpacing},${colSpacing}]): ${imageId}`,
      );
      continue;
    }

    const dataSet = wadouri.dataSetCacheManager.get(imageId);
    if (!dataSet?.elements?.x7fe00010) {
      warn(`Skipping slice with missing pixel data: ${imageId}`);
      continue;
    }

    const bitsAllocated = dataSet.uint16('x00280100');
    if (bitsAllocated !== 8 && bitsAllocated !== 16) {
      warn(`Skipping slice with unsupported bitsAllocated=${bitsAllocated}: ${imageId}`);
      continue;
    }

    extractableIds.push(imageId);
  }

  if (extractableIds.length < 3) {
    fail(`Fewer than 3 slices remain after pixel-data filtering (${extractableIds.length}).`);
  }

  const iop = metaData.get('imagePlaneModule', extractableIds[0])?.imageOrientationPatient;
  if (!Array.isArray(iop) || iop.length < 6) {
    fail('Missing or invalid imageOrientationPatient on first valid slice');
  }

  const rowCos = vec3.fromValues(iop[0], iop[1], iop[2]);
  const colCos = vec3.fromValues(iop[3], iop[4], iop[5]);
  const scanAxisNormal = vec3.create();
  vec3.cross(scanAxisNormal, rowCos, colCos);

  const { sortedImageIds, zSpacing, origin } = sortImageIdsAndGetSpacing(extractableIds, scanAxisNormal);
  if (!Number.isFinite(zSpacing)) {
    fail(`Invalid z-spacing computed: ${zSpacing}`);
  }
  const dedupedImageIds = [];
  const seenSliceKeys = new Set();
  const dedupeEpsilon = Math.max(1e-3, zSpacing * 0.2);
  for (const imageId of sortedImageIds) {
    const plane = metaData.get('imagePlaneModule', imageId);
    const position = plane?.imagePositionPatient;
    if (!position) {
      continue;
    }
    const distanceKey = Math.round(
      (position[0] * scanAxisNormal[0] +
        position[1] * scanAxisNormal[1] +
        position[2] * scanAxisNormal[2]) /
        dedupeEpsilon,
    );
    if (seenSliceKeys.has(distanceKey)) {
      warn(`Skipping duplicate-position slice: ${imageId}`);
      continue;
    }
    seenSliceKeys.add(distanceKey);
    dedupedImageIds.push(imageId);
  }

  if (dedupedImageIds.length < 3) {
    fail(`Fewer than 3 slices remain after duplicate-position filtering (${dedupedImageIds.length}).`);
  }

  log(
    `After sorting: z-spacing=${zSpacing}, origin=[${origin.join(', ')}], sorted=${sortedImageIds.length}, deduped=${dedupedImageIds.length}`,
  );

  const numPixelsPerSlice = rows * cols;
  const huArray = new Float32Array(numPixelsPerSlice * dedupedImageIds.length);

  for (let sliceIndex = 0; sliceIndex < dedupedImageIds.length; sliceIndex += 1) {
    const imageId = dedupedImageIds[sliceIndex];
    const dataSet = wadouri.dataSetCacheManager.get(imageId);
    if (!dataSet) {
      fail(`Missing dataset in cache for imageId: ${imageId}`);
    }

    const pixels = extractPixelArray(dataSet, numPixelsPerSlice);
    const modalityLut = metaData.get('modalityLutModule', imageId) || {};
    const slope = parseFiniteNumber(modalityLut.rescaleSlope, 1);
    const intercept = parseFiniteNumber(modalityLut.rescaleIntercept, 0);

    const offset = sliceIndex * numPixelsPerSlice;
    for (let i = 0; i < numPixelsPerSlice; i += 1) {
      huArray[offset + i] = pixels[i] * slope + intercept;
    }
  }

  const baseDims = [cols, rows, dedupedImageIds.length];
  const marchingTriSoftCap = 650_000;

  let polyData = null;
  let selectedFactor = 1;
  const downsampleFactors = [1, 2, 3, 4, 5, 6, 8];
  for (const factor of downsampleFactors) {
    const volume =
      factor === 1
        ? { values: huArray, dims: baseDims }
        : downsampleVolumeNearest(huArray, baseDims, factor);

    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(volume.dims);
    imageData.setSpacing([colSpacing * factor, rowSpacing * factor, zSpacing * factor]);
    imageData.setOrigin(origin);
    imageData.getPointData().setScalars(
      vtkDataArray.newInstance({
        values: volume.values,
        numberOfComponents: 1,
        name: 'HU',
      }),
    );

    const mc = vtkImageMarchingCubes.newInstance({ contourValue: huValue, computeNormals: false });
    mc.setInputData(imageData);
    try {
      mc.update();
      polyData = mc.getOutputData();
      selectedFactor = factor;
      if (factor > 1) {
        warn(`Marching cubes fallback succeeded with downsample factor x${factor}`);
      }
      break;
    } catch (error) {
      if (!(error instanceof RangeError) || factor === downsampleFactors[downsampleFactors.length - 1]) {
        throw error;
      }
      warn(`Marching cubes failed at full factor x${factor}: ${error.message}. Retrying with coarser volume.`);
    }
  }

  let rawCells = polyData.getPolys()?.getData();
  if (!rawCells || rawCells.length === 0) {
    fail('Marching cubes produced no triangles. Try lowering --hu.');
  }
  let marchingTriangles = computeTriangleCountFromCells(rawCells);

  while (marchingTriangles > marchingTriSoftCap && selectedFactor < 12) {
    selectedFactor += 1;
    warn(
      `Mesh very large (${marchingTriangles} tris); re-marching at downsample x${selectedFactor} to stay under ~${marchingTriSoftCap} tris before smoothing`,
    );
    const volume = downsampleVolumeNearest(huArray, baseDims, selectedFactor);
    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(volume.dims);
    imageData.setSpacing([colSpacing * selectedFactor, rowSpacing * selectedFactor, zSpacing * selectedFactor]);
    imageData.setOrigin(origin);
    imageData.getPointData().setScalars(
      vtkDataArray.newInstance({
        values: volume.values,
        numberOfComponents: 1,
        name: 'HU',
      }),
    );
    const mc = vtkImageMarchingCubes.newInstance({ contourValue: huValue, computeNormals: false });
    mc.setInputData(imageData);
    mc.update();
    polyData = mc.getOutputData();
    rawCells = polyData.getPolys()?.getData();
    if (!rawCells || rawCells.length === 0) {
      fail('Marching cubes produced no triangles after downsample bump. Try lowering --hu.');
    }
    marchingTriangles = computeTriangleCountFromCells(rawCells);
  }

  log(`After marching cubes: triangle count=${marchingTriangles}, downsampleFactor=${selectedFactor}`);

  const smoothPasses =
    marchingTriangles > 1_200_000
      ? Math.min(smoothIter, 4)
      : marchingTriangles > 600_000
        ? Math.min(smoothIter, 8)
        : smoothIter;

  if (smoothPasses !== smoothIter) {
    warn(`Reducing smoothing iterations from ${smoothIter} to ${smoothPasses} for memory/performance`);
  }

  const smoother = vtkWindowedSincPolyDataFilter.newInstance({ numberOfIterations: smoothPasses });
  smoother.setInputData(polyData);
  smoother.update();
  polyData = smoother.getOutputData();
  log(`After smoothing: triangle count=${computeTriangleCountFromCells(polyData.getPolys().getData())}`);

  const smoothPositions = polyData.getPoints().getData();
  const smoothIndices = normalizeTriangleIndicesFromCells(polyData.getPolys().getData());
  const largestComponentMesh = keepLargestConnectedComponent(smoothPositions, smoothIndices);
  const afterConnectivity = largestComponentMesh.indices.length / 3;
  log(`After connectivity filter: triangle count=${afterConnectivity} (removed=${smoothIndices.length / 3 - afterConnectivity})`);

  if (largestComponentMesh.indices.length === 0) {
    fail('Connectivity filter removed all geometry.');
  }

  const afterConnTris = Math.floor(largestComponentMesh.indices.length / 3);
  const ratioCap = Math.floor(afterConnTris * simplifyRatio);
  const targetTris = Math.min(maxTris, Math.max(5000, ratioCap));
  log(
    `Decimation target: ${targetTris} triangles (max-tris=${maxTris}, simplify=${simplifyRatio}, post-connectivity=${afterConnTris})`,
  );
  const decimatedMesh = decimateToTriangleBudget(
    largestComponentMesh.positions,
    largestComponentMesh.indices,
    targetTris,
  );
  const afterDecimation = decimatedMesh.indices.length / 3;
  log(`After decimation: triangle count=${afterDecimation}`);

  if (decimatedMesh.indices.length === 0) {
    fail('Decimation produced empty geometry. Try a higher --simplify ratio.');
  }

  const finalMeshPolyData = buildPolyDataFromMesh(decimatedMesh.positions, decimatedMesh.indices);
  const normalsFilter = vtkPolyDataNormals.newInstance({
    computePointNormals: true,
    computeCellNormals: false,
    splitting: false,
    consistency: true,
    autoOrientNormals: true,
  });
  normalsFilter.setInputData(finalMeshPolyData);
  normalsFilter.update();
  polyData = normalsFilter.getOutputData();

  const finalPositions = polyData.getPoints()?.getData();
  const finalNormals = polyData.getPointData()?.getNormals()?.getData();
  const finalIndices = normalizeTriangleIndicesFromCells(polyData.getPolys().getData());

  if (!finalPositions || !finalNormals || finalIndices.length === 0) {
    fail('Final mesh is missing points, normals, or indices');
  }

  const glb = createGlb(finalPositions, finalNormals, finalIndices);
  validateGlb(glb);

  fs.writeFileSync(outputPath, glb);
  log(`Written: ${outputPath}, size=${toMb(glb.length)} MB`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
