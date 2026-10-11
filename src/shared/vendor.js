// @ts-check
// Vendored browser libraries served straight from node_modules (no build step). Node-only module.
//
// A map turns a public path prefix into a directory inside node_modules:
//   VENDOR_UI  -> served on the UI origin under /vendor/*            (Preact+htm, marked, DOMPurify, jsdiff)
//   VENDOR_DOC -> served on the content origin under /__sr/<RV>/vendor/* (markdown CSS, hljs themes, KaTeX, mermaid, modern-screenshot)
// `resolveVendor(map, 'htm/preact/standalone.module.js')` returns the absolute file path, or null when the path
// is not under a mapped directory, contains dot-segments, escapes through a symlink, or is not a regular file.
// node_modules is located by walking up from this file, per package, so hoisted and nested layouts both work.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {Readonly<Record<string, string>>} VendorMap  public prefix (ends with '/') -> 'pkg/sub/dir/' */

/** @type {VendorMap} */
export const VENDOR_UI = Object.freeze({
  'htm/': 'htm/',
  'marked/': 'marked/lib/',
  'dompurify/': 'dompurify/dist/',
  'diff/': 'diff/libesm/',
});

/** @type {VendorMap} */
export const VENDOR_DOC = Object.freeze({
  'github-markdown-css/': 'github-markdown-css/',
  'highlight.js/styles/': 'highlight.js/styles/',
  'katex/': 'katex/dist/',
  'modern-screenshot/': 'modern-screenshot/dist/', // lazy-loaded by the guest for snip crops
  'mermaid/': 'mermaid/dist/',
});

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, string | null>} 'pkg/sub/dir/' -> real absolute directory (or null when missing) */
const dirCache = new Map();

/**
 * Package name of a mapped directory: 'diff/libesm/' -> 'diff', '@scope/pkg/dist/' -> '@scope/pkg'.
 * @param {string} target
 * @returns {string}
 */
function packageOf(target) {
  const parts = target.split('/').filter(Boolean);
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0] ?? '';
}

/**
 * Absolute real path of a mapped directory such as 'diff/libesm/', found by walking up from this file looking
 * for node_modules/<pkg>. Cached per process.
 * @param {string} target
 * @returns {string | null}
 */
export function vendorDir(target) {
  if (dirCache.has(target)) return /** @type {string | null} */ (dirCache.get(target));
  const pkg = packageOf(target);
  const sub = target.split('/').filter(Boolean).slice(pkg.split('/').length);
  /** @type {string | null} */
  let found = null;
  if (pkg) {
    for (let dir = HERE; ; dir = path.dirname(dir)) {
      const pkgDir = path.join(dir, 'node_modules', pkg);
      if (isDir(pkgDir)) {
        const candidate = path.join(pkgDir, ...sub);
        if (isDir(candidate)) found = fs.realpathSync(candidate);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  dirCache.set(target, found);
  return found;
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a public vendor path to an absolute file path.
 * @param {VendorMap} map VENDOR_UI or VENDOR_DOC
 * @param {string} publicPath e.g. 'katex/katex.min.css' (a leading '/' is ignored; must already be URL-decoded)
 * @returns {string | null}
 */
export function resolveVendor(map, publicPath) {
  if (typeof publicPath !== 'string' || publicPath.includes('\0') || publicPath.includes('\\')) return null;
  const rel = publicPath.replace(/^\/+/, '');
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  let prefix = '';
  for (const key of Object.keys(map)) {
    if (rel.startsWith(key) && key.length > prefix.length) prefix = key;
  }
  if (!prefix) return null;
  const rest = rel.slice(prefix.length);
  if (!rest) return null;
  const base = vendorDir(map[prefix]);
  if (!base) return null;
  const abs = path.join(base, ...rest.split('/'));
  let real;
  try {
    real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const back = path.relative(base, real);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return null;
  return real;
}

/**
 * Every mapped directory of a map with its resolved location (null = missing); used by `doctor` and tests.
 * @param {VendorMap} map
 * @returns {Record<string, string | null>}
 */
export function listVendorDirs(map) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const [prefix, target] of Object.entries(map)) out[prefix] = vendorDir(target);
  return out;
}
