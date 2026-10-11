// @ts-check
// Request-level security for both daemon origins (design 12, BUILD_AMENDMENTS 6):
// - Host allowlist: `127.0.0.1:<port>` or `localhost:<port>` of the server that received the request, else 421
//   (blocks DNS rebinding);
// - Bearer token for /api/* (except /api/health) on the UI origin, compared in constant time;
// - Origin check for non-GET requests on the UI origin: Origin must equal the request's own origin
//   (`http://<Host>`). A request without Origin is accepted only when it carries `Authorization: Bearer`, which a
//   browser cannot attach cross-origin without a CORS preflight (never granted: the daemon sends no CORS headers);
// - request-target parsing that rejects traversal outright: every path segment is percent-decoded once and the
//   request is refused (-> 404) when a decoded segment is '.', '..', empty (except a lone trailing '/' on '/'),
//   or contains '/', '\', or NUL. Nothing is normalised, so `/a/../b` never silently becomes `/b`;
// - anti-framing on the UI origin: every response (static files, API, errors) carries X-Frame-Options: DENY and a
//   CSP with frame-ancestors 'none' (setUiHeaders). Docs on the content origin are same-site with the UI, so a
//   framed UI page would share the reviewer's token and could be clickjacked.

import crypto from 'node:crypto';

/**
 * @typedef {object} RequestTarget
 * @property {string} rawPath the raw path (still percent-encoded), always starting with '/'
 * @property {string[]} segments decoded path segments ('/' -> [])
 * @property {URLSearchParams} query
 */

/**
 * Parses `req.url` safely. Returns null for any unsafe or malformed path.
 * @param {string | undefined} url
 * @returns {RequestTarget | null}
 */
export function parseTarget(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const end = Math.min(q < 0 ? url.length : q, h < 0 ? url.length : h);
  const rawPath = url.slice(0, end);
  const search = q >= 0 ? url.slice(q + 1, h > q ? h : url.length) : '';
  if (rawPath.includes('\\') || /%5c/i.test(rawPath) || rawPath.includes('\0')) return null;
  const parts = rawPath.split('/').slice(1);
  if (parts.length === 1 && parts[0] === '') {
    return { rawPath, segments: [], query: new URLSearchParams(search) };
  }
  /** @type {string[]} */
  const segments = [];
  for (const part of parts) {
    let seg;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!isSafeSegment(seg)) return null;
    segments.push(seg);
  }
  return { rawPath, segments, query: new URLSearchParams(search) };
}

/**
 * A decoded path segment that cannot traverse or smuggle separators.
 * @param {string} seg
 * @returns {boolean}
 */
export function isSafeSegment(seg) {
  return seg !== '' && seg !== '.' && seg !== '..' && !/[/\\\0]/.test(seg);
}

/**
 * Encodes decoded segments back into a URL path ('/a/b%20c').
 * @param {string[]} segments
 * @returns {string}
 */
export function encodeSegments(segments) {
  return `/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

/**
 * Encodes a workspace-relative POSIX path for use in a URL ('docs/my spec.md' -> 'docs/my%20spec.md').
 * @param {string} relPosix
 * @returns {string}
 */
export function encodeRelPath(relPosix) {
  return String(relPosix).split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * The Host header is one of the two loopback names for this server's port.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @returns {boolean}
 */
export function isAllowedHost(req, port) {
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Loopback origins of a port, e.g. for frame-ancestors and data-sr-ui.
 * @param {number} port
 * @returns {string[]}
 */
export function loopbackOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * Bearer token from the Authorization header, or null.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
export function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Constant-time token comparison (hashing first makes the comparison length-independent).
 * @param {string | null | undefined} given
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenEquals(given, expected) {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Origin rule for state-changing requests on the UI origin.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @returns {boolean}
 */
export function isAllowedOrigin(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return bearerToken(req) !== null;
  if (typeof origin !== 'string') return false;
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  const allowed = loopbackOrigins(port);
  return origin.toLowerCase() === `http://${host}` && allowed.includes(origin.toLowerCase());
}

/**
 * Methods that never change state.
 * @param {string | undefined} method
 * @returns {boolean}
 */
export function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Headers every daemon response carries.
 * @param {import('node:http').ServerResponse} res
 * @param {{ referrerPolicy?: string }} [opts]
 */
export function setBaseHeaders(res, { referrerPolicy } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (referrerPolicy) res.setHeader('Referrer-Policy', referrerPolicy);
}

/**
 * Content-Security-Policy of every UI-origin response that does not set its own (only the SPA page does, with
 * the full UI CSP, which also says frame-ancestors 'none'). Nothing on the UI origin may be framed: documents run
 * on the content origin, which is same-site with the UI origin, so a framed UI page would share the reviewer's
 * sessionStorage (token) and could be clickjacked.
 */
export const UI_DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Headers every UI-origin response carries (set before routing, so errors, 404s and API responses get them too):
 * nosniff, Referrer-Policy: no-referrer (the token travels in ?k=), X-Frame-Options: DENY, the default CSP above
 * (a route may replace it with its own, which must keep frame-ancestors 'none'), and
 * Cross-Origin-Resource-Policy: same-origin (documents cannot embed UI-origin resources).
 * @param {import('node:http').ServerResponse} res
 */
export function setUiHeaders(res) {
  setBaseHeaders(res, { referrerPolicy: 'no-referrer' });
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', UI_DEFAULT_CSP);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
