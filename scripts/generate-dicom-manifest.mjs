#!/usr/bin/env node
/**
 * Scans a data directory for DICOM slices and `.glb` previews, then writes `manifest.json`
 * there (relative paths, POSIX slashes). The app maps DICOM paths to `wadouri:` URLs and
 * skips `.glb` entries for Cornerstone; XR picks the preview GLB from the same list.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const MANIFEST_NAME = 'manifest.json';
const DICOM_EXT_RE = /\.(dcm|dic|dicom)$/i;
const GLB_EXT_RE = /\.glb$/i;

function scriptName() {
  return path.basename(fileURLToPath(import.meta.url));
}

function printHelp() {
  const n = scriptName();
  process.stderr.write(
    `${n} — build manifest.json for a DICOM (+ optional GLB) dataset\n\n` +
      `Usage:\n` +
      `  node scripts/${n} [data-dir]\n\n` +
      `Arguments:\n` +
      `  data-dir   Directory to scan (default: dicom/data under cwd).\n` +
      `             manifest.json is written inside this directory.\n\n` +
      `Options:\n` +
      `  -h, --help Show this help and exit.\n\n` +
      `Examples:\n` +
      `  node scripts/${n}\n` +
      `  node scripts/${n} dist/dicom/data\n`,
  );
}

function parseRootArg() {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === '-h' || a === '--help')) {
    printHelp();
    process.exit(0);
  }

  const unknownFlag = argv.find((a) => a.startsWith('-'));
  if (unknownFlag) {
    process.stderr.write(`Unknown option: ${unknownFlag}\n\n`);
    printHelp();
    process.exit(1);
  }

  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write('Too many arguments.\n\n');
    printHelp();
    process.exit(1);
  }

  return positional[0]
    ? path.resolve(process.cwd(), positional[0])
    : path.join(process.cwd(), 'dicom', 'data');
}

const ROOT = parseRootArg();

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

async function collectGlbFiles(dir, relBase = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === MANIFEST_NAME) continue;
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectGlbFiles(full, rel)));
      continue;
    }
    if (!ent.isFile()) continue;
    if (GLB_EXT_RE.test(ent.name)) {
      out.push(rel.split(path.sep).join('/'));
    }
  }
  return out;
}

async function main() {
  try {
    const st = await fs.stat(ROOT);
    if (!st.isDirectory()) {
      process.stderr.write(`Not a directory: ${ROOT}\n\n`);
      printHelp();
      process.exit(1);
    }
  } catch {
    process.stderr.write(`Directory does not exist: ${ROOT}\n\n`);
    printHelp();
    process.exit(1);
  }

  const dicomFiles = await collectDicomFiles(ROOT);
  const glbFiles = await collectGlbFiles(ROOT);
  const files = [...dicomFiles, ...glbFiles];
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const manifestPath = path.join(ROOT, MANIFEST_NAME);
  await fs.writeFile(manifestPath, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote manifest (${files.length} entries): ${manifestPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
