// @ts-check
// Static surface of the UI origin (design 6.5 / 10.2 / 12.4, BUILD_AMENDMENTS 6):
//   GET /  and  GET /d/:ws/:doc   src/ui/index.html with an inline import map and the UI CSP
//   GET /ui/*                     files under src/ui (dotfiles, traversal and document types refused)
//   GET /vendor/*                 vendored browser libraries through VENDOR_UI (document types refused)
//   GET /ui-shared/protocol.js    src/shared/protocol.js
//
// Import map: when index.html already contains an inline <script type="importmap"> (WP7 ships one), it is kept as
// is; otherwise src/ui/importmap.json (or DEFAULT_IMPORT_MAP) is inserted right after <head>, before any module
// script. The CSP allows the inline scripts of the served page (in practice only the import map) by hash:
//   default-src 'self'; script-src 'self' 'sha256-<b64>'...; style-src 'self' 'unsafe-inline';
//   img-src 'self' data: blob: http://127.0.0.1:<content>; frame-src http://127.0.0.1:<content>;
//   media-src 'self' data: blob: http://127.0.0.1:<content>; connect-src 'self'; font-src 'self' data:;
//   frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
// (design 12.4 plus media-src/font-src/form-action, matching src/ui/csp.js), X-Frame-Options: DENY and
// Referrer-Policy: no-referrer (the token travels in ?k=). A missing index.html serves a placeholder page.
// index.html is cached by mtime/size, so UI edits are picked up without a restart.
//
// The SPA page is served ONLY through index(), i.e. only with the CSP above. /ui/* and /vendor/* serve
// subresources (scripts, styles, images, fonts, JSON) and refuse every type a browser would render as a document
// (HTML, XHTML, SVG, XML; mime.js isDocumentType): /ui/index.html used to boot the full SPA with no CSP and no
// framing protection, so a doc on the (same-site) content origin could frame it, inherit the reviewer's token from
// sessionStorage and clickjack it, or overwrite that token through ?k=. Every other UI-origin response gets
// X-Frame-Options: DENY and CSP frame-ancestors 'none' from the request pipeline (security.js setUiHeaders).

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_UI, resolveVendor } from '../shared/vendor.js';
import { isDeniedPath, realpathWithin } from '../core/util/paths.js';
import { notFound, sendFile } from './http-util.js';
import { contentTypeOf, isDocumentType } from './mime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** src/ui */
export const UI_DIR = path.join(HERE, '..', 'ui');
/** src/shared/protocol.js */
export const PROTOCOL_FILE = path.join(HERE, '..', 'shared', 'protocol.js');

/** Import map used when src/ui/importmap.json does not exist. */
export const DEFAULT_IMPORT_MAP = Object.freeze({
  imports: {
    'preact-htm': '/vendor/htm/preact/standalone.module.js',
    marked: '/vendor/marked/marked.esm.js',
    dompurify: '/vendor/dompurify/purify.es.mjs',
    diff: '/vendor/diff/index.js',
    'specreview/protocol': '/ui-shared/protocol.js',
  },
});

const IMPORTMAP_RE = /<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script\s*>/i;
const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * sha256 CSP source of an inline script's text.
 * @param {string} text
 * @returns {string} 'sha256-<base64>'
 */
export function cspHash(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * CSP hash sources of every inline <script> (one without a src attribute) of an HTML page.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  /** @type {string[]} */
  const out = [];
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const h = cspHash(m[2]);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * The UI Content-Security-Policy.
 * @param {{ contentPort: number, scriptHashes: string[] }} o
 * @returns {string}
 */
export function uiCsp({ contentPort, scriptHashes }) {
  const content = `http://127.0.0.1:${contentPort}`;
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` ${h}`).join('')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${content}`,
    `frame-src ${content}`,
    `media-src 'self' data: blob: ${content}`,
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Inserts (or finds) the inline import map. Returns the final HTML and the exact text of the import map script.
 * @param {string} html
 * @param {object} importMap
 * @returns {{ html: string, mapText: string }}
 */
export function withImportMap(html, importMap) {
  const existing = IMPORTMAP_RE.exec(html);
  if (existing) return { html, mapText: existing[1] };
  const mapText = JSON.stringify(importMap);
  const tag = `<script type="importmap">${mapText}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return { html: html.slice(0, at) + tag + html.slice(at), mapText };
  }
  const script = /<script\b/i.exec(html);
  if (script) return { html: html.slice(0, script.index) + tag + html.slice(script.index), mapText };
  return { html: tag + html, mapText };
}

