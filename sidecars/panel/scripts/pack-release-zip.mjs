#!/usr/bin/env node
/**
 * @fileoverview Pure Node.js whitelist packager for `usage-monitor.zip`.
 *
 * Packs ONLY the runtime-essential plugin files (~520 KB compressed) into a
 * cross-platform PKZIP archive prefixed with `usage-monitor/`, excluding dev-only
 * frontend sources (`src/`), unit tests (`test/`), build scripts (`scripts/`),
 * README preview PNGs (`assets/*.png`), local data (`.data/`), and planning docs (`plan/`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const DEFAULT_ZIP_OUT = join(DEFAULT_REPO_ROOT, 'dist', 'agy-monitor.zip');
export const RELEASE_ARCHIVE_ROOT = 'agy-monitor';

const ROOT_WHITELIST = Object.freeze([
  'plugin.json',
  'mcp_config.json',
  'pricing-catalog.json',
  'LICENSE',
  'assets/logo.svg',
]);

const PANEL_TOP_WHITELIST = Object.freeze([
  'sidecars/panel/sidecar.json',
  'sidecars/panel/index.html',
  'sidecars/panel/app.js',
  'sidecars/panel/styles.css',
  'sidecars/panel/main.mjs',
  'sidecars/panel/mcp-entry.mjs',
  'sidecars/panel/bridge-daemon.mjs',
  'sidecars/panel/standalone.mjs',
  'sidecars/panel/cli-statusline.mjs',
  'sidecars/panel/trajectory-metrics.mjs',
]);

const RUNTIME_SUBDIRS = Object.freeze([
  'sidecars/panel/backend',
  'sidecars/panel/shared',
]);

const ALLOWED_SUBDIR_EXT_RE = /\.(?:mjs|ps1|sh|json)$/i;
const FORBIDDEN_PATH_RE =
  /(?:^|\/)(?:\.git|\.data|node_modules|plan|dist|src|test|scripts)(?:\/|$)|\.png$|\.jpg$|\.jpeg$|\.webp$|\.log$|\.dpapi$/i;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date(2026, 0, 1);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const dosTime =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function collectRuntimeSubdirFiles(repoRoot, relDir, out) {
  const absDir = join(repoRoot, relDir);
  if (!existsSync(absDir)) {
    throw new Error(`Missing required runtime directory: ${relDir}`);
  }
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectRuntimeSubdirFiles(repoRoot, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ALLOWED_SUBDIR_EXT_RE.test(entry.name)) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(childRel);
  }
}

/**
 * Collects the deterministic whitelist of runtime-essential repository paths
 * (POSIX relative paths from `repoRoot`).
 *
 * @param {string} [repoRoot=DEFAULT_REPO_ROOT]
 * @returns {string[]}
 */
export function collectReleaseRuntimeFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = [...ROOT_WHITELIST, ...PANEL_TOP_WHITELIST];
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`Missing required runtime file: ${rel}`);
    }
  }
  for (const relDir of RUNTIME_SUBDIRS) {
    collectRuntimeSubdirFiles(repoRoot, relDir, files);
  }
  const uniqueSorted = Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
  for (const rel of uniqueSorted) {
    if (FORBIDDEN_PATH_RE.test(rel)) {
      throw new Error(`Forbidden non-runtime file matched release list: ${rel}`);
    }
  }
  return uniqueSorted;
}

/**
 * Builds a standard PKZIP (DEFLATE level 9, UTF-8 POSIX entry names) buffer in pure Node.js.
 *
 * @param {Array<{ name: string, data: Buffer, mtime?: Date }>} entries
 * @returns {Buffer}
 */
export function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameStr = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(nameStr, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const deflated = deflateRawSync(rawBuf, { level: 9 });
    const useDeflate = deflated.length < rawBuf.length;
    const payload = useDeflate ? deflated : rawBuf;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(rawBuf);
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix / 2.0
    centralHeader.writeUInt16LE(20, 6); // version needed: 2.0
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file mode
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

/**
 * Packs the runtime-only `usage-monitor.zip` release bundle.
 *
 * @param {{ repoRoot?: string, outFile?: string, rootPrefix?: string }} [options]
 */
export function packReleaseZip({
  repoRoot = DEFAULT_REPO_ROOT,
  outFile = DEFAULT_ZIP_OUT,
  rootPrefix = RELEASE_ARCHIVE_ROOT,
} = {}) {
  const relFiles = collectReleaseRuntimeFiles(repoRoot);
  let totalRawBytes = 0;
  const zipEntries = relFiles.map((rel) => {
    const abs = join(repoRoot, rel);
    const data = readFileSync(abs);
    const st = statSync(abs);
    totalRawBytes += data.length;
    return {
      name: rootPrefix ? `${rootPrefix}/${rel}` : rel,
      data,
      mtime: st.mtime,
    };
  });

  const zipBuf = buildZipBuffer(zipEntries);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, zipBuf);

  return {
    outFile,
    fileCount: relFiles.length,
    files: relFiles,
    rawBytes: totalRawBytes,
    zipBytes: zipBuf.length,
  };
}

function parseCliOutArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      return resolve(argv[i + 1]);
    }
    if (arg.startsWith('--out=')) {
      return resolve(arg.slice(6));
    }
  }
  return DEFAULT_ZIP_OUT;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFile = parseCliOutArg(process.argv.slice(2));
  const summary = packReleaseZip({ repoRoot: DEFAULT_REPO_ROOT, outFile });
  console.log(
    `Packed ${summary.outFile} (${summary.fileCount} runtime files, raw ${(summary.rawBytes / 1024).toFixed(1)} KB -> zip ${(summary.zipBytes / 1024).toFixed(1)} KB)`
  );
}
