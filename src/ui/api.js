// @ts-check
// HTTP client for the UI origin API (design 10.2 + amendments 6).
//
// - Auth: the SPA is opened as `/...?k=<token>`. `captureToken()` moves the token into sessionStorage and removes
//   it from the address bar; every /api request then carries `Authorization: Bearer <token>`.
// - Connection loss: a network error, a 401, or a 502/503/504 puts the client into "reconnecting" (or
//   "unauthorized" for 401) and polls GET /api/health with backoff until the daemon answers and accepts the token.
//   GET requests are then retried transparently. Mutations are not retried, because they may already have been
//   applied. They reject with an ApiError (`offline: true`), and the caller keeps the user's input so it can be
//   sent again.
// - Listeners: `onConnection(fn)` sees every state change, and `onReconnect(fn)` runs after recovery so the app can
//   refetch its state and reopen the event stream.

const TOKEN_KEY = 'suiko.token';
const REQUEST_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 3000;
/** The daemon's picker gives up after 120 s; the request outlives it so the daemon's answer always arrives. */
const SNIP_SCREEN_TIMEOUT_MS = 150000;

/** @typedef {'ok'|'reconnecting'|'unauthorized'} ConnState */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 = no response)
   * @param {string} message
   * @param {any} [body]
   * @param {boolean} [offline]
   */
  constructor(status, message, body = null, offline = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.offline = offline;
  }
}

/**
 * Moves `?k=` from the URL into sessionStorage (call once at startup). A framed copy of the UI never replaces the
 * tab's token (defense in depth: the daemon already refuses to be framed, SEC-1); it reads ?k= per call instead.
 */
export function captureToken() {
  try {
    if (window.top !== window.self) return;
    const url = new URL(location.href);
    const k = url.searchParams.get('k');
    if (k) {
      sessionStorage.setItem(TOKEN_KEY, k);
      url.searchParams.delete('k');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
  } catch {
    /* sessionStorage unavailable: fall back to reading ?k= on every call */
  }
}

/** @returns {string} */
export function token() {
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) return t;
  } catch {
    /* ignore */
  }
  return new URL(location.href).searchParams.get('k') || '';
}

/** @type {ConnState} */
let conn = 'ok';
/** @type {Set<(s: ConnState) => void>} */
const connListeners = new Set();
/** @type {Set<() => void>} */
const reconnectListeners = new Set();
/** @type {Promise<void>|null} */
let recovering = null;

/** @param {(s: ConnState) => void} fn */
export function onConnection(fn) {
  connListeners.add(fn);
  return () => connListeners.delete(fn);
}

/** @param {() => void} fn */
export function onReconnect(fn) {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

export function connection() {
  return conn;
}

/** @param {ConnState} s */
function setConn(s) {
  if (s === conn) return;
  conn = s;
  for (const fn of [...connListeners]) fn(s);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} ms */
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;
}

function authHeaders() {
  return { authorization: `Bearer ${token()}` };
}

/**
 * Polls the daemon until it is healthy and accepts the token. Resolves once; concurrent callers share the wait.
 * @param {ConnState} reason
 * @returns {Promise<void>}
 */
export function waitForServer(reason = 'reconnecting') {
  setConn(reason);
  if (recovering) return recovering;
  recovering = (async () => {
    let delay = 400;
    for (;;) {
      try {
        const h = await fetch('/api/health', { cache: 'no-store', signal: timeoutSignal(HEALTH_TIMEOUT_MS) });
        if (h.ok) {
          const probe = await fetch('/api/docs', {
            cache: 'no-store', headers: authHeaders(), signal: timeoutSignal(HEALTH_TIMEOUT_MS),
          });
          if (probe.status !== 401) break;
          setConn('unauthorized');
        } else {
          setConn('reconnecting');
        }
      } catch {
        if (conn === 'ok') setConn('reconnecting');
      }
      await sleep(delay);
      delay = Math.min(5000, Math.round(delay * 1.6));
    }
    recovering = null;
    setConn('ok');
    for (const fn of [...reconnectListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('suiko: reconnect listener failed', err);
      }
    }
  })();
  return recovering;
}

/**
 * One quick health + token probe; starts recovery when the daemon is unreachable or rejects the token (used by the
 * event stream on errors).
 */
