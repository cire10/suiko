// @ts-check
// UI-origin JSON API (design 10.2 + BUILD_AMENDMENTS 6). Authentication (Host, Bearer token, Origin) happens in
// main.js before a route runs; handlers here validate input, resolve the workspace/doc and call the review engine
// (src/core/review/ops.js, WP3) through Engine, which supplies the per-workspace context. Read-only routes that
// need no engine logic (doc list, drafts, source lines, fragment preview) use the store/render directly, so they
// keep working while the engine is unavailable.
//
// Conventions:
// - Every response is JSON with `Cache-Control: no-store`; errors are {error, code[, details]} with 404 (unknown
//   workspace/doc/item), 409 (conflict/refused, e.g. a dirty working copy), 422 (invalid input), 400 (bad JSON),
//   413 (body too large), 501 (op not implemented by the engine), 503 (engine unavailable), 500 (anything else).
// - Path ids are validated before use (ws = 8 hex, doc = slug, item ids = letter + [A-Za-z0-9_-]); a malformed id
//   is a 404, never an error from deeper layers.
// - Versions are `3`, `v3` or `live` and reach the engine as a number or 'live'.
// - `by` for reviewer actions is the reviewer's display name (string) from the workspace context (ctx.reviewer) or
//   config; the engine turns it into the {kind:'human', name} actor.
// - Screen snips (POST .../snip/screen) run the macOS region picker (`screencapture -i`, via
//   src/core/util/screen-capture.js) on the reviewer's machine and store the image with ops.saveAttachment. At most
//   one picker runs per daemon (409 {code:'busy'}); a cancelled picker (Esc) is 200 {cancelled:true}; no picker on
//   this platform is 501 {code:'unsupported'}. A client that disconnects while the picker is up closes the picker.

import { APP_NAME, LIMITS, VERDICTS } from '../shared/protocol.js';
import { getRender, renderFragment } from '../core/render/index.js';
import { createLogger } from '../core/util/log.js';
import { captureScreenRegion, imageMime } from '../core/util/screen-capture.js';
import { HttpError, invalid, notFound, readJsonBody, sendJson } from './http-util.js';

const log = createLogger('daemon.api');

const ITEM_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_FRAGMENT_CHARS = 1_000_000;

/**
 * @typedef {object} ApiDeps
 * @property {import('./workspaces.js').WorkspaceIndex} index
 * @property {import('./engine.js').Engine} engine
 * @property {import('./sse.js').SseManager} sse
 * @property {string} version package version
 * @property {() => { uiPort: number, contentPort: number }} ports
 * @property {(reason: string) => void} shutdown
 */

/**
 * Registers every /api route on the router.
 * @param {import('./router.js').Router} router
 * @param {ApiDeps} deps
 */
