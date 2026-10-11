// @ts-check
// Caches the guest bundle (src/guest/build.js buildGuestBundle(), WP6) for /__sr/<RENDERER_VERSION>/guest.js.
// - Production: built once, lazily, on the first request; a failed build is retried after RETRY_MS.
// - Dev (`dev: true` or SPECREVIEW_DEV=1): rebuilt when parts.json or any part changes (mtime/size signature,
//   checked at most every CHECK_MS), so guest edits show up on reload without restarting the daemon.
// When src/guest/build.js is missing or throws, get() throws HttpError 503 (code GUEST_UNAVAILABLE).

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/util/hash.js';
import { createLogger } from '../core/util/log.js';
import { HttpError } from './http-util.js';

const log = createLogger('daemon.guest');

const RETRY_MS = 2_000;
const CHECK_MS = 250;

/**
 * @typedef {{ body: Buffer, etag: string }} GuestBundle
 * @typedef {{ buildGuestBundle: (opts?: { dir?: string }) => string, guestParts?: (dir?: string) => string[], GUEST_PARTS_DIR?: string }} GuestBuilder
 */

export class GuestBundleCache {
  /**
   * @param {{ dev?: boolean, load?: () => Promise<GuestBuilder> }} [opts]
   */
  constructor({ dev = false, load } = {}) {
    this.dev = dev;
    this.load = load ?? (() => import('../guest/build.js'));
    /** @type {GuestBundle | null} */
    this.bundle = null;
    this.signature = '';
    this.checkedAt = 0;
    this.failedAt = 0;
    this.failure = '';
    /** @type {GuestBuilder | null} */
    this.builder = null;
  }

  /**
   * The current bundle.
   * @returns {Promise<GuestBundle>}
   */
  async get() {
    if (this.bundle && !this.dev) return this.bundle;
    if (this.bundle && this.dev) {
      const now = Date.now();
      if (now - this.checkedAt < CHECK_MS) return this.bundle;
      this.checkedAt = now;
      if (this.#signature() === this.signature) return this.bundle;
    }
    if (!this.bundle && this.failedAt && Date.now() - this.failedAt < RETRY_MS) throw this.#unavailable();
    try {
      const builder = this.builder ?? (this.builder = await this.load());
      const text = builder.buildGuestBundle();
      const body = Buffer.from(text, 'utf8');
      this.bundle = { body, etag: `"${sha256(body).slice(0, 32)}"` };
      this.signature = this.#signature();
      this.checkedAt = Date.now();
      this.failure = '';
      return this.bundle;
    } catch (err) {
      this.builder = null;
      this.failedAt = Date.now();
      this.failure = /** @type {Error} */ (err)?.message ?? String(err);
      log.warn('could not build the guest bundle', err);
      if (this.bundle) return this.bundle; // dev: keep serving the last good build
      throw this.#unavailable();
    }
  }

  #unavailable() {
    return new HttpError(503, `the guest bundle is not available${this.failure ? `: ${this.failure}` : ''}`, {
      code: 'GUEST_UNAVAILABLE',
      headers: { 'Retry-After': '2' },
    });
  }

  /** mtime/size signature of parts.json and every listed part ('' when unknown). */
  #signature() {
    const b = this.builder;
    if (!b?.GUEST_PARTS_DIR || typeof b.guestParts !== 'function') return '';
    try {
      const dir = b.GUEST_PARTS_DIR;
      const files = ['parts.json', ...b.guestParts(dir)];
      return files
        .map((name) => {
          const st = fs.statSync(path.join(dir, name));
          return `${name}:${st.size}:${st.mtimeMs}`;
        })
        .join('|');
    } catch {
      return `err:${Date.now()}`;
    }
  }
}
