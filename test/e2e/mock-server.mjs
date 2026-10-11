#!/usr/bin/env node
// @ts-check
// E2E / development mock of the SpecReview daemon (WP5) for the reviewer UI (WP7).
//
// Two HTTP servers on 127.0.0.1, like the daemon:
//   UI origin       /, /d/:ws/:doc        src/ui/index.html with the UI CSP (src/ui/csp.js)
//                   /ui/*                 src/ui files
//                   /vendor/*             VENDOR_UI (src/shared/vendor.js)
//                   /ui-shared/protocol.js
//                   /api/*                the design 10.2 + amendments 6 routes, backed by the in-memory MockDoc engine
//                                         (Bearer token, Origin check on non-GET, 401 without a token), plus
//                                         POST .../snip/screen (a fake macOS picker: setScreenSnip picks its outcome)
//                   /api/events           SSE (?k= token, Last-Event-ID / ?lastEventId= replay, reset, ping)
//   content origin  /c/<docKey>/<vN|live>/<doc.path>  the real render (WP2) with the guest bundle (WP6) inserted
//                                         at guestInsertAt (data-sr-ui = the UI origin)
//                   /c/<docKey>/<ver>/<asset>         fixture files (or a version's replaced asset bytes)
//                   /c/<docKey>/__att/<file>          stored attachments (DocState.attachmentBase), not to same-origin
//                                                     requests (the doc's own script), like the daemon
//                   /__sr/<RV>/guest.js | static/* | vendor/*   guest, shell CSS / mermaid init, VENDOR_DOC
//
// Use in tests:   const mock = await startMockServer({ scenario: 'round2' }); ... mock.doc('kitchen-sink').revise(...)
// Run by hand:    node test/e2e/mock-server.mjs [--scenario fresh|round2] [--port 5810]
//                 (prints the review URL with its ?k= token)
// Ports default to 0 (random); never the real daemon ports.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDERER_VERSION } from '../../src/shared/protocol.js';
import { VENDOR_DOC, VENDOR_UI, resolveVendor } from '../../src/shared/vendor.js';
import { finalizeHtml } from '../../src/core/render/index.js';
import { buildGuestBundle } from '../../src/guest/build.js';
import { UI_DIR, uiIndex } from '../../src/ui/csp.js';
import { setUiHeaders } from '../../src/daemon/security.js';
import { isDocumentType } from '../../src/daemon/mime.js';
import { FIXTURE_DIR, buildScenario, makePng } from './mock-data.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROTOCOL_FILE = join(ROOT, 'src', 'shared', 'protocol.js');
const STATIC_DIR = join(ROOT, 'src', 'core', 'render', 'static');

const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

/** @param {string} p */
const mimeOf = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream';

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @returns {Promise<number>}
 */
function listen(server, port) {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const a = server.address();
      ok(typeof a === 'object' && a ? a.port : port);
    });
  });
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = /** @type {any} */ (new Error('invalid JSON body'));
    err.status = 400;
    throw err;
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} file
 * @param {Record<string, string>} [headers]
 */
function sendFile(res, file, headers = {}) {
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'no-store', ...headers });
  res.end(readFileSync(file));
}

/** Joins a URL path under a root directory, refusing traversal and dotfiles. @param {string} root @param {string} rel */
function safeJoin(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.split('/').some((s) => s.startsWith('.'))) return null;
  const abs = normalize(join(root, decoded));
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

/**
 * Starts the mock daemon.
 * @param {{ scenario?: 'fresh'|'round2', uiPort?: number, contentPort?: number, token?: string, quiet?: boolean }} [opts]
 */
