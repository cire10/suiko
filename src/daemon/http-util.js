// @ts-check
// HTTP plumbing shared by both daemon origins:
// - HttpError (status + stable string code) and errorResponse() mapping store/engine errors to HTTP statuses:
//   NOT_FOUND -> 404, CONFLICT/REFUSED -> 409, USAGE/VALIDATION -> 422, LOCK_TIMEOUT -> 503, anything else -> 500;
// - sendJson / sendText / sendHtml helpers (never any CORS header);
// - readJsonBody with a size limit (400 bad JSON, 413 too large, 422 not an object);
// - sendFile: a regular file with ETag / If-None-Match (304) and a single `Range: bytes=` range (206/416), opened
//   with O_NOFOLLOW so a path validated by realpath cannot be swapped for a symlink at the last component.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { LIMITS } from '../shared/protocol.js';

/** Default maximum JSON request body (attachments are data URLs of at most 5 MB, base64-encoded). */
export const MAX_JSON_BODY = 8 * 1024 * 1024;

const STATUS_CODES = /** @type {Record<number, string>} */ ({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  416: 'RANGE_NOT_SATISFIABLE',
  421: 'MISDIRECTED',
  422: 'VALIDATION',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  503: 'UNAVAILABLE',
});

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{ code?: string, details?: Record<string, unknown>, headers?: Record<string, string>, cause?: unknown }} [opts]
   */
  constructor(status, message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = opts.code ?? STATUS_CODES[status] ?? 'ERROR';
    /** @type {Record<string, unknown> | undefined} */
    this.details = opts.details;
    /** @type {Record<string, string> | undefined} */
    this.headers = opts.headers;
  }
}

/** Shorthand for a 404. @param {string} [what] */
export function notFound(what = 'not found') {
  return new HttpError(404, what, { code: 'NOT_FOUND' });
}

/** Shorthand for a 422 (request understood but invalid). @param {string} message */
export function invalid(message) {
  return new HttpError(422, message, { code: 'VALIDATION' });
}

/**
 * HTTP status and JSON body for any thrown value.
 * @param {unknown} err
 * @returns {{ status: number, body: { error: string, code: string, details?: unknown }, headers: Record<string, string> }}
 */
export function errorResponse(err) {
  const e = /** @type {any} */ (err ?? {});
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  /** @type {Record<string, string>} */
  const headers = { ...(e.headers ?? {}) };
  let status = 500;
  let code = typeof e.code === 'string' ? e.code : 'INTERNAL';
  if (err instanceof HttpError) {
    status = err.status;
  } else if (code === 'NOT_FOUND' || code === 'ENOENT') {
    status = 404;
    code = 'NOT_FOUND';
  } else if (code === 'CONFLICT' || code === 'REFUSED') {
    status = 409;
  } else if (code === 'USAGE' || code === 'VALIDATION' || e.name === 'ZodError' || e instanceof RangeError) {
    status = 422;
    if (code !== 'USAGE') code = 'VALIDATION';
  } else if (code === 'LOCK_TIMEOUT') {
    status = 503;
    headers['Retry-After'] = '1';
  } else if (Number.isInteger(e.status) && e.status >= 400 && e.status <= 599) {
    status = e.status;
  } else {
    code = 'INTERNAL';
  }
  /** @type {{ error: string, code: string, details?: unknown }} */
  const body = { error: message, code };
  if (e.details && typeof e.details === 'object' && Object.keys(e.details).length) body.details = e.details;
  return { status, body, headers };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string>} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} html
 * @param {Record<string, string>} [headers]
 */
export function sendHtml(res, status, html, headers = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Sends a JSON error for any thrown value (UI origin).
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 * @returns {number} the status sent (0 when headers were already sent and the socket was destroyed)
 */
export function sendJsonError(res, err) {
  const { status, body, headers } = errorResponse(err);
  if (res.headersSent) {
    res.destroy();
    return 0;
  }
  sendJson(res, status, body, headers);
  return status;
}

/**
 * Reads and parses a JSON request body. An empty body yields `{}`.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function readJsonBody(req, { limit = MAX_JSON_BODY } = {}) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new HttpError(413, `request body exceeds ${limit} bytes`);
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON', { code: 'BAD_JSON' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('request body must be a JSON object');
  return value;
}

/**
 * Parses a single `bytes=` range against a size. null = no (usable) Range header; 'unsatisfiable' = 416.
 * Multi-range requests are answered with the whole file (allowed by RFC 9110).
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | 'unsatisfiable'}
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * @param {string | undefined} header If-None-Match
 * @param {string} etag
 * @returns {boolean}
 */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
}

/**
 * Streams a regular file. Throws HttpError 404 when it is missing or not a regular file, 413 when it exceeds
 * `maxBytes`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} absPath absolute, already validated path
 * @param {{ contentType: string, cacheControl?: string, etag?: string, headers?: Record<string, string>, maxBytes?: number }} opts
 */
export async function sendFile(req, res, absPath, { contentType, cacheControl = 'no-cache', etag, headers = {}, maxBytes = LIMITS.maxServeBytes }) {
  let fh;
  try {
    fh = await fsp.open(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EISDIR' || code === 'EACCES') throw notFound();
    throw err;
  }
  let handedOff = false;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw notFound();
    if (st.size > maxBytes) throw new HttpError(413, `file is larger than ${maxBytes} bytes`);
    const tag = etag ?? `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    /** @type {Record<string, string>} */
    const base = { 'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: tag, 'Accept-Ranges': 'bytes', ...headers };
    if (etagMatches(/** @type {string | undefined} */ (req.headers['if-none-match']), tag)) {
      res.writeHead(304, base);
      res.end();
      return;
    }
    const range = req.headers['if-range'] && req.headers['if-range'] !== tag ? null : parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    const length = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...base,
      'Content-Length': String(length),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
    });
    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    const stream = fh.createReadStream({ start, end, autoClose: true });
    handedOff = true;
    await new Promise((resolve) => {
      stream.on('error', () => {
        res.destroy();
        resolve(undefined);
      });
      res.on('close', () => {
        stream.destroy();
        resolve(undefined);
      });
      stream.on('end', () => resolve(undefined));
      stream.pipe(res);
    });
  } finally {
    if (!handedOff) await fh.close().catch(() => {});
  }
}