export async function checkConnection() {
  if (recovering) return;
  try {
    const r = await fetch('/api/health', { cache: 'no-store', signal: timeoutSignal(HEALTH_TIMEOUT_MS) });
    if (!r.ok) {
      waitForServer('reconnecting');
      return;
    }
    const probe = await fetch('/api/docs', { cache: 'no-store', headers: authHeaders(), signal: timeoutSignal(HEALTH_TIMEOUT_MS) });
    if (probe.status === 401) waitForServer('unauthorized');
  } catch {
    waitForServer('reconnecting');
  }
}

/**
 * Sends one API request.
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path absolute path beginning with /api/
 * @param {any} [body] JSON body
 * @param {{ retry?: boolean, timeoutMs?: number }} [opts] retry: retry after reconnecting (default: GET only);
 *   timeoutMs: give up after this long (default 30 s; the screen snip waits for the reviewer to pick an area)
 * @returns {Promise<any>}
 */
export async function request(method, path, body, opts = {}) {
  const retry = opts.retry ?? method === 'GET';
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    if (recovering && retry) await recovering;
    /** @type {Response} */
    let res;
    try {
      /** @type {Record<string, string>} */
      const headers = { ...authHeaders(), accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: timeoutSignal(timeoutMs),
      });
    } catch (err) {
      const wait = waitForServer('reconnecting');
      if (retry && attempt < 5) {
        await wait;
        continue;
      }
      throw new ApiError(0, 'Connection to Suiko lost', null, true);
    }
    if (res.status === 401 || res.status === 502 || res.status === 503 || res.status === 504) {
      const wait = waitForServer(res.status === 401 ? 'unauthorized' : 'reconnecting');
      if (retry && attempt < 5) {
        await wait;
        continue;
      }
      throw new ApiError(res.status, res.status === 401 ? 'Access token rejected' : 'Suiko is unavailable', null, true);
    }
    const text = await res.text();
    /** @type {any} */
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300) };
      }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `${res.status} ${res.statusText}`;
      throw new ApiError(res.status, String(msg), data);
    }
    return data;
  }
}

/** @param {string} s */
const enc = (s) => encodeURIComponent(String(s));

/**
 * A query string of the defined values (file paths go in the query, URL-encoded).
 * @param {Record<string, string|number|undefined|null>} q
 */
function codeQuery(q) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v != null) out.set(k, String(v));
  return out.toString();
}

/**
 * Typed wrappers for every route the UI uses.
 * @param {string} ws
 * @param {string} doc
 */