export function registerApiRoutes(router, deps) {
  const { index, engine } = deps;
  const D = '/api/docs/:ws/:doc';

  /**
   * @param {Record<string, string>} params
   * @returns {Promise<{ wsId: string, docId: string, store: import('../core/store/store.js').Store, doc: import('../shared/types.js').Doc }>}
   */
  const resolveDoc = async (params) => {
    const { store, doc } = await index.doc(params.ws, params.doc);
    return { wsId: params.ws, docId: doc.id, store, doc };
  };

  /** @param {string} wsId @param {string} docId */
  const contentBase = (wsId, docId) => `http://127.0.0.1:${deps.ports().contentPort}/c/${index.docKey(wsId, docId)}`;

  /** True while a screen snip's region picker is open (single-flight per daemon). */
  let screenSnipRunning = false;

  // ---------------------------------------------------------------- daemon

  router.get('/api/health', ({ res }) => {
    sendJson(res, 200, { ok: true, name: APP_NAME, version: deps.version, pid: process.pid });
  });

  router.post('/api/shutdown', ({ res }) => {
    res.on('finish', () => setImmediate(() => deps.shutdown('api')));
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/events', async ({ req, res, query }) => {
    await deps.sse.handle(req, res, query);
  });

  // ---------------------------------------------------------------- docs

  router.get('/api/docs', async ({ res }) => {
    /** @type {object[]} */
    const out = [];
    for (const { wsId, root, store } of await index.workspaces()) {
      let allListening = false;
      try {
        allListening = (await store.listWaiters('_all')).length > 0;
      } catch {
        allListening = false;
      }
      for (const doc of await store.listDocs()) {
        try {
          out.push(await docSummary(store, wsId, root, doc, allListening));
        } catch (err) {
          log.warn(`skipping ${wsId}/${doc.id} in the doc list`, err);
        }
      }
    }
    sendJson(res, 200, out);
  });

  router.get(D, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const state = await engine.call('docState', wsId, docId);
    const base = contentBase(wsId, docId);
    // attachmentBase + basename('attachments/a3.png') is the image URL (served by the content origin, see content.js)
    sendJson(res, 200, { ...(state ?? {}), ws: state?.ws ?? wsId, contentBase: base, attachmentBase: `${base}/__att/` });
  });

  router.get(`${D}/versions/:v/targets`, async ({ res, params }) => {
    const { wsId, docId, store, doc } = await resolveDoc(params);
    const v = parseVersion(params.v);
    if (v === undefined) throw invalid('version is required');
    const t = (await engine.call('domTargets', wsId, docId, v)) ?? {};
    let outline = t.outline;
    if (!Array.isArray(outline)) {
      try {
        outline = (await getRender(store, doc, v)).outline ?? [];
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'NOT_FOUND') throw notFound(`version ${params.v} of ${docId} not found`);
        throw err;
      }
    }
    sendJson(res, 200, { ...t, threads: t.threads ?? [], locks: t.locks ?? [], drafts: t.drafts ?? [], outline });
  });

  router.get(`${D}/source`, async ({ res, params, query }) => {
    const { docId, store, doc } = await resolveDoc(params);
    const v = parseVersion(query.get('v')) ?? 'live';
    const text = v === 'live' ? (await store.readWorking(doc)).text : (await store.readVersion(docId, v)).source;
    const all = splitLines(text);
    const from = parseLine(query.get('from'), 1);
    const to = Math.min(parseLine(query.get('to'), all.length), all.length);
    sendJson(res, 200, { v, startLine: from, lines: from <= to ? all.slice(from - 1, to) : [], total: all.length });
  });

  router.post(`${D}/anchors/resolve`, async ({ req, res, params }) => {
    const { wsId, docId, doc } = await resolveDoc(params);
    const body = await readJsonBody(req);
    requireCapture(body.capture);
    optionalBoolean(body.widen, 'widen');
    const version = parseVersion(body.version) ?? defaultVersion(doc);
    /** @type {Record<string, unknown>} */
    const input = { version, capture: body.capture };
    if (typeof body.widen === 'boolean') input.widen = body.widen;
    sendJson(res, 200, await engine.call('resolveCapture', wsId, docId, input));
  });

  // ---------------------------------------------------------------- drafts

  router.get(`${D}/drafts`, async ({ res, params }) => {
    const { docId, store } = await resolveDoc(params);
    sendJson(res, 200, await store.getDrafts(docId));
  });

  router.post(`${D}/drafts`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const { id: _ignored, ...item } = await readJsonBody(req);
    sendJson(res, 200, await engine.call('saveDraft', wsId, docId, item));
  });

  router.patch(`${D}/drafts/:id`, async ({ req, res, params }) => {
    const { wsId, docId, store } = await resolveDoc(params);
    const id = itemId(params.id);
    const { id: _ignored, ...patch } = await readJsonBody(req);
    if (await engine.has('updateDraft')) {
      sendJson(res, 200, await engine.call('updateDraft', wsId, docId, id, patch));
      return;
    }
    const existing = (await store.getDrafts(docId)).items.find((d) => d.id === id);
    if (!existing) throw notFound(`draft ${id} not found`);
    sendJson(res, 200, await engine.call('saveDraft', wsId, docId, { ...existing, ...patch, id, kind: existing.kind }));
  });

  router.delete(`${D}/drafts/:id`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, okResult(await engine.call('deleteDraft', wsId, docId, itemId(params.id))));
  });

  // ---------------------------------------------------------------- reviews and threads

  router.post(`${D}/reviews`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const body = await readJsonBody(req);
    if (!VERDICTS.includes(body.verdict)) throw invalid(`verdict must be one of ${VERDICTS.join(', ')}`);
    optionalString(body.body, 'body');
    optionalBoolean(body.markFinal, 'markFinal');
    optionalBoolean(body.resolveAddressed, 'resolveAddressed');
    if (body.draftIds !== undefined && body.draftIds !== null) {
      if (!Array.isArray(body.draftIds) || !body.draftIds.every((d) => typeof d === 'string' && ITEM_ID_RE.test(d))) {
        throw invalid('draftIds must be an array of draft ids');
      }
    }
    // reviewedVersion (the UI's name) / expectHead: the version the reviewer was looking at. An approval of any
    // other head is refused with 409 by the engine, so a revision recorded meanwhile is never approved unseen.
    optionalVersion(body.reviewedVersion, 'reviewedVersion');
    optionalVersion(body.expectHead, 'expectHead');
    const review = await engine.call('submitReview', wsId, docId, {
      verdict: body.verdict,
      body: body.body ?? '',
      markFinal: Boolean(body.markFinal),
      resolveAddressed: Boolean(body.resolveAddressed),
      draftIds: body.draftIds ?? undefined,
      expectHead: body.expectHead ?? body.reviewedVersion ?? undefined,
      by: await engine.reviewer(wsId),
    });
    sendJson(res, 200, review);
  });

  router.post(`${D}/threads/:tid/resolve`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const body = await readJsonBody(req);
    optionalString(body.decision, 'decision');
    const decision = typeof body.decision === 'string' && body.decision.trim() ? body.decision : undefined;
    sendJson(res, 200, await engine.call('resolveThread', wsId, docId, itemId(params.tid), { by: await engine.reviewer(wsId), decision }));
  });

  router.post(`${D}/threads/:tid/unresolve`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('unresolveThread', wsId, docId, itemId(params.tid), { by: await engine.reviewer(wsId) }));
  });

  router.post(`${D}/threads/:tid/move`, async ({ req, res, params }) => {
    const { wsId, docId, doc } = await resolveDoc(params);
    const tid = itemId(params.tid);
    const body = await readJsonBody(req);
    if (body.capture === undefined && body.lines === undefined && body.quote === undefined) throw invalid('capture is required');
    if (body.capture !== undefined) requireCapture(body.capture);
    const version = parseVersion(body.version) ?? defaultVersion(doc);
    sendJson(res, 200, await engine.call('moveThread', wsId, docId, tid, {
      version,
      capture: body.capture,
      lines: body.lines,
      quote: body.quote,
      by: await engine.reviewer(wsId),
    }));
  });

  router.post(`${D}/threads/:tid/apply`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('applySuggestionAsReviewer', wsId, docId, itemId(params.tid), { by: await engine.reviewer(wsId) }));
  });

  router.get(`${D}/threads/:tid/minidiff`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('threadMiniDiff', wsId, docId, itemId(params.tid)));
  });

  // ---------------------------------------------------------------- locks

  router.post(`${D}/locks`, async ({ req, res, params }) => {
    const { wsId, docId, doc } = await resolveDoc(params);
    const body = await readJsonBody(req);
    requireCapture(body.capture);
    optionalString(body.note, 'note');
    const version = parseVersion(body.version) ?? defaultVersion(doc);
    sendJson(res, 200, await engine.call('addLock', wsId, docId, { version, capture: body.capture, note: body.note, by: await engine.reviewer(wsId) }));
  });

  router.delete(`${D}/locks/:id`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, okResult(await engine.call('removeLock', wsId, docId, itemId(params.id), { by: await engine.reviewer(wsId) })));
  });

  router.post(`${D}/locks/:id/relock`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('relock', wsId, docId, itemId(params.id), { by: await engine.reviewer(wsId) }));
  });

  // ---------------------------------------------------------------- diffs and versions

  router.get(`${D}/diff`, async ({ res, params, query }) => {
    const { wsId, docId, doc } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('changes', wsId, docId, diffRange(doc, query)));
  });

  router.get(`${D}/diff/source`, async ({ res, params, query }) => {
    const { wsId, docId, doc } = await resolveDoc(params);
    sendJson(res, 200, await engine.call('sourceDiffOp', wsId, docId, diffRange(doc, query)));
  });

  router.post(`${D}/record`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const body = await readJsonBody(req);
    optionalString(body.summary, 'summary');
    sendJson(res, 200, await engine.call('recordReviewerVersion', wsId, docId, { summary: body.summary ?? '', by: await engine.reviewer(wsId) }));
  });

  // ---------------------------------------------------------------- attachments, previews, session

  router.post(`${D}/attachments`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    const body = await readJsonBody(req);
    validateImageDataUrl(body.dataUrl);
    const result = await engine.call('saveAttachment', wsId, docId, { dataUrl: body.dataUrl });
    // the UI only needs the doc-relative path ('attachments/a1.png'), never the absolute file path
    sendJson(res, 200, { path: typeof result === 'string' ? result : result?.path });
  });

  // Snip anywhere on screen (key B / the snip-screen button): the reviewer drags a box with the native picker; the
  // image becomes an attachment of the doc. 200 {path, dataUrl, width, height} | 200 {cancelled:true} |
  // 409 {code:'busy'} | 501 {code:'unsupported'}. The request stays open while the picker is up (up to 2 minutes).
  router.post(`${D}/snip/screen`, async ({ req, res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    await readJsonBody(req); // no options yet; drains (and validates) any body
    if (screenSnipRunning) throw new HttpError(409, 'a screen snip is already in progress', { code: 'busy' });
    screenSnipRunning = true;
    // the UI went away (tab closed, request aborted): close the picker instead of leaving it on screen
    const gone = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) gone.abort();
    };
    res.on('close', onClose);
    /** @type {{ png: Buffer, width: number, height: number } | null} */
    let shot;
    try {
      shot = await captureScreenRegion({ signal: gone.signal });
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      const message = /** @type {Error} */ (err)?.message;
      if (code === 'unsupported') throw new HttpError(501, message || 'screen snips are not supported here', { code, cause: err });
      if (code === 'capture_failed') throw new HttpError(500, message || 'the screen capture failed', { code, cause: err });
      throw err;
    } finally {
      screenSnipRunning = false;
      res.off('close', onClose);
    }
    if (gone.signal.aborted || res.destroyed) {
      log.info(`screen snip for ${wsId}/${docId} discarded: the client went away`);
      return;
    }
    if (!shot) {
      sendJson(res, 200, { cancelled: true });
      return;
    }
    const mime = imageMime(shot.png);
    if (!mime) throw new HttpError(500, 'the screen capture is not a PNG or JPEG image', { code: 'capture_failed' });
    const dataUrl = `data:${mime};base64,${shot.png.toString('base64')}`;
    validateImageDataUrl(dataUrl); // 413 above LIMITS.maxAttachmentBytes
    const result = await engine.call('saveAttachment', wsId, docId, { dataUrl });
    const savedPath = typeof result === 'string' ? result : result?.path;
    sendJson(res, 200, { path: savedPath, dataUrl, width: shot.width, height: shot.height });
  });

  router.post(`${D}/fragment`, async ({ req, res, params }) => {
    const { doc } = await resolveDoc(params);
    const body = await readJsonBody(req);
    if (typeof body.source !== 'string') throw invalid('source must be a string');
    if (body.source.length > MAX_FRAGMENT_CHARS) throw new HttpError(413, `source exceeds ${MAX_FRAGMENT_CHARS} characters`);
    sendJson(res, 200, { html: await renderFragment({ format: doc.format, source: body.source }) });
  });

  router.post(`${D}/close`, async ({ res, params }) => {
    const { wsId, docId } = await resolveDoc(params);
    sendJson(res, 200, okResult(await engine.call('closeSession', wsId, docId)));
  });
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * `{ok: true}` plus the fields of an object result (e.g. removeLock's {lock}).
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function okResult(result) {
  return { ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}), ok: true };
}

