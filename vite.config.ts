import { defineConfig, type Plugin, ViteDevServer } from 'vite';
import fs from 'fs';
import path from 'path';

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
      return null;
    },
    load(id) {
      if (id === '\0virtual:codec-stub') return stub;
      if (id === '\0virtual:zlib-stub') return 'export default {};';
      return null;
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
    cornerstoneCodecPlugin(),
    debugLogPlugin(),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
    esbuildOptions: { target: 'esnext' },
  },
});