export function docApi(ws, doc) {
  const base = `/api/docs/${enc(ws)}/${enc(doc)}`;
  return {
    state: () => request('GET', base),
    /** @param {number|'live'} v */
    targets: (v) => request('GET', `${base}/versions/${enc(v)}/targets`),
    /** @param {number|'live'} v @param {number} [from] @param {number} [to] */
    source: (v, from, to) => {
      const q = new URLSearchParams({ v: String(v) });
      if (from != null) q.set('from', String(from));
      if (to != null) q.set('to', String(to));
      return request('GET', `${base}/source?${q}`);
    },
    /** @param {{ version: number, capture: any, widen?: boolean }} body */
    resolveAnchor: (body) => request('POST', `${base}/anchors/resolve`, body, { retry: true }),
    drafts: () => request('GET', `${base}/drafts`),
    /** @param {any} item */
    createDraft: (item) => request('POST', `${base}/drafts`, item),
    /** @param {string} id @param {any} patch */
    patchDraft: (id, patch) => request('PATCH', `${base}/drafts/${enc(id)}`, patch),
    /** @param {string} id */
    deleteDraft: (id) => request('DELETE', `${base}/drafts/${enc(id)}`),
    /**
     * reviewedVersion: the version on screen when the reviewer submitted (the daemon may refuse an approve of a head
     * the reviewer has not seen).
     * @param {{ verdict: string, body: string, markFinal?: boolean, resolveAddressed?: boolean, draftIds?: string[],
     *   reviewedVersion?: number }} body
     */
    submitReview: (body) => request('POST', `${base}/reviews`, body),
    /** @param {string} tid @param {{ decision?: string }} body */
    resolve: (tid, body) => request('POST', `${base}/threads/${enc(tid)}/resolve`, body),
    /** @param {string} tid */
    unresolve: (tid) => request('POST', `${base}/threads/${enc(tid)}/unresolve`, {}),
    /** Accept all: resolves these threads at once. @param {string[]} threads -> {resolved, unchanged} */
    resolveMany: (threads) => request('POST', `${base}/threads/resolve`, { threads }),
    /** The Undo of Accept all. @param {string[]} threads -> {reopened, unchanged} */
    unresolveMany: (threads) => request('POST', `${base}/threads/unresolve`, { threads }),
    /**
     * Accept all revisions: up to `version`, resolving these threads. @param {number} version @param {string[]} threads
     * -> {accepted, previous, resolved, unchanged}
     */
    acceptRevisions: (version, threads) => request('POST', `${base}/revisions/accept`, { version, threads }),
    /**
     * Its Undo. @param {number} version @param {number|null} previous @param {string[]} threads
     * -> {accepted, reopened, unchanged}
     */
    unacceptRevisions: (version, previous, threads) => request('POST', `${base}/revisions/unaccept`, { version, previous, threads }),
    /** @param {string} tid @param {{ version: number, capture: any }} body */
    move: (tid, body) => request('POST', `${base}/threads/${enc(tid)}/move`, body),
    /** @param {string} tid */
    apply: (tid) => request('POST', `${base}/threads/${enc(tid)}/apply`, {}),
    /** @param {string} tid */
    miniDiff: (tid) => request('GET', `${base}/threads/${enc(tid)}/minidiff`),
    /** @param {{ version: number, capture: any, note?: string }} body */
    createLock: (body) => request('POST', `${base}/locks`, body),
    /** @param {string} id */
    deleteLock: (id) => request('DELETE', `${base}/locks/${enc(id)}`),
    /** @param {string} id */
    relock: (id) => request('POST', `${base}/locks/${enc(id)}/relock`, {}),
    /** @param {number} from @param {number|'live'} to */
    diff: (from, to) => request('GET', `${base}/diff?from=${enc(from)}&to=${enc(to)}`),
    /** @param {number} from @param {number|'live'} to */
    sourceDiff: (from, to) => request('GET', `${base}/diff/source?from=${enc(from)}&to=${enc(to)}`),
    /**
     * Code reviews: the files of a round ({v}) or the interdiff file list of two rounds ({from, to}).
     * @param {{ v: number } | { from: number, to: number }} q
     */
    files: (q) => request('GET', `${base}/files?${codeQuery(q)}`),
    /**
     * Code reviews: one file's display hunks in a round ({path, v}) or between two rounds ({path, from, to}).
     * @param {{ path: string, v?: number, from?: number, to?: number, context?: number }} q
     */
    fileDiff: (q) => request('GET', `${base}/files/diff?${codeQuery(q)}`),
    /**
     * Code reviews: one side of one file of a round, as text.
     * @param {string} path @param {number} v @param {'new'|'old'} side
     */
    fileSource: (path, v, side) => request('GET', `${base}/files/source?${codeQuery({ path, v, side })}`),
    /** @param {string} summary */
    record: (summary) => request('POST', `${base}/record`, { summary }),
    /** @param {string} dataUrl */
    attachment: (dataUrl) => request('POST', `${base}/attachments`, { dataUrl }),
    /** @param {string} source */
    fragment: (source) => request('POST', `${base}/fragment`, { source }, { retry: true }),
    /**
     * Runs the macOS region picker (`screencapture -i`) on the reviewer's machine and stores the PNG as an attachment:
     * {path, dataUrl, width, height} | {cancelled: true}. 409 {code: 'busy'} while one is running, 501 {code:
     * 'unsupported'} when the daemon cannot capture the screen. It waits for the reviewer, so it gets a long timeout.
     */
    snipScreen: () => request('POST', `${base}/snip/screen`, {}, { timeoutMs: SNIP_SCREEN_TIMEOUT_MS }),
    close: () => request('POST', `${base}/close`, {}),
  };
}

export const api = {
  health: () => request('GET', '/api/health'),
  docs: () => request('GET', '/api/docs'),
};

/**
 * URL of the SSE stream (EventSource cannot send headers, so the token travels as ?k=).
 * @param {{ ws?: string, doc?: string, lastEventId?: string|null }} p
 */
export function eventsUrl({ ws, doc, lastEventId }) {
  const q = new URLSearchParams();
  if (ws) q.set('ws', ws);
  if (doc) q.set('doc', doc);
  if (lastEventId) q.set('lastEventId', lastEventId);
  q.set('k', token());
  return `/api/events?${q}`;
}
