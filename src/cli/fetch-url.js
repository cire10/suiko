// @ts-check
// The one network path of the CLI besides `install.sh`: `specreview snapshot <url>` (design 6.2, D9). Running the
// command is the consent; nothing else in SpecReview fetches (the daemon and the UI never do).
//
//   networkRefusal(env)       -> string | null   why the network may not be used (SPECREVIEW_OFFLINE=1, or
//                                                  network.allow: false in the user config $SPECREVIEW_HOME/config.json;
//                                                  a workspace's committed config can never turn it on or off)
//   userSnapshotConfig(env)   -> { reader: 'auto' | 'direct' }  the user-level default reader
//   normalizeUrl(u)           -> string   the identity of a page (origin key `url:<normalized>`): scheme and host
//                                         lowercased, default port and fragment dropped, query kept
//   isPublicAddress(ip)       -> boolean  false for loopback, private, link-local, CGNAT, ULA, multicast, reserved,
//                                         documentation and unspecified addresses, and for IPv4-mapped, NAT64,
//                                         6to4 and compatible IPv6 forms of any of them
//   fetchForSnapshot(url, opts) -> { format, text, finalUrl, status, contentType, etag, reader, private, title,
//                                    redirects, fetchedAt }
//
// Fetch rules:
//   - http: and https: only; URLs with user info are refused.
//   - every host (the first one and each redirect target) is resolved with dns.lookup({all: true}); when ANY address
//     is non-public the request is refused unless allowPrivate. The request is then pinned to the checked address
//     through http(s).request({lookup}), so a second DNS answer cannot redirect it (no DNS rebinding window).
//   - redirects are followed by hand (at most maxRedirects), each hop re-checked; the total time (timeoutMs) covers
//     every hop and the body; the body is streamed and capped at maxBytes after decompression (gzip, deflate, br).
//   - reader auto: a github.com .../blob/<ref>/<path>.md page is fetched from raw.githubusercontent.com; a .md or
//     .markdown path, raw.githubusercontent.com and gist.githubusercontent.com are fetched as Markdown; anything
//     else asks for text/markdown, then text/html. reader direct: the URL as given, same content-type rules.
//     reader jina (only when asked): https://r.jina.ai/<url without query and fragment>, which renders the page
//     with JavaScript; refused for a non-public host.
// Errors: RefusedError (exit 3) for policy refusals (offline, non-public host, user info, scheme, too large,
// unsupported type); NotFoundError (exit 4) when the host does not resolve; a NETWORK SpecReviewError (exit 1) for
// connection failures, timeouts, too many redirects and HTTP statuses of 400 and above.

import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { NotFoundError, RefusedError, SpecReviewError, UsageError } from '../core/store/errors.js';
import { homeDir } from '../core/store/home.js';
import { prescanMetaCharset, sniffBom } from '../core/render/charset.js';
import { EXIT, LIMITS } from '../shared/protocol.js';
import { packageVersion } from './daemon-client.js';

/** Longest URL accepted (the origin key must stay under the store's 1024-character limit). */
export const MAX_URL_CHARS = 1000;

export const READERS = Object.freeze(['auto', 'direct', 'jina']);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MD_HOSTS = new Set(['raw.githubusercontent.com', 'gist.githubusercontent.com']);
const MD_PATH_RE = /\.(?:md|markdown)$/i;
const JINA = 'https://r.jina.ai/';

// ------------------------------------------------------------------------------------------------ policy

/**
 * The user-level config file ($SPECREVIEW_HOME/config.json), or {} when it is missing or unreadable.
 * @param {Record<string, string | undefined>} env
 * @returns {{ file: string, config: any }}
 */
function userConfig(env) {
  const home = env.SPECREVIEW_HOME ? path.resolve(env.SPECREVIEW_HOME) : homeDir();
  const file = path.join(home, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, config: config && typeof config === 'object' && !Array.isArray(config) ? config : {} };
  } catch {
    return { file, config: {} };
  }
}

