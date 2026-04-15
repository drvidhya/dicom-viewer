#!/usr/bin/env node
/**
 * Scans dicom/data for DICOM files and writes dicom/data/manifest.json
 * (relative paths, POSIX slashes) for the viewer's /dicom/data/* URLs.
 *
 * Usage: node src/scripts/generate-dicom-manifest.mjs
 *    or: npm run gen:manifest
 */
import fs from 'fs/promises';
import path from 'path';

const ROOT = path.join(process.cwd(), 'dicom', 'data');
const MANIFEST_NAME = 'manifest.json';
const DICOM_EXT_RE = /\.(dcm|dic|dicom)$/i;

async function hasDicmPreamble(fullPath) {
  const st = await fs.stat(fullPath);
  if (!st.isFile() || st.size < 132) return false;
  const fh = await fs.open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(132);
    await fh.read(buf, 0, 132, 0);
    return buf.subarray(128, 132).toString('ascii') === 'DICM';
  } finally {
    await fh.close();
  }
}

async function collectDicomFiles(dir, relBase = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === MANIFEST_NAME) continue;
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectDicomFiles(full, rel)));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name);
    const byExt = DICOM_EXT_RE.test(ent.name);
    const byMagic = ext === '' && (await hasDicmPreamble(full));
    if (byExt || byMagic) {
      out.push(rel.split(path.sep).join('/'));
    }
  }
  return out;
}

async function main() {
  try {
    await fs.access(ROOT);
  } catch {
    console.error(`Directory does not exist: ${ROOT}`);
    process.exit(1);
  }

  const files = await collectDicomFiles(ROOT);
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const manifestPath = path.join(ROOT, MANIFEST_NAME);
  await fs.writeFile(manifestPath, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${manifestPath} (${files.length} files)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