/**
 * Doc list entry (GET /api/docs).
 * @param {import('../core/store/store.js').Store} store
 * @param {string} wsId
 * @param {string} root
 * @param {import('../shared/types.js').Doc} doc
 * @param {boolean} allListening a live `wait --all` exists in this workspace
 */
async function docSummary(store, wsId, root, doc, allListening) {
  const threads = await store.listThreads(doc.id);
  const reviews = await store.listReviews(doc.id);
  const waiters = await store.listWaiters(doc.id);
  return {
    ws: wsId,
    root,
    id: doc.id,
    path: doc.path,
    // snapshot docs (a plan, an agent message, piped text) have no working file: the UI labels them by origin
    kind: doc.kind === 'snapshot' ? 'snapshot' : 'file',
    origin: doc.kind === 'snapshot' ? doc.origin?.type ?? null : null,
    // a fetched web page: the page URL (the Home list shows its host)
    ...(doc.kind === 'snapshot' && doc.origin?.type === 'url' && typeof doc.origin.url === 'string' ? { source: doc.origin.url } : {}),
    title: doc.title ?? doc.path,
    format: doc.format,
    head: doc.head ?? 0,
    state: doc.state ?? 'in_review',
    openThreads: threads.filter((t) => t.status !== 'resolved').length,
    undelivered: reviews.filter((r) => !r.deliveredTo || Object.keys(r.deliveredTo).length === 0).length,
    listening: allListening || waiters.length > 0,
    final: doc.final ?? null,
  };
}

