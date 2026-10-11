// @ts-check
// The content origin (http://127.0.0.1:<contentPort>, BUILD_AMENDMENTS 6, design 6.1 / 10.4): serves documents
// exactly as authored (plus data-srid attributes and the guest tag) and their assets. It has no API and no
// state-changing route: only GET/HEAD; everything else is 405.
//
//   /__sr/<RENDERER_VERSION>/guest.js        guest bundle (GuestBundleCache)
//   /__sr/<RENDERER_VERSION>/static/<file>   src/core/render/static/* (shell.css, mermaid-init.js)
//   /__sr/<RENDERER_VERSION>/vendor/<path>   vendored doc libraries through VENDOR_DOC
//       -> Cache-Control: public, max-age=31536000, immutable (the URL carries the renderer version)
//   /c/<docKey>/<ver>/<doc.path>             the rendered doc (ver = live | v<N>), guest tag at guestInsertAt,
//                                            Markdown shell asset base replaced (render finalizeHtml)
//   /c/<docKey>/<ver>/<other path>           an asset (rules below)
//   /<anything else>                         root-absolute URL used by a doc ('/img/a.png'): 307 to the same path
//                                            under the Referer's /c/<docKey>/<ver>/ prefix; 404 without one
//
// docKey = hmacSha256(secret, wsId + '/' + docId).slice(0, 24): a per-doc capability, so a page that learns one
// doc's URL cannot read another doc's files, and other websites cannot probe the workspace.
//
// Asset rules (workspace-relative POSIX paths, never dot-segments/dotfiles/keys, symlink-safe via
// realpathWithin(workspace root), files <= LIMITS.maxServeBytes, single byte ranges for media):
//   vN:   the version manifest's blob when listed; else the live file when the manifest lists the path (e.g. a
//         'live' entry for a too-large asset) or when the live rules allow it.
//   live: allowed when the path is in the current live render's `assets`, or lies under the doc's own directory
//         (recursively) with an allowed extension.
// Every response: X-Content-Type-Options: nosniff and Content-Security-Policy frame-ancestors <UI origins>
// (+ default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' when render.network is "block").

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, RENDERER_VERSION } from '../shared/protocol.js';
import { VENDOR_DOC, resolveVendor } from '../shared/vendor.js';
import { finalizeHtml, getRender } from '../core/render/index.js';
import { extOf, isDeniedPath, realpathWithin, toPosix } from '../core/util/paths.js';
import { createLogger } from '../core/util/log.js';
import { HttpError, notFound, sendFile, sendText } from './http-util.js';
import { contentTypeOf } from './mime.js';
import { encodeRelPath, encodeSegments, isAllowedHost, isSafeMethod, loopbackOrigins, parseTarget, setBaseHeaders } from './security.js';
import { DOC_KEY_RE } from './workspaces.js';

const log = createLogger('daemon.content');

/** Directory of the renderer's static files (shell.css, mermaid-init.js). */
export const RENDER_STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'render', 'static');

/** Extensions served from the doc's own directory without being referenced by the render (amendments 6). */
export const LIVE_ASSET_EXTS = Object.freeze(new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'css', 'js', 'mjs', 'json', 'woff', 'woff2', 'ttf',
  'otf', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'm4a', 'txt', 'csv', 'md', 'html', 'htm', 'pdf',
]));

const IMMUTABLE = 'public, max-age=31536000, immutable';
const VER_RE = /^(live|v[1-9]\d{0,8})$/;
const MANIFEST_CACHE_MAX = 512;

/** @typedef {import('../core/store/store.js').Store} Store */
/** @typedef {import('../shared/types.js').Doc} Doc */
/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

/**
 * @typedef {object} ContentDeps
 * @property {import('./workspaces.js').WorkspaceIndex} index
 * @property {import('./guest-bundle.js').GuestBundleCache} guest
 * @property {() => { uiPort: number, contentPort: number }} ports
 * @property {boolean} [dev] serve the guest bundle with no-cache (it is rebuilt on change)
 */