export async function startMockServer(opts = {}) {
  const token = opts.token || randomBytes(16).toString('hex');
  let acceptedToken = token;
  const docs = buildScenario(opts.scenario || 'round2');
  /** @type {Map<string, import('./mock-engine.mjs').MockDoc>} */
  const byKey = new Map();
  /** @type {Map<string, string>} */
  const keyOf = new Map();
  for (const d of docs) {
    const k = randomBytes(12).toString('hex');
    byKey.set(k, d);
    keyOf.set(d.id, k);
  }
  const guestBundle = buildGuestBundle();
  const origins = { ui: '', content: '', uiPort: 0, contentPort: 0 };
  /** @type {Array<{ method: string, path: string, body: any, at: number }>} */
  const requests = [];
  /** @type {Set<{ res: import('node:http').ServerResponse, ws: string|null, doc: string|null }>} */
  const sseClients = new Set();
  /** @type {Array<{ method: string, re: RegExp, status: number, times: number }>} */
  const failures = [];
  /**
   * The fake screen picker behind POST .../snip/screen: 'ok' answers a width x height PNG after delayMs, 'cancelled'
   * is the reviewer pressing Esc, 'unsupported' is a daemon that is not on macOS (501), 'error' a failed capture.
   * @type {{ mode: 'ok'|'cancelled'|'unsupported'|'error', delayMs: number, width: number, height: number }}
   */
  const screenSnip = { mode: 'ok', delayMs: 0, width: 320, height: 200 };
  let screenSnipRunning = false;

  // ---------------------------------------------------------------------------------------- SSE

  /** @param {import('node:http').ServerResponse} res @param {any} ev @param {import('./mock-engine.mjs').MockDoc} d */
  const writeEvent = (res, ev, d) => {
    const { seq, ...rest } = ev;
    const data = JSON.stringify({ ...rest, ...(seq ? { seq } : {}), ws: d.ws, doc: d.id });
    res.write(`${seq ? `id: ${seq}\n` : ''}event: ${ev.type}\ndata: ${data}\n\n`);
  };

  for (const d of docs) {
    d.listeners.add((ev, doc) => {
      for (const c of sseClients) {
        if (c.doc && c.doc !== doc.id) continue;
        if (c.ws && c.ws !== doc.ws) continue;
        writeEvent(c.res, c.doc ? ev : { ...ev, seq: undefined }, doc);
      }
    });
  }

  const ping = setInterval(() => {
    for (const c of sseClients) c.res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 25000);
  ping.unref();

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  function openEvents(req, res, url) {
    if (url.searchParams.get('k') !== acceptedToken) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const ws = url.searchParams.get('ws');
    const docId = url.searchParams.get('doc');
    const d = docId ? docs.find((x) => x.id === docId && (!ws || x.ws === ws)) : null;
    if (docId && !d) {
      sendJson(res, 404, { error: 'doc not found' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const client = { res, ws, doc: docId };
    if (d) {
      const lastHeader = req.headers['last-event-id'] || url.searchParams.get('lastEventId');
      const last = lastHeader == null ? null : Number(lastHeader);
      if (last != null && Number.isFinite(last)) {
        const first = d.events[0]?.seq ?? d.seq + 1;
        if (last > d.seq || last < first - 1) res.write(`id: ${d.seq}\nevent: reset\ndata: {}\n\n`);
        else for (const ev of d.events) if (ev.seq > last) writeEvent(res, ev, d);
      } else {
        res.write(`id: ${d.seq}\n\n`);
      }
      writeEvent(res, { type: 'presence', waiters: d.waiters }, d);
      writeEvent(res, { type: 'working.changed', dirty: d.working.dirty, sha256: d.working.sha256 }, d);
    }
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
  }

  // ---------------------------------------------------------------------------------------- API

  /** @param {string} ws @param {string} id */
  const docOf = (ws, id) => {
    const d = docs.find((x) => x.ws === ws && x.id === id);
    if (!d) {
      const err = /** @type {any} */ (new Error(`doc ${ws}/${id} not found`));
      err.status = 404;
      throw err;
    }
    return d;
  };

  /** @param {string|null} s */
  const parseV = (s) => (s === 'live' ? 'live' : s == null || s === '' ? null : Number(String(s).replace(/^v/, '')));

  /**
   * @param {string} method
   * @param {string[]} parts path after /api/docs/:ws/:doc split on '/'
   * @param {import('./mock-engine.mjs').MockDoc} d
   * @param {URL} url
   * @param {any} body
   */
  function docRoute(method, parts, d, url, body) {
    const [a, b, c] = parts;
    if (method === 'GET' && !a) return d.docState();
    if (method === 'GET' && a === 'versions' && c === 'targets') return d.domTargets(/** @type {any} */ (parseV(b)));
    if (method === 'GET' && a === 'source') {
      const v = parseV(url.searchParams.get('v')) ?? 'live';
      const all = d.source(/** @type {any} */ (v)).replace(/\n$/, '').split('\n');
      const from = Number(url.searchParams.get('from') || 1);
      const to = Math.min(Number(url.searchParams.get('to') || all.length), all.length);
      return { v, startLine: from, lines: all.slice(from - 1, to), total: all.length };
    }
    if (method === 'POST' && a === 'anchors' && b === 'resolve') {
      const anchor = d.resolveCapture(Number(body.version || d.head), body.capture, { widen: !!body.widen });
      return { anchor, preview: d.preview(anchor) };
    }
    if (a === 'drafts') {
      if (method === 'GET' && !b) return d.drafts;
      if (method === 'POST' && !b) {
        const { id: _ignored, ...item } = body;
        return d.saveDraft(item);
      }
      if (method === 'PATCH' && b) return d.patchDraft(b, body);
      if (method === 'DELETE' && b) return d.deleteDraft(b);
    }
    if (method === 'POST' && a === 'reviews') return d.submitReview(body);
    if (a === 'threads' && b) {
      if (method === 'POST' && c === 'resolve') return d.resolve(b, body.decision);
      if (method === 'POST' && c === 'unresolve') return d.unresolve(b);
      if (method === 'POST' && c === 'move') return d.move(b, body);
      if (method === 'POST' && c === 'apply') return d.applySuggestion(b);
      if (method === 'GET' && c === 'minidiff') return d.miniDiff(b);
    }
    if (a === 'locks') {
      if (method === 'POST' && !b) return d.addLock(body);
      if (method === 'DELETE' && b && !c) return d.removeLock(b);
      if (method === 'POST' && b && c === 'relock') return d.relock(b);
    }
    if (method === 'GET' && a === 'diff') {
      const to = parseV(url.searchParams.get('to')) ?? d.head;
      const from = Number(url.searchParams.get('from') || Math.max(1, (to === 'live' ? d.head : Number(to)) - 1));
      return b === 'source' ? d.sourceDiff(from, /** @type {any} */ (to)) : d.changes(from, /** @type {any} */ (to));
    }
    if (method === 'POST' && a === 'record') return d.recordWorking(String(body.summary || ''));
    if (method === 'POST' && a === 'attachments') return d.saveAttachment(body.dataUrl);
    if (method === 'POST' && a === 'fragment') return d.fragment(String(body.source || ''));
    if (method === 'POST' && a === 'close') {
      d.doc.state = 'closed';
      d.emit('session.closed');
      return { ok: true };
    }
    const err = /** @type {any} */ (new Error(`no route ${method} ${url.pathname}`));
    err.status = 404;
    throw err;
  }

  /**
   * POST .../snip/screen like the daemon: one picker at a time (409 busy), 501 unsupported, 200 {cancelled:true}, or
   * the stored screenshot {path, dataUrl, width, height}.
   * @param {import('node:http').ServerResponse} res
   * @param {import('./mock-engine.mjs').MockDoc} d
   */
  async function screenSnipRoute(res, d) {
    if (screenSnipRunning) return sendJson(res, 409, { error: 'a screen snip is already in progress', code: 'busy' });
    if (screenSnip.mode === 'unsupported') return sendJson(res, 501, { error: 'screen snips need macOS (screencapture)', code: 'unsupported' });
    screenSnipRunning = true;
    try {
      if (screenSnip.delayMs) await new Promise((ok) => setTimeout(ok, screenSnip.delayMs));
    } finally {
      screenSnipRunning = false;
    }
    if (screenSnip.mode === 'cancelled') return sendJson(res, 200, { cancelled: true });
    if (screenSnip.mode === 'error') return sendJson(res, 500, { error: 'the screen capture failed', code: 'capture_failed' });
    const { width, height } = screenSnip;
    const png = makePng(width, height, (x, y) => [40 + ((x * 3) % 200), 90 + ((y * 2) % 150), 200, 255]);
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const { path } = d.saveAttachment(dataUrl);
    return sendJson(res, 200, { path, dataUrl, width, height });
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  async function handleApi(req, res, url) {
    const method = String(req.method || 'GET');
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'specreview', version: '0.0.0-mock', pid: process.pid });
      return;
    }
    if (url.pathname === '/api/events') {
      openEvents(req, res, url);
      return;
    }
    if (req.headers.authorization !== `Bearer ${acceptedToken}`) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) {
      sendJson(res, 403, { error: 'bad origin' });
      return;
    }
    const body = method === 'GET' ? null : await readJson(req);
    requests.push({ method, path: url.pathname + url.search, body, at: Date.now() });
    const fail = failures.find((f) => f.method === method && f.re.test(url.pathname) && f.times > 0);
    if (fail) {
      fail.times--;
      sendJson(res, fail.status, { error: 'injected failure' });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/docs') {
      sendJson(res, 200, docs.map((d) => ({
        ws: d.ws, root: FIXTURE_DIR, id: d.id, path: d.doc.path, title: d.doc.title, format: d.format, head: d.head,
        state: d.doc.state, openThreads: d.threads.filter((t) => t.status !== 'resolved').length,
        undelivered: d.reviews.filter((r) => !Object.keys(r.deliveredTo).length).length,
        listening: d.waiters.length > 0, final: d.doc.final,
      })));
      return;
    }
    const m = /^\/api\/docs\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const d = docOf(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const parts = (m[3] || '').split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'POST' && parts.length === 2 && parts[0] === 'snip' && parts[1] === 'screen') {
      await screenSnipRoute(res, d);
      return;
    }
    const out = docRoute(method, parts, d, url, body);
    if (method === 'GET' && !parts.length) {
      out.contentBase = d.contentBase;
      out.attachmentBase = `${d.contentBase}/__att/`;
    }
    sendJson(res, 200, out);
  }

  // ---------------------------------------------------------------------------------------- UI origin

  const ui = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${origins.uiPort}` && host !== `localhost:${origins.uiPort}`) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        res.end('misdirected');
        return;
      }
      const url = new URL(req.url || '/', `http://${host}`);
      const p = url.pathname;
      // Like the real daemon (SEC-1): nothing on the UI origin can be framed, and /ui/* and /vendor/* serve no
      // documents (the SPA page comes only from / and /d/:ws/:doc, with its own CSP).
      setUiHeaders(res);
      if (p.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (p === '/' || /^\/d\/[^/]+\/[^/]+\/?$/.test(p)) {
        const { html, csp } = uiIndex({ contentOrigins: [origins.content] });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': csp,
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        });
        res.end(html);
        return;
      }
      if (p === '/ui-shared/protocol.js') return sendFile(res, PROTOCOL_FILE);
      if (p.startsWith('/ui/')) {
        const file = safeJoin(UI_DIR, p.slice(4));
        return file && !isDocumentType(mimeOf(file)) ? sendFile(res, file) : sendJson(res, 404, { error: 'not found' });
      }
      if (p.startsWith('/vendor/')) {
        let rel = '';
        try {
          rel = decodeURIComponent(p.slice(8));
        } catch {
          rel = '';
        }
        const file = resolveVendor(VENDOR_UI, rel);
        return file && !isDocumentType(mimeOf(file)) ? sendFile(res, file) : sendJson(res, 404, { error: 'not found' });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || String(e), ...(e.code ? { code: e.code } : {}) });
      else res.end();
    }
  });

  // ---------------------------------------------------------------------------------------- content origin

  const content = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const base = `/__sr/${RENDERER_VERSION}/`;
    if (p.startsWith(base)) {
      const rest = p.slice(base.length);
      if (rest === 'guest.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(guestBundle);
        return;
      }
      if (rest.startsWith('static/')) {
        const file = safeJoin(STATIC_DIR, rest.slice(7));
        return file ? sendFile(res, file) : sendJson(res, 404, { error: 'not found' });
      }
      if (rest.startsWith('vendor/')) {
        const file = resolveVendor(VENDOR_DOC, decodeURIComponent(rest.slice(7)));
        return file ? sendFile(res, file) : sendJson(res, 404, { error: 'not found' });
      }
    }
    const att = /^\/c\/([0-9a-f]+)\/__att\/([A-Za-z0-9][\w-]*\.(?:png|jpe?g))$/.exec(p);
    if (att) {
      const doc = byKey.get(att[1]);
      const dataUrl = doc?.attachments.get(`attachments/${att[2]}`);
      const parsed = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(dataUrl || '');
      if (!parsed || String(req.headers['sec-fetch-site'] || '') === 'same-origin') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': parsed[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from(parsed[2], 'base64'));
      return;
    }
    const m = /^\/c\/([0-9a-f]+)\/(v\d+|live)\/(.+)$/.exec(p);
    const d = m ? byKey.get(m[1]) : null;
    if (!m || !d) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ver = m[2] === 'live' ? 'live' : Number(m[2].slice(1));
    let rel = '';
    try {
      rel = decodeURIComponent(m[3]);
    } catch {
      rel = '';
    }
    const frameAncestors = `frame-ancestors http://127.0.0.1:${origins.uiPort} http://localhost:${origins.uiPort}`;
    if (rel === d.doc.path) {
      let render;
      try {
        render = d.render(/** @type {any} */ (ver));
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such version');
        return;
      }
      const target = `${d.ws}/${d.id}/${m[2]}`;
      const guestTag = `<script src="${origins.content}/__sr/${RENDERER_VERSION}/guest.js" data-sr-ui="${origins.ui} http://localhost:${origins.uiPort}" data-sr-target="${target}" data-sr-ignore></script>`;
      const html = finalizeHtml(render, { assetBase: `${origins.content}/__sr/${RENDERER_VERSION}`, guestTag });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': frameAncestors,
      });
      res.end(html);
      return;
    }
    const n = ver === 'live' ? d.head : ver;
    const hash = d.assetHashes[n]?.[rel];
    const blob = hash ? d.assetBlobs.get(hash) : null;
    if (blob) {
      res.writeHead(200, { 'content-type': mimeOf(rel), 'cache-control': 'no-store' });
      res.end(blob);
      return;
    }
    const file = safeJoin(FIXTURE_DIR, rel);
    if (file && existsSync(file)) return sendFile(res, file);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  origins.uiPort = await listen(ui, opts.uiPort ?? 0);
  origins.contentPort = await listen(content, opts.contentPort ?? 0);
  origins.ui = `http://127.0.0.1:${origins.uiPort}`;
  origins.content = `http://127.0.0.1:${origins.contentPort}`;
  for (const d of docs) d.contentBase = `${origins.content}/c/${keyOf.get(d.id)}`;

  return {
    token,
    uiOrigin: origins.ui,
    contentOrigin: origins.content,
    docs,
    requests,
    /** @param {string} id */
    doc(id) {
      const d = docs.find((x) => x.id === id);
      if (!d) throw new Error(`no mock doc ${id}`);
      return d;
    },
    /** URL of the SPA (home or a doc) with the ?k= token. @param {string} [docId] */
    url(docId) {
      const d = docId ? this.doc(docId) : null;
      return d ? `${origins.ui}/d/${d.ws}/${d.id}?k=${token}` : `${origins.ui}/?k=${token}`;
    },
    /** Simulates a rotated token (401 everywhere) until restored with null. @param {string|null} t */
    setAcceptedToken(t) {
      acceptedToken = t ?? token;
      if (t) for (const c of sseClients) c.res.end();
    },
    /** Makes the next `times` matching requests fail with `status`. @param {string} method @param {RegExp} re @param {number} status @param {number} [times] */
    failNext(method, re, status, times = 1) {
      failures.push({ method, re, status, times });
    },
    /**
     * How the fake screen picker (POST .../snip/screen) answers from now on.
     * @param {Partial<typeof screenSnip>} opts
     */
    setScreenSnip(opts) {
      Object.assign(screenSnip, opts);
    },
    async close() {
      clearInterval(ping);
      for (const c of sseClients) c.res.end();
      sseClients.clear();
      for (const s of [ui, content]) {
        s.closeAllConnections?.();
        await new Promise((ok) => s.close(() => ok(undefined)));
      }
    },
  };
}

// ------------------------------------------------------------------------------------------ CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg('--port') || 5810);
  const scenario = /** @type {any} */ (arg('--scenario') || 'round2');
  const mock = await startMockServer({ scenario, uiPort: port, contentPort: port + 1, token: arg('--token') });
  console.log(`SpecReview mock (${scenario}) on ${mock.uiOrigin} (content ${mock.contentOrigin})`);
  console.log(`  home:         ${mock.url()}`);
  for (const d of mock.docs) console.log(`  ${d.id.padEnd(13)} ${mock.url(d.id)}`);
  const stop = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