/**
 * '3' | 'v3' | 3 | 'live' -> 3 | 'live'; undefined for empty; 422 otherwise.
 * @param {unknown} raw
 * @returns {number | 'live' | undefined}
 */
export function parseVersion(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 1) return raw;
    throw invalid(`invalid version: ${raw}`);
  }
  const s = String(raw).trim();
  if (s === 'live') return 'live';
  const m = /^v?([1-9]\d{0,8})$/i.exec(s);
  if (!m) throw invalid(`invalid version: ${s}`);
  return Number(m[1]);
}

/**
 * The version a capture refers to when the client omits it: head, or live before the first version.
 * @param {import('../shared/types.js').Doc} doc
 * @returns {number | 'live'}
 */
function defaultVersion(doc) {
  return doc.head ? doc.head : 'live';
}

/**
 * from/to of a diff: to defaults to head, from to the last reviewed version (or to - 1).
 * @param {import('../shared/types.js').Doc} doc
 * @param {URLSearchParams} query
 * @returns {{ from: number | 'live', to: number | 'live' }}
 */
function diffRange(doc, query) {
  const head = doc.head || 1;
  const to = parseVersion(query.get('to')) ?? head;
  let from = parseVersion(query.get('from'));
  if (from === undefined) {
    const last = doc.lastReviewedVersion;
    if (typeof last === 'number' && last >= 1 && (to === 'live' || last < to)) from = last;
    else from = to === 'live' ? head : Math.max(1, to - 1);
  }
  return { from, to };
}

