import { defineConfig } from 'vite';
import { createDicomViewerViteConfig } from './vite.shared';

/** HTTP dev server (port 3000). Used by `npm run dev` together with vite.config.https.ts, or alone via `npm run dev:http`. */
export default defineConfig(createDicomViewerViteConfig({ https: false, port: 3000 }));