/**
 * Why the network may not be used, or null when it may.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function networkRefusal(env) {
  if (/^(1|true|yes|on)$/i.test(String(env.SPECREVIEW_OFFLINE ?? '').trim())) return 'SPECREVIEW_OFFLINE is set';
  const { file, config } = userConfig(env);
  if (config.network?.allow === false) return `network.allow is false in ${file}`;
  return null;
}

/**
 * The user-level snapshot settings: `snapshot.reader` ("auto" | "direct"; Jina is only ever used per invocation).
 * @param {Record<string, string | undefined>} env
 * @returns {{ reader: 'auto' | 'direct' }}
 */
export function userSnapshotConfig(env) {
  const r = userConfig(env).config.snapshot?.reader;
  return { reader: r === 'direct' ? 'direct' : 'auto' };
}

// ------------------------------------------------------------------------------------------------ URLs

/**
 * Parses and checks a URL a snapshot may fetch (http/https, no user info, not too long).
 * @param {string | URL} input
 * @returns {URL}
 */
export function checkUrl(input) {
  const raw = String(input ?? '').trim();
  if (raw.length > MAX_URL_CHARS) throw new UsageError(`the URL is longer than ${MAX_URL_CHARS} characters`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`not a URL: ${JSON.stringify(raw.slice(0, 200))} (give a full http:// or https:// URL)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RefusedError(`only http:// and https:// URLs can be snapshotted (got ${url.protocol})`, { details: { url: raw } });
  if (url.username || url.password) throw new RefusedError('URLs with a user name or password are refused (credentials would be stored with the snapshot)', { details: { host: url.host } });
  if (!url.hostname) throw new UsageError('the URL has no host');
  return url;
}

/**
 * The identity of a page: WHATWG serialisation (lowercase scheme and host, no default port) without the fragment.
 * @param {string | URL} u
 * @returns {string}
 */
export function normalizeUrl(u) {
  const url = checkUrl(u);
  url.hash = '';
  return url.href;
}

/**
 * github.com/<o>/<r>/blob/<ref>/<path>.md -> raw.githubusercontent.com/<o>/<r>/<ref>/<path>.md (null otherwise).
 * @param {URL} url
 * @returns {URL | null}
 */
export function githubRawUrl(url) {
  if (url.hostname !== 'github.com') return null;
  const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (!m || !MD_PATH_RE.test(m[3])) return null;
  return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
}

// ------------------------------------------------------------------------------------------------ addresses

/**
 * @param {string} s
 * @returns {number | null} the address as an unsigned 32-bit number
 */
function parseIPv4(s) {
  if (!net.isIPv4(s)) return null;
  return s.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

/**
 * @param {string} s
 * @returns {number[] | null} eight 16-bit groups
 */
function parseIPv6(s) {
  if (!net.isIPv6(s)) return null;
  let text = s.toLowerCase();
  // a trailing dotted IPv4 (::ffff:127.0.0.1) becomes two hex groups
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = parseIPv4(v4[1]);
    if (n === null) return null;
    text = `${text.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parse = (/** @type {string} */ part) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parse(halves[0]);
  const rest = halves.length > 1 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array(halves.length > 1 ? fill : 0).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Non-public IPv4 ranges: [base, prefix length]. */
const V4_BLOCKS = /** @type {Array<[string, number]>} */ ([
  ['0.0.0.0', 8], // "this network", 0.0.0.0
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]).map(([base, bits]) => [/** @type {number} */ (parseIPv4(base)), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

/**
 * @param {number} n
 * @returns {boolean}
 */
function isPublicV4(n) {
  return !V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

/**
 * @param {number[]} g
 * @returns {boolean}
 */
function isPublicV6(g) {
  const zeros = (/** @type {number} */ from, /** @type {number} */ to) => g.slice(from, to).every((x) => x === 0);
  const embedded = (/** @type {number} */ hi, /** @type {number} */ lo) => isPublicV4(((hi << 16) | lo) >>> 0);
  if (zeros(0, 8)) return false; // ::
  if (zeros(0, 7) && g[7] === 1) return false; // ::1
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(0, 6)) return embedded(g[6], g[7]); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded(g[6], g[7]); // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4 2002::/16
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo 2001::/32 (tunnels to an arbitrary IPv4)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020)) return false; // ORCHID
  if (g[0] === 0x0100 && zeros(1, 4)) return false; // discard 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

/**
 * Whether an IP address is publicly routable (see the header). Anything that does not parse is not public.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicAddress(ip) {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = parseIPv4(s);
  if (v4 !== null) return isPublicV4(v4);
  const v6 = parseIPv6(s);
  return v6 ? isPublicV6(v6) : false;
}

/**
 * @typedef {(host: string) => Promise<Array<{ address: string, family: number }>>} Lookup
 */

/** @type {Lookup} */
const systemLookup = async (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Resolves a host and applies the address rule.
 * @param {string} hostname URL hostname (an IPv6 literal keeps its brackets)
 * @param {{ lookup: Lookup, allowPrivate: boolean, why?: string }} o
 * @returns {Promise<{ address: string, family: number, private: boolean }>}
 */
async function resolveChecked(hostname, { lookup, allowPrivate, why = '' }) {
  const host = hostname.replace(/^\[|\]$/g, '');
  /** @type {Array<{ address: string, family: number }>} */
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addrs = await lookup(host);
    } catch (err) {
      throw new NotFoundError(`could not resolve ${host} (${/** @type {any} */ (err)?.code ?? /** @type {Error} */ (err)?.message ?? 'DNS error'})`, { details: { host } });
    }
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new NotFoundError(`could not resolve ${host}`, { details: { host } });
  const bad = addrs.filter((a) => !isPublicAddress(a.address));
  if (bad.length && !allowPrivate) {
    throw new RefusedError(
      `refusing to fetch ${host}: it resolves to a non-public address (${bad.map((a) => a.address).join(', ')})${why}. ` +
        'For a page served on your machine or network, pass --allow-private.',
      { details: { host, addresses: bad.map((a) => a.address) } },
    );
  }
  return { address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4, private: bad.length > 0 };
}

// ------------------------------------------------------------------------------------------------ fetch

/**
 * @typedef {object} FetchResult
 * @property {'markdown' | 'html'} format
 * @property {string} text the decoded body (Jina: without its header block)
 * @property {string} finalUrl the page's URL after redirects (for Jina: the page's own URL)
 * @property {number} status
 * @property {string} contentType
 * @property {string | null} etag
 * @property {'auto' | 'direct' | 'jina'} reader
 * @property {boolean} private some address on the way was non-public (allowed by allowPrivate)
 * @property {string} title a title the reader reported ('' when none)
 * @property {number} redirects
 * @property {string} fetchedAt ISO time
 */

/**
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function networkError(message, details = {}) {
  return new SpecReviewError(message, { exit: EXIT.ERROR, code: 'NETWORK', details });
}

/**
 * Fetches a page for a snapshot (see the header).
 * @param {string | URL} input
 * @param {{ reader?: 'auto' | 'direct' | 'jina', allowPrivate?: boolean, maxBytes?: number, timeoutMs?: number,
 *   maxRedirects?: number, lookup?: Lookup, request?: typeof http.request, signal?: AbortSignal, notes?: string[],
 *   now?: () => Date }} [opts]
 * @returns {Promise<FetchResult>}
 */
export async function fetchForSnapshot(input, opts = {}) {
  const {
    reader = 'auto', allowPrivate = false, maxBytes = LIMITS.urlMaxBytes, timeoutMs = LIMITS.urlTimeoutMs,
    maxRedirects = LIMITS.urlMaxRedirects, lookup = systemLookup, request, signal, notes = [], now = () => new Date(),
  } = opts;
  if (!READERS.includes(reader)) throw new UsageError(`unknown reader "${reader}" (expected ${READERS.join(', ')})`);
  const page = checkUrl(input);
  page.hash = '';
  /** @type {URL} */
  let target = page;
  if (reader === 'jina') {
    // the page's own host is checked first: a page on a private network is never sent to a third party
    await resolveChecked(page.hostname, { lookup, allowPrivate: false, why: ' (--reader jina sends the URL to r.jina.ai, so only public pages can use it)' });
    if (page.search) notes.push('--reader jina: the query string was dropped (it is not sent to r.jina.ai)');
    target = new URL(`${JINA}${page.origin}${page.pathname}`);
  } else if (reader === 'auto') {
    const raw = githubRawUrl(page);
    if (raw) target = raw;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timedOut = () => controller.signal.aborted && /** @type {any} */ (controller.signal.reason)?.message === 'timeout';
  try {
    let url = target;
    let anyPrivate = false;
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      const resolved = await resolveChecked(url.hostname, { lookup, allowPrivate: reader !== 'jina' && allowPrivate, why: hop ? ` (redirected from ${target.host})` : '' });
      anyPrivate ||= resolved.private;
      const markdownWanted = reader === 'jina' || MD_HOSTS.has(url.hostname) || MD_PATH_RE.test(url.pathname);
      const headers = {
        'User-Agent': `specreview/${packageVersion()}`,
        Accept: markdownWanted ? 'text/markdown, text/plain;q=0.9, */*;q=0.1' : 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(reader === 'jina' ? { 'X-Return-Format': 'markdown' } : {}),
      };
      let res;
      try {
        res = await send(url, { ...resolved, headers, signal: controller.signal, request });
      } catch (err) {
        if (timedOut()) throw networkError(`timed out after ${Math.round(timeoutMs / 1000)} s fetching ${url.href}`, { url: url.href });
        if (controller.signal.aborted) throw err;
        throw networkError(`could not fetch ${url.href}: ${/** @type {any} */ (err)?.code ?? /** @type {Error} */ (err)?.message}`, { url: url.href });
      }
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status) && res.headers.location) {
        res.resume();
        if (hop >= maxRedirects) throw networkError(`too many redirects (more than ${maxRedirects}) from ${target.href}`, { url: url.href });
        let next;
        try {
          next = new URL(String(res.headers.location), url);
        } catch {
          throw networkError(`invalid redirect from ${url.href}: ${String(res.headers.location).slice(0, 200)}`);
        }
        next.hash = '';
        url = next;
        continue;
      }
      if (status >= 400) {
        res.resume();
        throw networkError(`HTTP ${status}${res.statusMessage ? ` ${res.statusMessage}` : ''} from ${url.href}`, { url: url.href, status });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw networkError(`unexpected HTTP status ${status} from ${url.href}`, { url: url.href, status });
      }
      const contentType = String(res.headers['content-type'] ?? '').trim();
      const mime = contentType.split(';')[0].trim().toLowerCase();
      let body;
      try {
        body = await readBody(res, maxBytes);
      } catch (err) {
        if (timedOut()) throw networkError(`timed out after ${Math.round(timeoutMs / 1000)} s fetching ${url.href}`, { url: url.href });
        throw err;
      }
      const format = formatFor(mime, url, reader, body);
      if (!format) {
        throw new RefusedError(`unsupported content type ${mime ? `"${mime}"` : '(none)'} from ${url.href}: only HTML and Markdown pages can be snapshotted`, { details: { url: url.href, contentType } });
      }
      let text = decodeBody(body, contentType, format);
      let title = '';
      if (reader === 'jina') ({ text, title } = stripJinaHeader(text));
      return {
        format,
        text,
        finalUrl: reader === 'jina' ? page.href : url.href,
        status,
        contentType,
        etag: typeof res.headers.etag === 'string' ? res.headers.etag : null,
        reader,
        private: anyPrivate,
        title,
        redirects: hop,
        fetchedAt: now().toISOString(),
      };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Sends one GET, connecting only to the checked address.
 * @param {URL} url
 * @param {{ address: string, family: number, headers: Record<string, string>, signal: AbortSignal, request?: typeof http.request }} o
 * @returns {Promise<http.IncomingMessage>}
 */
function send(url, { address, family, headers, signal, request }) {
  return new Promise((resolve, reject) => {
    /** @type {any} */
    const pinned = (/** @type {string} */ _host, /** @type {any} */ options, /** @type {Function} */ cb) => {
      const callback = typeof options === 'function' ? options : cb;
      if (options && typeof options === 'object' && options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const send = request ?? (url.protocol === 'https:' ? https.request : http.request);
    const req = send(url, { method: 'GET', headers, lookup: pinned, signal, agent: false });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

/**
 * Reads a response body, decompressing it, and refuses it beyond maxBytes (declared or streamed).
 * @param {http.IncomingMessage} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBody(res, maxBytes) {
  const tooLarge = () => new RefusedError(`the page is larger than ${formatBytes(maxBytes)}`, { details: { maxBytes } });
  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw tooLarge();
  }
  const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  /** @type {NodeJS.ReadableStream} */
  let stream = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
  else if (encoding !== 'identity' && encoding !== '') {
    res.destroy();
    throw networkError(`unsupported content encoding "${encoding}"`);
  }
  if (stream !== res) res.on('error', (err) => /** @type {any} */ (stream).destroy(err));
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) throw tooLarge();
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    res.destroy();
    if (stream !== res) /** @type {any} */ (stream).destroy();
    if (err instanceof RefusedError) throw err;
    if (/** @type {any} */ (err)?.code?.startsWith?.('Z_') || /** @type {any} */ (err)?.code === 'ERR_BROTLI_INVALID_PARAM') throw networkError(`could not decompress the page (${/** @type {any} */ (err).code})`);
    throw err;
  }
  return Buffer.concat(chunks);
}

/**
 * Markdown or HTML from the content type (null: unsupported).
 * @param {string} mime
 * @param {URL} url
 * @param {string} reader
 * @param {Buffer} body
 * @returns {'markdown' | 'html' | null}
 */
function formatFor(mime, url, reader, body) {
  const mdUrl = MD_HOSTS.has(url.hostname) || MD_PATH_RE.test(url.pathname);
  if (reader === 'jina') return !mime || mime.startsWith('text/') ? 'markdown' : null;
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime === 'text/plain') return mdUrl ? 'markdown' : null;
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (!mime) {
    if (mdUrl) return 'markdown';
    const head = body.subarray(0, 512).toString('latin1');
    return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body)\b/i.test(head) ? 'html' : null;
  }
  return null;
}

/**
 * Decodes a body: BOM, else the Content-Type charset, else (HTML) a <meta charset> in the first 1024 bytes, else
 * UTF-8. Unknown labels fall back to UTF-8.
 * @param {Buffer} buf
 * @param {string} contentType
 * @param {'markdown' | 'html'} format
 * @returns {string}
 */
function decodeBody(buf, contentType, format) {
  const bom = sniffBom(buf);
  const declared = /charset\s*=\s*"?([\w.:+-]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? null;
  const label = bom ?? declared ?? (format === 'html' ? prescanMetaCharset(buf) : null) ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(buf);
}

/**
 * r.jina.ai answers with a small header block (Title:, URL Source:, Published Time:, Markdown Content:) before the
 * Markdown: drop it, keep the title.
 * @param {string} text
 * @returns {{ text: string, title: string }}
 */
export function stripJinaHeader(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.slice(0, 30).findIndex((l) => /^Markdown Content:\s*$/.test(l));
  if (at < 0) return { text, title: '' };
  const title = lines.slice(0, at).map((l) => /^Title:\s*(.*)$/.exec(l)?.[1]).find(Boolean) ?? '';
  return { text: lines.slice(at + 1).join('\n').replace(/^\s+/, ''), title: title.trim() };
}

/** @param {number} n */
function formatBytes(n) {
  return n >= 1024 * 1024 ? `${Math.round((n / (1024 * 1024)) * 10) / 10} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
}
