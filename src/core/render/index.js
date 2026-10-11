// @ts-check
// Render module entry point (BUILD_AMENDMENTS 3.1, FROZEN contract):
//   renderSource({ format, source, docPath, stamp }) -> Promise<RenderResult>
//   elementText / deepestBlockAt / elementsIntersecting (query.js), sectionAt
//   getRender(store, doc, ver|'live', { stamp })     -> cached RenderResult (disk cache for versions, LRU for live)
//   finalizeHtml(render, { assetBase, guestTag, stripCsp }) -> the HTML string the daemon serves
//   renderFragment({ format, source })               -> sanitised HTML fragment
//
// RenderResult = { format, html, guestInsertAt, bodyEndAt, srcmap, text: { text, spans }, outline, assets,
//                  externals, title, features: { mermaid, math, code } }
// (`format` and `bodyEndAt` are additions to the frozen shape; bodyEndAt is where finalizeHtml appends the
// vendored mermaid scripts for HTML docs.) getRender results also carry `sourceSha256`.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { RENDERER_VERSION } from '../../shared/protocol.js';
import { LruCache, readJsonCache, renderCacheDir, versionCacheName, writeJsonCache } from './cache.js';
import { decodeSource } from './charset.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { ASSET_BASE_PLACEHOLDER, MERMAID_SCRIPTS } from './shell.js';

export { deepestBlockAt, elementsIntersecting, elementText, intersects, sectionAt } from './query.js';
export { renderFragment, renderFragmentSync, sanitizeHast } from './fragment.js';
export { decodeSource } from './charset.js';
export { cssRefs, classifyRef, parseSrcset } from './assets.js';
export { unstamp } from './html.js';
export { ASSET_BASE_PLACEHOLDER } from './shell.js';

/**
 * @typedef {import('./srcmap.js').SrcNode} SrcNode
 * @typedef {import('./srcmap.js').SrcMap} SrcMap
 * @typedef {import('./srcmap.js').OutlineItem} OutlineItem
 * @typedef {Object} RenderResult
 * @property {'markdown'|'html'} format
 * @property {string} html
 * @property {number} guestInsertAt
 * @property {number} bodyEndAt
 * @property {SrcMap} srcmap
 * @property {{ text: string, spans: Record<string, [number, number]> }} text
 * @property {OutlineItem[]} outline
 * @property {string[]} assets
 * @property {string[]} externals
 * @property {string} title
 * @property {{ mermaid: boolean, math: boolean, code: boolean }} features
 * @property {string} [sourceSha256]
 */

/**
 * Normalise a format name ('md' / 'markdown' / 'html' / 'htm'); falls back to the doc path's extension.
 * @param {string|undefined} format
 * @param {string|undefined} docPath
 * @returns {'markdown'|'html'}
 */
export function normalizeFormat(format, docPath) {
  const f = String(format ?? '').toLowerCase();
  if (f === 'markdown' || f === 'md') return 'markdown';
  if (f === 'html' || f === 'htm') return 'html';
  const ext = path.posix.extname(String(docPath ?? '')).toLowerCase();
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'markdown';
  throw new TypeError(`renderSource: unknown format ${JSON.stringify(format)}`);
}

/**
 * Render a document.
 * @param {{ format: 'markdown'|'html'|string, source: string|Uint8Array, docPath?: string, stamp?: boolean }} p
 * @returns {Promise<RenderResult>}
 */
export async function renderSource({ format, source, docPath, stamp = true }) {
  return renderSourceSync({ format, source, docPath, stamp });
}

/**
 * Synchronous renderSource (all pipeline stages are synchronous).
 * @param {{ format: 'markdown'|'html'|string, source: string|Uint8Array, docPath?: string, stamp?: boolean }} p
 * @returns {RenderResult}
 */
export function renderSourceSync({ format, source, docPath, stamp = true }) {
  const fmt = normalizeFormat(format, docPath);
  const { text } = decodeSource(source ?? '', fmt);
  const r = fmt === 'html' ? renderHtml(text, { docPath, stamp }) : renderMarkdown(text, { docPath, stamp });
  return { format: fmt, ...r };
}

