// @ts-check
// Crash-safe file writes and the canonical JSON format of every Suiko file (design 5.3 / 5.4).
//
// writeFileAtomic: write `<file>.tmp-<pid>-<rand>` (exclusive create), fsync, rename over the target, then fsync
// the directory (best effort). Readers therefore see either the old or the new content, never a torn file.
// Leftover temp files match the `*.tmp-*` pattern in .specreview/.gitignore and are swept by recovery once their
// pid is dead.
//
// JSON: top-level keys sorted, 2-space indent, LF line endings, trailing newline. Nested objects keep their
// insertion order (callers build them deterministically).

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomHex } from '../util/hash.js';

const TMP_RE = /\.tmp-(\d+)-[0-9a-z]+$/;

/**
 * Temp-file name used for an atomic write of `file`.
 * @param {string} file
 * @returns {string}
 */
export function tmpPathFor(file) {
  return `${file}.tmp-${process.pid}-${randomHex(4)}`;
}

/**
 * Parses a temp-file name produced by tmpPathFor.
 * @param {string} name basename or path
 * @returns {{ pid: number } | null}
 */
export function parseTmpName(name) {
  const m = TMP_RE.exec(name);
  return m ? { pid: Number(m[1]) } : null;
}

/**
 * @typedef {object} AtomicWriteOptions
 * @property {number} [mode] exact permission bits for the file (applied with fchmod, so umask does not interfere)
 * @property {boolean} [mkdir=true] create the parent directory if needed
 * @property {(tmpPath: string) => Promise<void> | void} [beforeRename] last check before the rename; throwing aborts
 *   the write and removes the temp file (used for compare-and-swap)
 */

/**
 * Atomically replaces `file` with `data`.
 * @param {string} file absolute path
 * @param {string | Buffer | Uint8Array} data strings are written as UTF-8
 * @param {AtomicWriteOptions} [opts]
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(file, data, opts = {}) {
  const { mode, mkdir = true, beforeRename } = opts;
  const dir = path.dirname(file);
  if (mkdir) await fs.mkdir(dir, { recursive: true });
  const tmp = tmpPathFor(file);
  let handle = await fs.open(tmp, 'wx', mode ?? 0o666);
  try {
    try {
      await handle.writeFile(data);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename) await beforeRename(tmp);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fsyncDir(dir);
}

/**
 * Best-effort directory fsync so the rename itself is durable (ignored where unsupported).
 * @param {string} dir
 */
async function fsyncDir(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // EISDIR / EPERM / EINVAL on some platforms and filesystems: durability is best effort here
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Canonical JSON text: sorted top-level keys, 2-space indent, LF, trailing newline.
 * Arrays and primitives at the top level are serialised as-is.
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyJson(value) {
  let out = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    const src = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(src).sort()) sorted[key] = src[key];
    out = sorted;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Atomically writes canonical JSON.
 * @param {string} file
 * @param {unknown} value
 * @param {AtomicWriteOptions} [opts]
 */
export async function writeJson(file, value, opts) {
  await writeFileAtomic(file, stringifyJson(value), opts);
}

/**
 * Reads and parses a JSON file. Returns null when the file (or a parent directory) does not exist.
 * A UTF-8 BOM is tolerated. Malformed JSON throws an Error with code 'EJSON' naming the file.
 * @template [T=any]
 * @param {string} file
 * @returns {Promise<T | null>}
 */
export async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    const e = /** @type {Error & { code?: string, path?: string }} */ (
      new Error(`corrupt JSON in ${file}: ${/** @type {Error} */ (err).message}`, { cause: err })
    );
    e.code = 'EJSON';
    e.path = file;
    throw e;
  }
}

/**
 * True when the path exists (any type).
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