export class ContentOrigin {
  /** @param {ContentDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, any>} `${wsId}/${docId}/${v}` -> manifest (immutable once committed) */
    this.manifests = new Map();
  }

  /**
   * Request handler (never throws).
   * @param {Req} req
   * @param {Res} res
   */
  async handle(req, res) {
    setBaseHeaders(res);
    try {
      if (!isAllowedHost(req, req.socket.localPort ?? this.deps.ports().contentPort)) {
        sendText(res, 421, 'Misdirected request');
        return;
      }
      if (!isSafeMethod(req.method)) {
        sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      const target = parseTarget(req.url);
      if (!target) throw notFound();
      const [first] = target.segments;
      if (first === '__sr') await this.#serveSr(req, res, target.segments.slice(1));
      else if (first === 'c') await this.#serveCapability(req, res, target);
      else rootAbsolute(req, res, target);
    } catch (err) {
      const e = /** @type {any} */ (err);
      const status = err instanceof HttpError ? err.status : e?.code === 'NOT_FOUND' ? 404 : 500;
      if (status >= 500 && status !== 503) log.error(`content ${req.method} ${String(req.url).split('?')[0]} failed`, err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = status === 404 ? 'Not found' : String(e?.message ?? err);
      sendText(res, status, message, err instanceof HttpError && err.headers ? err.headers : {});
    }
  }

  /**
   * Content-Security-Policy for responses of a workspace (null: no workspace context).
   * @param {string | null} wsId
   * @returns {Promise<string>}
   */
  async #csp(wsId) {
    const parts = [`frame-ancestors ${loopbackOrigins(this.deps.ports().uiPort).join(' ')}`];
    if (wsId) {
      try {
        if ((await this.deps.index.config(wsId)).render?.network === 'block') {
          parts.push("default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'");
        }
      } catch {
        // unreadable config: no extra restriction
      }
    }
    return parts.join('; ');
  }

  /**
   * /__sr/<RV>/...
   * @param {Req} req
   * @param {Res} res
   * @param {string[]} segs
   */
  async #serveSr(req, res, segs) {
    const [rv, kind, ...rest] = segs;
    if (rv !== RENDERER_VERSION) throw notFound();
    const headers = { 'Content-Security-Policy': await this.#csp(null) };
    if (kind === 'guest.js' && rest.length === 0) {
      const bundle = await this.deps.guest.get();
      const cacheControl = this.deps.dev ? 'no-cache' : IMMUTABLE;
      if (String(req.headers['if-none-match'] ?? '') === bundle.etag) {
        res.writeHead(304, { ETag: bundle.etag, 'Cache-Control': cacheControl, ...headers });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(bundle.body.length),
        'Cache-Control': cacheControl,
        ETag: bundle.etag,
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : bundle.body);
      return;
    }
    if (kind === 'static' && rest.length) {
      const rel = rest.join('/');
      const abs = isDeniedPath(rel) ? null : realpathWithin(RENDER_STATIC_DIR, rel);
      if (!abs) throw notFound();
      await sendFile(req, res, abs, { contentType: contentTypeOf(abs), cacheControl: IMMUTABLE, headers });
      return;
    }
    if (kind === 'vendor' && rest.length) {
      const abs = resolveVendor(VENDOR_DOC, rest.join('/'));
      if (!abs) throw notFound();
      await sendFile(req, res, abs, { contentType: contentTypeOf(abs), cacheControl: IMMUTABLE, headers });
      return;
    }
    throw notFound();
  }

  /**
   * /c/<docKey>/<ver>/<path...>
   * @param {Req} req
   * @param {Res} res
   * @param {import('./security.js').RequestTarget} target
   */
  async #serveCapability(req, res, target) {
    const [, key, ver, ...rest] = target.segments;
    if (!key || !DOC_KEY_RE.test(key) || !ver || !VER_RE.test(ver)) throw notFound();
    const ref = await this.deps.index.resolveDocKey(key);
    if (!ref) throw notFound();
    const { store, doc } = await this.deps.index.doc(ref.wsId, ref.docId);
    const rel = rest.join('/');
    if (!rel) {
      res.writeHead(302, { Location: `/c/${key}/${ver}/${encodeRelPath(doc.path)}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const policy = await this.#csp(ref.wsId);
    if (rel === doc.path) await this.#serveDoc(req, res, { store, doc, wsId: ref.wsId, ver, policy });
    else await this.#serveAsset(req, res, { store, doc, wsId: ref.wsId, ver, rel, policy });
  }

  /**
   * The rendered doc with the guest tag.
   * @param {Req} req
   * @param {Res} res
   * @param {{ store: Store, doc: Doc, wsId: string, ver: string, policy: string }} o
   */
  async #serveDoc(req, res, { store, doc, wsId, ver, policy }) {
    const { uiPort, contentPort } = this.deps.ports();
    let render;
    try {
      render = await getRender(store, doc, ver === 'live' ? 'live' : Number(ver.slice(1)));
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'NOT_FOUND') throw notFound();
      throw err;
    }
    const html = finalizeHtml(render, {
      assetBase: `http://127.0.0.1:${contentPort}/__sr/${RENDERER_VERSION}`,
      guestTag: guestTag({ contentPort, uiPort, wsId, docId: doc.id, ver }),
    });
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': policy,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * An asset of a doc version (see the rules in the header).
   * @param {Req} req
   * @param {Res} res
   * @param {{ store: Store, doc: Doc, wsId: string, ver: string, rel: string, policy: string }} o
   */
  async #serveAsset(req, res, { store, doc, wsId, ver, rel, policy }) {
    if (isDeniedPath(rel)) throw notFound();
    const headers = { 'Content-Security-Policy': policy };
    let listed = false;
    if (ver !== 'live') {
      const manifest = await this.#manifest(store, wsId, doc.id, Number(ver.slice(1)));
      const ref = manifest?.assets?.[rel];
      if (typeof ref === 'string') {
        listed = true;
        const blob = store.blobPath(ref);
        if (blob) {
          await sendFile(req, res, blob, {
            contentType: contentTypeOf(rel),
            cacheControl: 'no-cache',
            etag: `"${ref.replace(/^sha256:/, '').slice(0, 32)}"`,
            headers,
          });
          return;
        }
      }
    }
    const abs = realpathWithin(store.root, rel);
    if (!abs) throw notFound();
    // the real file must not be a denied path either (a symlink into .git/, a key file...)
    if (isDeniedPath(toPosix(path.relative(store.root, abs)))) throw notFound();
    if (!listed && !(await liveAllowed(store, doc, rel))) throw notFound();
    await sendFile(req, res, abs, { contentType: contentTypeOf(rel), cacheControl: 'no-cache', headers, maxBytes: LIMITS.maxServeBytes });
  }

  /**
   * Committed version manifest (cached; 404 when the version does not exist).
   * @param {Store} store
   * @param {string} wsId
   * @param {string} docId
   * @param {number} v
   */
  async #manifest(store, wsId, docId, v) {
    const key = `${wsId}/${docId}/${v}`;
    if (this.manifests.has(key)) return this.manifests.get(key);
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(store.versionsDir(docId), `${String(v).padStart(4, '0')}.json`), 'utf8'));
    } catch {
      throw notFound();
    }
    if (this.manifests.size >= MANIFEST_CACHE_MAX) this.manifests.clear();
    this.manifests.set(key, manifest);
    return manifest;
  }
}