/**
 * @param {string | undefined} id
 * @returns {string}
 */
function itemId(id) {
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) throw notFound(`unknown id: ${id}`);
  return id;
}

/**
 * @param {unknown} capture
 */
function requireCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture) || typeof (/** @type {any} */ (capture).kind) !== 'string') {
    throw invalid('capture must be an object with a kind');
  }
}

/**
 * @param {unknown} v
 * @param {string} name
 */
function optionalString(v, name) {
  if (v !== undefined && v !== null && typeof v !== 'string') throw invalid(`${name} must be a string`);
}

/**
 * @param {unknown} v
 * @param {string} name
 */
function optionalBoolean(v, name) {
  if (v !== undefined && v !== null && typeof v !== 'boolean') throw invalid(`${name} must be a boolean`);
}

/**
 * @param {unknown} v
 * @param {string} name
 */
function optionalVersion(v, name) {
  if (v !== undefined && v !== null && !(Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1)) {
    throw invalid(`${name} must be a positive integer version`);
  }
}

/**
 * A PNG or JPEG data URL of at most LIMITS.maxAttachmentBytes decoded bytes whose bytes match its type.
 * @param {unknown} dataUrl
 * @returns {{ mime: string, bytes: Buffer }}
 */
export function validateImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw invalid('dataUrl must be a string');
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) throw invalid('dataUrl must be a base64 data:image/png or data:image/jpeg URL');
  if ((m[2].length * 3) / 4 > LIMITS.maxAttachmentBytes + 3) throw new HttpError(413, `attachments are limited to ${LIMITS.maxAttachmentBytes} bytes`);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LIMITS.maxAttachmentBytes) throw new HttpError(413, `attachments are limited to ${LIMITS.maxAttachmentBytes} bytes`);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((m[1] === 'image/png' && !png) || (m[1] === 'image/jpeg' && !jpeg)) throw invalid(`dataUrl bytes are not a valid ${m[1]}`);
  return { mime: m[1], bytes };
}

/**
 * Lines of a source for display (1-based; '\r' of CRLF dropped; a trailing newline does not start a line).
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 1 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * @param {string | null} raw
 * @param {number} def
 * @returns {number}
 */
function parseLine(raw, def) {
  if (raw === null || raw === '') return Math.max(1, def);
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw invalid(`invalid line number: ${raw}`);
  return Number(raw);
}
