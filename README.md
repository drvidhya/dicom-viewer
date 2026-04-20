# DICOM Viewer

[Visit live website](https://drvidhya.github.io/dicom-viewer/)

Web-based CT/MR-style stack viewer built with [Cornerstone3D](https://www.cornerstonejs.org/): dashboard plus separate Axial / Sagittal / Coronal windows, optional **WebXR** mode (`xr.html`), and a small service worker cache for DICOM GETs (URLs whose path contains `dicom/data/`) on HTTPS.

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

| Script                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Concurrent HTTP + HTTPS Vite dev                       |
| `npm run dev:http`     | HTTP dev only (port 3000)                              |
| `npm run dev:https`    | HTTPS dev only (port 3001)                             |
| `npm run gen:manifest` | Scan `dicom/data` and write `dicom/data/manifest.json` |
| `npm run build`        | Typecheck + production build into `dist/`              |
| `npm run preview`      | Serve `dist/` locally                                  |
| `npm run preview:host` | Preview bound to `0.0.0.0:4173`                        |

## Data layout

**Workflow:** Edit application **source** only on **`main`** (`src/`, `static/`, TypeScript and Vite config). The **`dist/`** tree is **only** produced by **`npm run build`** (it is removed first, then rebuilt). Do not hand-edit files under **`dist/`**. **DICOM study files** under **`dicom/data/`** (and **`manifest.json`** from **`npm run gen:manifest`**) are **not** Vite build output; they are dataset assets you keep beside **`dist/`** for deploys.

Keep DICOM in **`dicom/data/`** at the **repository root** (next to `package.json`). Run **`npm run gen:manifest`** there. **`dicom/`** is **gitignored** so it stays on disk when you change branches; you choose what to upload for deploys.

| Path          | Role                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `dicom/data/` | Local + dev: instances + `manifest.json`                                            |
| `static/`     | Copied to **`dist/`** root on build (e.g. `service-worker.js`)                       |

**`npm run dev`** and **`npm run preview`** both serve the repo folder **`dicom/data/`** at dev-server path **`/dicom/data/`** (no copy into **`dist/`**). The app loads datasets from **`dicom/data/`** relative to each HTML page, so at **`http://localhost:3000/`** that matches the middleware.

**Deploy:** upload the **contents** of **`dist/`** and a **`dicom/data/`** directory **next to** **`index.html`** / **`xr.html`** on disk (same folder layout as in **`dist/`** after you copy or symlink data there). The build does **not** copy DICOM.

Custom dataset location: set **`VITE_DICOM_DATA_BASE`** in `.env.production` (path relative to the page, or full URL).

## Production build

```bash
npm run build
```

Use **HTTPS** if you rely on the service worker. After build, ensure requests for **`dicom/data/*`** next to your HTML resolve on the same origin (path prefix follows your deploy directory).

## WebXR

Open **`xr.html`** (or use **XR Mode** in the header) for the immersive viewer. Same DICOM session and caching behavior as the 2D dashboard.

## LAN / HMR

Set **`VITE_DEV_HMR_HOST`** to your machine’s LAN IP or hostname if you need hot reload from another device.

## Session / localStorage

The viewer stores slice URLs in **`localStorage`** keyed by **`location.origin`** (so `http://localhost:3000` and `http://127.0.0.1:3000` do not share the same session). Stored `wadouri:` URLs are rewritten to match the current data directory when loaded. If the dashboard still fails after switching hosts or deploys, clear site data for that origin or use a private window.
