// @ts-check
// Hashing helpers shared by the store, the daemon (per-doc capability keys) and the review engine.
// All digests are lowercase hex. Strings are hashed as UTF-8.

import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * SHA-256 of a string (UTF-8) or binary data.
 * @param {string | Buffer | Uint8Array} data
 * @returns {string} 64 lowercase hex characters
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * HMAC-SHA-256 keyed by `key`.
 * Used for docKey = hmacSha256(secret, wsId + '/' + docId).slice(0, 24).
 * @param {string | Buffer | Uint8Array} key
 * @param {string | Buffer | Uint8Array} data
 * @returns {string} 64 lowercase hex characters
 */
export function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Short, stable identifier derived from a hash (e.g. wsId = shortHash(realpath, 8)).
 * @param {string | Buffer | Uint8Array} data
 * @param {number} [length=8]
 * @returns {string}
 */
export function shortHash(data, length = 8) {
  return sha256(data).slice(0, length);
}

/**
 * Cryptographically random lowercase hex string (tokens, secrets, temp-file suffixes).
 * @param {number} [bytes=16]
 * @returns {string} 2 * bytes hex characters
 */
export function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}
