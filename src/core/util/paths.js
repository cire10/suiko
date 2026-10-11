// @ts-check
// Path helpers: doc-id slugs, POSIX normalisation, the asset deny-list, symlink-safe containment checks and
// extension/format detection. Doc paths are stored workspace-relative in POSIX form everywhere in SpecReview.

import fs from 'node:fs';
import path from 'node:path';

const MAX_SLUG = 64;

/**
 * Doc-id slug of a file name: 'Token Service.md' -> 'token-service'.
 * Takes the basename, drops the last extension, strips diacritics, lowercases, and collapses every run of
 * characters outside [a-z0-9] into one '-'. Never empty ('doc'), never starts with '_' (ids like `_all` and
 * `_workspace` are reserved for runtime use), at most 64 characters.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const base = path.posix.basename(toPosix(String(name ?? '')));
  const stem = base.replace(/(?<=.)\.[^.]*$/, '');
  const slug = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'doc';
}

/**
 * Converts platform separators to '/'. (On POSIX this only rewrites backslashes, which never occur in
 * paths SpecReview produces.)
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return String(p).split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * True when `child` (absolute) is `parent` itself or lies under it, compared lexically.
 * @param {string} parent absolute
 * @param {string} child absolute
 * @returns {boolean}
 */
export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/**
 * The content-origin deny rule for workspace-relative POSIX paths. Denied:
 * - empty paths and paths containing NUL;
 * - any segment starting with '.' (dot-segments, dotfiles, `.git`, `.specreview`, `.env`...);
 * - private-key material: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` (also `id_dsa*`, `id_ecdsa*`, `id_ed25519*`).
 * Matching is case-insensitive. Leading '/' and repeated '/' are tolerated.
 * @param {string} relPosix
 * @returns {boolean}
 */
export function isDeniedPath(relPosix) {
  if (typeof relPosix !== 'string' || relPosix.includes('\0')) return true;
  const segments = toPosix(relPosix).split('/').filter((s) => s !== '');
  if (segments.length === 0) return true;
  if (segments.some((s) => s.startsWith('.'))) return true;
  const base = segments[segments.length - 1].toLowerCase();
  if (/\.(pem|key|p12|pfx)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  return false;
}

/**
 * Resolves `rel` against `root` and returns its real (symlink-resolved) absolute path, or null when the path
 * does not exist or escapes `root` either lexically or through a symlink.
 * @param {string} root absolute directory
 * @param {string} rel relative (POSIX or native) or absolute path
 * @returns {string | null}
 */
export function realpathWithin(root, rel) {
  if (typeof root !== 'string' || typeof rel !== 'string' || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  if (!isWithin(path.resolve(root), abs)) return null;
  let realRoot;
  let realAbs;
  try {
    realRoot = fs.realpathSync(root);
    realAbs = fs.realpathSync(abs);
  } catch {
    return null;
  }
  return isWithin(realRoot, realAbs) ? realAbs : null;
}

/**
 * Lowercase extension without the dot: 'a/B.MD' -> 'md', 'Makefile' -> '', '.env' -> ''.
 * @param {string} p
 * @returns {string}
 */
export function extOf(p) {
  return path.extname(String(p)).slice(1).toLowerCase();
}

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn']);
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);

/**
 * Document format implied by a file extension.
 * @param {string} p
 * @returns {'markdown' | 'html' | null}
 */
export function formatOfPath(p) {
  const ext = extOf(p);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  return null;
}

/**
 * Normalises a user-supplied extension ('.MD', 'md') to a safe lowercase token ('md'), or '' when unusable.
 * @param {string | null | undefined} ext
 * @returns {string}
 */
export function normalizeExt(ext) {
  const e = String(ext ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(e) ? e : '';
}
