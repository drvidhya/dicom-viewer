import { defineConfig } from 'vite';
import { createDicomViewerViteConfig } from './vite.shared';

/** HTTPS dev server on port 3001 (basic-ssl). Default `npm run dev` starts this alongside HTTP. */
export default defineConfig(createDicomViewerViteConfig({ https: true, port: 3001 }));
