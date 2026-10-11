// @ts-check
// Render caching (design 6.7): an in-memory LRU (live renders keyed by content hash, version renders keyed by
// cache file) and a JSON disk cache for versions at
// <store cache dir>/render/<docId>/v<NNNN>-<RENDERER_VERSION>-<sha8>[-nostamp].json, written atomically
// (tmp file + rename). Disk-cache failures are never fatal: the render is simply recomputed.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Small LRU map. */
export class LruCache {
  /** @param {number} max */
  constructor(max) {
    this.max = Math.max(1, max);
    /** @type {Map<string, any>} */
    this.map = new Map();
  }

  /** @param {string} key */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }
}

/**
 * Resolve the render cache directory for a doc from a Store (cacheDir('render', docId) per design 4.4, or
 * runtimeDir('cache', 'render', docId) per the amendments). Returns null when the store offers neither.
 * @param {any} store
 * @param {string} docId
 * @returns {Promise<string|null>}
 */
export async function renderCacheDir(store, docId) {
  try {
    if (typeof store?.cacheDir === 'function') return String(await store.cacheDir('render', docId));
    if (typeof store?.runtimeDir === 'function') return String(await store.runtimeDir('cache', 'render', docId));
  } catch {
    /* no disk cache */
  }
  return null;
}

/**
 * Cache file name for a version render.
 * @param {number} v @param {string} rendererVersion @param {string} sha256hex @param {boolean} stamp
 */
export function versionCacheName(v, rendererVersion, sha256hex, stamp) {
  return `v${String(v).padStart(4, '0')}-${rendererVersion}-${String(sha256hex).slice(0, 8)}${stamp ? '' : '-nostamp'}.json`;
}

/**
 * @param {string} file
 * @returns {Promise<any|null>}
 */
export async function readJsonCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic best-effort JSON write.
 * @param {string} file
 * @param {any} data
 * @returns {Promise<boolean>}
 */
export async function writeJsonCache(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
