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

function staticDataPlugin(): Plugin {
  const dataDir = path.join(process.cwd(), 'dicom', 'data');
  const mountPath = '/dicom/data';
  if (!fs.existsSync(dataDir)) {
    console.warn('[vite] dicom/data not found; /dicom/data requests will 404');
  }

  const attachMiddleware = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(mountPath, (req, res, next) => {
      let rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (rel.startsWith(mountPath)) rel = rel.slice(mountPath.length);
      rel = rel.replace(/^\//, '');
      const filePath = path.join(dataDir, rel);
      if (!filePath.startsWith(dataDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { next(); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.json' ? 'application/json' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
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

function debugLogPlugin(): Plugin {
  return {
    name: 'debug-log',
    configureServer(server: ViteDevServer) {
      const logFile = path.join(process.cwd(), 'client-logs.jsonl');
      server.middlewares.use('/api/log', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            console.log(`[CLIENT ${data.level}] ${data.message}`);
            if (data.data) console.log('[CLIENT DATA]', data.data);
            fs.appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n');
          } catch (e) {
            console.error('[LOG ERROR]', e);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
    },
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
      debugLogPlugin(),
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
