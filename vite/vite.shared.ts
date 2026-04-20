/**
 * Shared Vite configuration for the DICOM viewer.
 *
 * Dev servers:
 *   • HTTP  — vite/vite.config.ts → port 3000 (service workers register; default)
 *   • HTTPS — vite/vite.config.https.ts → port 3001 (self-signed; SW may fail until cert is trusted)
 *
 * They are different origins; Cache Storage / SW are not shared between ports.
 * Default `npm run dev` runs both; use `npm run dev:http` or `npm run dev:https` for one only.
 *
 * LAN HMR: set VITE_DEV_HMR_HOST to the machine IP/hostname for each origin you use.
 *
 * Static assets (copied verbatim to dist root): `static/` — e.g. service-worker.js for HTTPS deploys.
 * GLB gallery: dev + preview serve the repo folder `glb/` at URL path `/glb` (e.g. https://localhost:3001/glb/).
 * DICOM: dev + preview serve the repo folder `dicom/data` at URL path `/dicom/data` (dev server root).
 * The app resolves `dicom/data/` relative to each HTML document. Builds do not copy DICOM — deploy a
 * `dicom/data` directory beside your built `index.html` / `xr.html` on disk.
 *
 * dist/ is build output only (`npm run build` on main); edit `src/` and `static/`, not generated bundles.
 */
import { type UserConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';

export type DicomViewerDevOptions = {
  https: boolean;
  port: number;
};

const devHmrHost = process.env.VITE_DEV_HMR_HOST;

function cornerstoneCodecPlugin(): Plugin {
  const stub = `
    export default function() { return Promise.resolve({}); }
    export const decode = () => null;
    export const initialize = () => Promise.resolve();
  `;
  return {
    name: 'cornerstone-codec-stub',
    enforce: 'pre',
    resolveId(id) {
      if (id.includes('@cornerstonejs/codec-')) return '\0virtual:codec-stub';
      if (id === 'zlib') return '\0virtual:zlib-stub';
      if (id === '@icr/polyseg-wasm') return '\0virtual:polyseg-stub';
      return null;
    },
    load(id) {
      if (id === '\0virtual:codec-stub') return stub;
      if (id === '\0virtual:zlib-stub') return 'export default {};';
      if (id === '\0virtual:polyseg-stub') return 'export default {};';
      return null;
    },
  };
}

function mimeForDicomDataPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.glb') return 'model/gltf-binary';
  return 'application/octet-stream';
}

function staticDataPlugin(): Plugin {
  const dataDir = path.join(process.cwd(), 'dicom', 'data');
  const mountPath = '/dicom/data';

  const attachMiddleware = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(mountPath, (req, res, next) => {
      let rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (rel.startsWith(mountPath)) rel = rel.slice(mountPath.length);
      rel = rel.replace(/^\//, '');
      const filePath = path.join(dataDir, rel);
      if (!filePath.startsWith(dataDir)) { res.writeHead(403); res.end(); return; }
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        fs.stat(filePath, (err, st) => {
          if (err) { next(); return; }
          res.writeHead(200, {
            'Content-Type': mimeForDicomDataPath(filePath),
            'Content-Length': String(st.size),
          });
          res.end();
        });
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { next(); return; }
        res.writeHead(200, { 'Content-Type': mimeForDicomDataPath(filePath) });
        res.end(data);
      });
    });
  };
  return {
    name: 'static-data',
    configureServer: attachMiddleware,
    configurePreviewServer: attachMiddleware,
  };
}

function mimeForGlbPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.glb':
      return 'model/gltf-binary';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/** Serve `glb/` at `/glb` for WebXR gallery (HTTPS dev on port 3001). */
function staticGlbPlugin(): Plugin {
  const glbDir = path.resolve(process.cwd(), 'glb');
  const mountPath = '/glb';

  const attachMiddleware = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(mountPath, (req, res, next) => {
      let rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (rel.startsWith(mountPath)) rel = rel.slice(mountPath.length);
      rel = rel.replace(/^\//, '');
      if (rel === '' || rel.endsWith('/')) {
        rel = rel.replace(/\/$/, '');
        rel = rel ? `${rel}/index.html` : 'index.html';
      }
      const filePath = path.join(glbDir, rel);
      const normalizedDir = path.resolve(glbDir);
      const normalizedFile = path.resolve(filePath);
      if (!normalizedFile.startsWith(normalizedDir + path.sep) && normalizedFile !== normalizedDir) {
        res.writeHead(403);
        res.end();
        return;
      }
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        fs.stat(normalizedFile, (err, st) => {
          if (err) {
            next();
            return;
          }
          res.writeHead(200, {
            'Content-Type': mimeForGlbPath(normalizedFile),
            'Content-Length': String(st.size),
          });
          res.end();
        });
        return;
      }
      fs.readFile(normalizedFile, (err, data) => {
        if (err) {
          next();
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeForGlbPath(normalizedFile) });
        res.end(data);
      });
    });
  };
  return {
    name: 'static-glb',
    configureServer: attachMiddleware,
    configurePreviewServer: attachMiddleware,
  };
}

export function createDicomViewerViteConfig(dev: DicomViewerDevOptions): UserConfig {
  const polySegStub = path.resolve(process.cwd(), 'src/shims/polyseg-wasm-stub.ts');
  return {
    root: '.',
    publicDir: 'static',
    base: './',
    resolve: {
      alias: {
        // Dynamic import inside @cornerstonejs/tools worker; Rollup does not use dev resolveId there.
        '@icr/polyseg-wasm': polySegStub,
      },
    },
    plugins: [
      ...(dev.https ? [basicSsl()] : []),
      cornerstoneCodecPlugin(),
      staticDataPlugin(),
      staticGlbPlugin(),
    ],
    server: {
      host: '0.0.0.0',
      port: dev.port,
      ...(dev.https ? { https: {} } : {}),
      ...(devHmrHost
        ? {
            hmr: {
              host: devHmrHost,
              port: dev.port,
              protocol: dev.https ? 'wss' : 'ws',
              clientPort: dev.port,
            },
          }
        : {}),
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'esnext',
      rollupOptions: {
        input: {
          main: path.resolve(process.cwd(), 'index.html'),
          xr:   path.resolve(process.cwd(), 'xr.html'),
        },
      },
    },
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: ['dicom-parser'],
      esbuildOptions: { target: 'esnext' },
    },
  };
}
