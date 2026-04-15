# DICOM Viewer

Web-based CT/MR-style stack viewer built with [Cornerstone3D](https://www.cornerstonejs.org/): dashboard plus separate Axial / Sagittal / Coronal windows, optional **WebXR** mode (`xr.html`), and a small service worker cache for `/dicom/data/*` on HTTPS.

## Requirements

- **Node.js** 18+ (20+ recommended) and npm

## Quick start

```bash
npm install
```

Place DICOM files under **`dicom/data/`** (flat files or subfolders). Generate the manifest:

```bash
npm run gen:manifest
```

Start the dev servers (HTTP on port **3000** and HTTPS on **3001**):

```bash
npm run dev
```

Open **http://localhost:3000** (service workers and caching work reliably on this origin). Use **https://localhost:3001** only if the browser trusts the dev certificate.

Single-server variants:

```bash
npm run dev:http    # http://localhost:3000
npm run dev:https   # https://localhost:3001
```

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Concurrent HTTP + HTTPS Vite dev |
| `npm run dev:http` | HTTP dev only (port 3000) |
| `npm run dev:https` | HTTPS dev only (port 3001) |
| `npm run gen:manifest` | Scan `dicom/data` and write `dicom/data/manifest.json` |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run preview:host` | Preview bound to `0.0.0.0:4173` |

## Data layout

| Path | Role |
|------|------|
| `dicom/data/` | DICOM instances + `manifest.json` (generated) |
| `static/` | Copied to **`dist/` root** as-is (e.g. `service-worker.js`) |

The app loads slices from **`/dicom/data/...`**. In dev, Vite serves `dicom/data` at that URL. After **`npm run build`**, the same tree is copied to **`dist/dicom/data/`** for static hosting.

## Production build

```bash
npm run build
```

Serve the **`dist/`** directory over **HTTPS** if you rely on the service worker. Ensure the host exposes **`/dicom/data/`** (manifest and slice files) at the same origin as the app.

## WebXR

Open **`xr.html`** (or use **XR Mode** in the header) for the immersive viewer. Same DICOM session and caching behavior as the 2D dashboard.

## LAN / HMR

Set **`VITE_DEV_HMR_HOST`** to your machine’s LAN IP or hostname if you need hot reload from another device.