/** Page served when src/ui/index.html does not exist yet. */
const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpecReview</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:15vh auto;padding:0 16px}h1{font-size:20px;margin:0 0 8px}p{color:var(--muted)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head>
<body><main><h1>SpecReview is running</h1>
<p>The reviewer UI is not installed in this build (<code>src/ui/index.html</code> is missing). The daemon, the API and the
document origin are available.</p></main></body></html>
`;

export class UiStatic {
  /**
   * @param {{ uiDir?: string, contentPort: () => number }} opts
   */
  constructor({ uiDir = UI_DIR, contentPort }) {
    this.uiDir = uiDir;
    this.contentPort = contentPort;
    /** @type {{ sig: string, body: Buffer, hashes: string[] } | null} */
    this.cache = null;
  }

  /**
   * GET / and /d/:ws/:doc.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async index(req, res) {
    const page = await this.#page();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(page.body.length),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': uiCsp({ contentPort: this.contentPort(), scriptHashes: page.hashes }),
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : page.body);
  }

  /** @returns {Promise<{ body: Buffer, hashes: string[] }>} */
  async #page() {
    const indexFile = path.join(this.uiDir, 'index.html');
    const mapFile = path.join(this.uiDir, 'importmap.json');
    const sig = `${statSig(indexFile)}|${statSig(mapFile)}`;
    if (this.cache && this.cache.sig === sig) return this.cache;
    let html;
    try {
      html = await fsp.readFile(indexFile, 'utf8');
    } catch {
      html = null;
    }
    if (html === null) {
      this.cache = { sig, body: Buffer.from(PLACEHOLDER, 'utf8'), hashes: [] };
      return this.cache;
    }
    /** @type {object} */
    let map = DEFAULT_IMPORT_MAP;
    try {
      const parsed = JSON.parse(await fsp.readFile(mapFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') map = parsed;
    } catch {
      // no (valid) importmap.json: default map
    }
    const out = withImportMap(html, map);
    this.cache = { sig, body: Buffer.from(out.html, 'utf8'), hashes: inlineScriptHashes(out.html) };
    return this.cache;
  }

  /**
   * GET /ui/<rest>: subresources only. Documents (index.html included) are 404: the SPA page is served by index()
   * alone, with the UI CSP.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string[]} rest decoded segments
   */
  async ui(req, res, rest) {
    const rel = rest.join('/');
    if (!rel || isDeniedPath(rel) || isDocumentType(contentTypeOf(rel))) throw notFound();
    await sendSubresource(req, res, realpathWithin(this.uiDir, rel));
  }

  /**
   * GET /vendor/<rest>: subresources only (same rule as /ui/*).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string[]} rest decoded segments
   */
  async vendor(req, res, rest) {
    const rel = rest.join('/');
    if (!rel || isDocumentType(contentTypeOf(rel))) throw notFound();
    await sendSubresource(req, res, resolveVendor(VENDOR_UI, rel));
  }

  /**
   * GET /ui-shared/protocol.js
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async protocol(req, res) {
    await sendFile(req, res, PROTOCOL_FILE, { contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-cache' });
  }
}

/**
 * Sends a resolved static file unless it is missing or a document type (checked on the real path too, so a
 * symlink named *.js that points at an HTML file is refused as well).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string | null} abs
 */
async function sendSubresource(req, res, abs) {
  if (!abs) throw notFound();
  const contentType = contentTypeOf(abs);
  if (isDocumentType(contentType)) throw notFound();
  await sendFile(req, res, abs, { contentType, cacheControl: 'no-cache' });
}

/**
 * @param {string} file
 * @returns {string}
 */
function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}