/**
 * Live asset rule: under the doc's directory with an allowed extension, or referenced by the current live render.
 * @param {Store} store
 * @param {Doc} doc
 * @param {string} rel
 * @returns {Promise<boolean>}
 */
export async function liveAllowed(store, doc, rel) {
  const dir = path.posix.dirname(doc.path);
  const underDocDir = dir === '.' || rel.startsWith(`${dir}/`);
  if (underDocDir && LIVE_ASSET_EXTS.has(extOf(rel))) return true;
  try {
    const render = await getRender(store, doc, 'live');
    return Array.isArray(render.assets) && render.assets.includes(rel);
  } catch (err) {
    log.debug(`live render of ${doc.id} unavailable for the asset allowlist`, err);
    return false;
  }
}

/**
 * The guest <script> tag inserted at guestInsertAt (classic, synchronous, absolute URL; amendments 6).
 * @param {{ contentPort: number, uiPort: number, wsId: string, docId: string, ver: string }} o
 * @returns {string}
 */
export function guestTag({ contentPort, uiPort, wsId, docId, ver }) {
  const src = `http://127.0.0.1:${contentPort}/__sr/${RENDERER_VERSION}/guest.js`;
  const ui = loopbackOrigins(uiPort).join(' ');
  return `<script src="${src}" data-sr-ui="${ui}" data-sr-target="${wsId}/${docId}/${ver}" data-sr-ignore></script>`;
}

/**
 * Root-absolute fallback: resolve '/img/a.png' against the Referer's /c/<docKey>/<ver>/ prefix (307, so the asset's
 * final URL lives under /c/ and its own relative references resolve there too).
 * @param {Req} req
 * @param {Res} res
 * @param {import('./security.js').RequestTarget} target
 */
function rootAbsolute(req, res, target) {
  if (!target.segments.length) throw notFound();
  const referer = req.headers.referer;
  if (typeof referer !== 'string') throw notFound();
  let url;
  try {
    url = new URL(referer);
  } catch {
    throw notFound();
  }
  if (url.host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) throw notFound();
  const m = /^\/c\/([0-9a-f]{24})\/(live|v[1-9]\d{0,8})\//.exec(url.pathname);
  if (!m) throw notFound();
  const query = target.query.toString();
  res.writeHead(307, { Location: `/c/${m[1]}/${m[2]}${encodeSegments(target.segments)}${query ? `?${query}` : ''}`, 'Cache-Control': 'no-store' });
  res.end();
}