const memory = new LruCache(32);

/** Drop in-memory renders (tests). */
export function clearRenderMemoryCache() {
  memory.clear();
}

/** @param {string} s */
function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Cached render of a doc version (number) or of the working copy ('live').
 * Store contract used: readVersion(docId, v) -> { manifest, source }, readWorking(doc) -> { text, sha256 },
 * cacheDir('render', docId) (or runtimeDir('cache', 'render', docId)).
 * @param {any} store
 * @param {{ id: string, path: string, format?: string }} doc
 * @param {number|string} ver  version number, 'v3', or 'live'
 * @param {{ stamp?: boolean }} [opts]
 * @returns {Promise<RenderResult>}
 */
export async function getRender(store, doc, ver, { stamp = true } = {}) {
  const format = normalizeFormat(doc.format, doc.path);
  if (ver === 'live' || ver == null) {
    const w = await store.readWorking(doc);
    const text = typeof w?.text === 'string' ? w.text : decodeSource(w?.buf ?? '', format).text;
    const sha = w?.sha256 ?? sha256(text);
    const key = `live|${doc.id}|${doc.path}|${format}|${stamp}|${sha}`;
    const hit = memory.get(key);
    if (hit) return hit;
    const r = { ...renderSourceSync({ format, source: text, docPath: doc.path, stamp }), sourceSha256: sha };
    memory.set(key, r);
    return r;
  }
  const v = typeof ver === 'string' ? Number(ver.replace(/^v/i, '')) : Number(ver);
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`getRender: bad version ${JSON.stringify(ver)}`);
  const { manifest, source } = await store.readVersion(doc.id, v);
  const text = typeof source === 'string' ? source : decodeSource(source ?? '', format).text;
  const sha = manifest?.sha256 ? String(manifest.sha256).replace(/^sha256:/, '') : sha256(text);
  const dir = await renderCacheDir(store, doc.id);
  const name = versionCacheName(v, RENDERER_VERSION, sha, stamp);
  const key = `v|${doc.id}|${doc.path}|${dir ?? ''}|${name}`;
  const hit = memory.get(key);
  if (hit) return hit;
  const file = dir ? path.join(dir, name) : null;
  if (file) {
    const cached = await readJsonCache(file);
    if (cached && cached.format === format && typeof cached.html === 'string' && cached.srcmap) {
      memory.set(key, cached);
      return cached;
    }
  }
  const r = { ...renderSourceSync({ format, source: text, docPath: doc.path, stamp }), sourceSha256: sha };
  if (file) await writeJsonCache(file, r);
  memory.set(key, r);
  return r;
}

/**
 * Produce the HTML the content origin serves: appends vendored mermaid for HTML docs that need it, inserts the
 * guest tag at guestInsertAt, replaces __SR_ASSET_BASE__ (Markdown shells) and optionally strips CSP metas.
 * @param {RenderResult} render
 * @param {{ assetBase?: string, guestTag?: string, stripCsp?: boolean }} [opts]
 * @returns {string}
 */
export function finalizeHtml(render, { assetBase, guestTag = '', stripCsp = false } = {}) {
  let html = render.html;
  let guestAt = Math.max(0, Math.min(render.guestInsertAt ?? 0, html.length));
  if (render.format === 'html' && render.features?.mermaid) {
    let bodyEnd = render.bodyEndAt;
    if (typeof bodyEnd !== 'number') {
      const m = html.toLowerCase().lastIndexOf('</body>');
      bodyEnd = m >= 0 ? m : html.length;
    }
    const base = assetBase ?? ASSET_BASE_PLACEHOLDER;
    const scripts = MERMAID_SCRIPTS.split(ASSET_BASE_PLACEHOLDER).join(base);
    html = html.slice(0, bodyEnd) + scripts + html.slice(bodyEnd);
    if (bodyEnd < guestAt) guestAt += scripts.length;
  }
  if (guestTag) html = html.slice(0, guestAt) + guestTag + html.slice(guestAt);
  if (render.format !== 'html' && assetBase != null) html = html.split(ASSET_BASE_PLACEHOLDER).join(assetBase);
  if (stripCsp) html = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi, '');
  return html;
}
