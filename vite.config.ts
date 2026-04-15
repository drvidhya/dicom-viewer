import { defineConfig, type Plugin, ViteDevServer } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';

/**
 * Default dev server is HTTP so `http://localhost:3000` works as a secure context
 * and service workers can register (self-signed HTTPS makes the browser reject the SW script).
 * Use HTTPS when needed (e.g. some device testing): VITE_DEV_HTTPS=1 npm run dev
 */
const useDevHttps =
  process.env.VITE_DEV_HTTPS === '1' || process.env.VITE_DEV_HTTPS === 'true';

/** When you open the dev app from another device (http://THIS_IP:3000), set this to that same IP or hostname so HMR websockets connect correctly. */
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
  const dataDir = path.join(process.cwd(), 'data');
  return {
    name: 'static-data',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/data', (req, res, next) => {
        const filePath = path.join(dataDir, decodeURIComponent(req.url ?? ''));
        if (!filePath.startsWith(dataDir)) { res.writeHead(403); res.end(); return; }
        fs.readFile(filePath, (err, data) => {
          if (err) { next(); return; }
          const ext = path.extname(filePath).toLowerCase();
          const mime = ext === '.json' ? 'application/json' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime });
          res.end(data);
        });
      });
    },
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

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  plugins: [
    ...(useDevHttps ? [basicSsl()] : []),
    cornerstoneCodecPlugin(),
    staticDataPlugin(),
    debugLogPlugin(),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    ...(useDevHttps ? { https: {} } : {}),
    ...(devHmrHost
      ? {
          hmr: {
            host: devHmrHost,
            port: 3000,
            protocol: useDevHttps ? 'wss' : 'ws',
            clientPort: 3000,
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
});
