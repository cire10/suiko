// @ts-check
// Consistent reads of files that another process (the agent's editor) may be writing right now, plus the
// byte <-> text codec used for every spec source in SpecReview.
//
// Decoding rule (all offsets in SpecReview are UTF-16 code units into the decoded string):
//   - UTF-8 BOM (EF BB BF)  -> encoding 'utf8-bom', the BOM is NOT part of the text;
//   - UTF-16 LE/BE BOM      -> encoding 'utf16le' / 'utf16be', BOM stripped;
//   - anything else         -> encoding 'utf8' (other legacy charsets are decoded as UTF-8, lossy).
// Line endings are kept exactly as they are (CRLF stays CRLF). `encodeText(text, encoding)` is the exact inverse
// for valid UTF-8 / UTF-16, so read -> modify -> write preserves the BOM and encoding of the file. For bytes that do
// not decode losslessly (a windows-1252 / latin1 spec: every invalid byte becomes U+FFFD) it is NOT an inverse;
// `roundTrips(buf)` tells, and writers of the user's file must refuse such files (Store.writeWorking does).

import fs from 'node:fs/promises';
import { sha256 } from './hash.js';
import { sleep } from './time.js';

/** @typedef {'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'} TextEncodingName */

/**
 * @typedef {object} StableReadResult
 * @property {Buffer} buf raw bytes
 * @property {string} text decoded text (BOM stripped, line endings untouched)
 * @property {string} sha256 hex digest of `buf` (the raw bytes)
 * @property {number} mtimeMs
 * @property {number} mode permission bits (`stat.mode & 0o7777`)
 * @property {number} size bytes
 * @property {TextEncodingName} encoding
 * @property {boolean} stable false when the file kept changing during every attempt (the last read is returned)
 */

/**
 * Decodes source bytes into text.
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ text: string, encoding: TextEncodingName }}
 */
export function decodeText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le', 2), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    swapPairs(body);
    return { text: body.toString('utf16le'), encoding: 'utf16be' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

/**
 * Byte-swaps a UTF-16 buffer in place; a dangling odd last byte is left as is.
 * @param {Buffer} b
 */
function swapPairs(b) {
  for (let i = 0; i + 1 < b.length; i += 2) {
    const t = b[i];
    b[i] = b[i + 1];
    b[i + 1] = t;
  }
}

/**
 * Encodes text with the given encoding (inverse of decodeText). A text that already starts with U+FEFF is not
 * given a second BOM.
 * @param {string} text
 * @param {TextEncodingName} [encoding='utf8']
 * @returns {Buffer}
 */
export function encodeText(text, encoding = 'utf8') {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
    case 'utf16be': {
      const le = Buffer.from(body, 'utf16le');
      le.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
    }
    default:
      return Buffer.from(text, 'utf8');
  }
}

/**
 * Whether decoding then re-encoding `bytes` reproduces them exactly (false for a legacy-charset file such as
 * windows-1252, whose non-ASCII bytes decode to U+FFFD and would be rewritten as EF BF BD).
 * @param {Buffer | Uint8Array} bytes
 * @returns {boolean}
 */
export function roundTrips(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { text, encoding } = decodeText(buf);
  return encodeText(text, encoding).equals(buf);
}

/**
 * Reads a file so that the bytes, the stat and the hash describe one consistent state: stat, read, stat again,
 * and retry (with a short growing delay) while the size or mtime changed or the byte count disagrees with the
 * stat. After `retries` unstable attempts the last read is returned with `stable: false`.
 * Errors from fs (ENOENT, EISDIR, EACCES...) propagate unchanged.
 * @param {string} abs absolute path
 * @param {{ retries?: number, delayMs?: number }} [opts]
 * @returns {Promise<StableReadResult>}
 */
export async function stableRead(abs, { retries = 5, delayMs = 15 } = {}) {
  /** @type {StableReadResult | null} */
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const before = await fs.stat(abs);
    const buf = await fs.readFile(abs);
    const after = await fs.stat(abs);
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && buf.length === after.size;
    const { text, encoding } = decodeText(buf);
    last = {
      buf,
      text,
      sha256: sha256(buf),
      mtimeMs: after.mtimeMs,
      mode: after.mode & 0o7777,
      size: buf.length,
      encoding,
      stable,
    };
    if (stable) return last;
    if (attempt < retries) await sleep(delayMs * (attempt + 1));
  }
  return /** @type {StableReadResult} */ (last);
}

/**
 * Number of lines in a text: '' -> 0, 'a' -> 1, 'a\n' -> 1, 'a\nb' -> 2. CRLF counts once.
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  if (text === '') return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1;
  return text.endsWith('\n') ? n : n + 1;
}
