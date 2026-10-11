// @ts-check
// The daemon's view of the registered workspaces (SPECREVIEW_HOME/workspaces.json) and their docs:
// - wsId -> Store (cached, re-validated after STORE_TTL_MS so moved/deleted workspaces are noticed);
// - per-workspace Config (cached CONFIG_TTL_MS: Store.config() may shell out to `git config user.name`);
// - per-doc capability keys for the content origin (BUILD_AMENDMENTS 6):
//     docKey = hmacSha256(secret, wsId + '/' + docId).slice(0, 24)
//   and the reverse map docKey -> {wsId, docId}, rebuilt on a miss (throttled) because docs appear at any time
//   (the CLI opens docs without talking to the daemon).
// Lookups of unknown workspaces/docs throw HttpError 404.

import { listWorkspaces, workspaceRoot } from '../core/store/home.js';
import { Store } from '../core/store/store.js';
import { hmacSha256 } from '../core/util/hash.js';
import { createLogger } from '../core/util/log.js';
import { notFound } from './http-util.js';

const log = createLogger('daemon.ws');

const STORE_TTL_MS = 30_000;
const CONFIG_TTL_MS = 5_000;
const KEY_REBUILD_MIN_MS = 500;

export const WS_ID_RE = /^[0-9a-f]{8}$/;
export const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export const DOC_KEY_RE = /^[0-9a-f]{24}$/;

/** @typedef {import('../shared/types.js').Doc} Doc */
/** @typedef {import('../shared/types.js').Config} Config */

/**
 * Capability key of a doc on the content origin.
 * @param {string} secret
 * @param {string} wsId
 * @param {string} docId
 * @returns {string}
 */
export function docKeyOf(secret, wsId, docId) {
  return hmacSha256(secret, `${wsId}/${docId}`).slice(0, 24);
}

export class WorkspaceIndex {
  /**
   * @param {{ secret: string }} opts
   */
  constructor({ secret }) {
    /** @readonly */
    this.secret = secret;
    /** @type {Map<string, { store: Promise<Store>, at: number }>} */
    this.stores = new Map();
    /** @type {Map<string, { config: Promise<Config>, at: number }>} */
    this.configs = new Map();
    /** @type {Map<string, { wsId: string, docId: string }>} */
    this.keys = new Map();
    this.keysBuiltAt = 0;
    /** @type {Promise<void> | null} */
    this.rebuilding = null;
  }

  /**
   * Store of a registered workspace (404 when unknown or gone).
   * @param {string} wsId
   * @returns {Promise<Store>}
   */
  async store(wsId) {
    if (typeof wsId !== 'string' || !WS_ID_RE.test(wsId)) throw notFound(`unknown workspace: ${wsId}`);
    const now = Date.now();
    const hit = this.stores.get(wsId);
    if (hit && now - hit.at < STORE_TTL_MS) {
      try {
        return await hit.store;
      } catch {
        // fall through and retry below
      }
    }
    const p = (async () => {
      const root = await workspaceRoot(wsId);
      if (!root) throw notFound(`unknown workspace: ${wsId}`);
      try {
        return await Store.open(root);
      } catch (err) {
        throw notFound(`workspace ${wsId} is not available: ${/** @type {Error} */ (err).message}`);
      }
    })();
    this.stores.set(wsId, { store: p, at: now });
    try {
      return await p;
    } catch (err) {
      this.stores.delete(wsId);
      throw err;
    }
  }

  /**
   * Store + doc (404 when either is unknown).
   * @param {string} wsId
   * @param {string} docId
   * @returns {Promise<{ store: Store, doc: Doc }>}
   */
  async doc(wsId, docId) {
    if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) throw notFound(`unknown doc: ${docId}`);
    const store = await this.store(wsId);
    const doc = await store.getDoc(docId);
    if (!doc) throw notFound(`unknown doc: ${wsId}/${docId}`);
    return { store, doc };
  }

  /**
   * Workspace config, cached briefly.
   * @param {string} wsId
   * @returns {Promise<Config>}
   */
  async config(wsId) {
    const now = Date.now();
    const hit = this.configs.get(wsId);
    if (hit && now - hit.at < CONFIG_TTL_MS) return hit.config;
    const p = this.store(wsId).then((s) => s.config());
    this.configs.set(wsId, { config: p, at: now });
    p.catch(() => this.configs.delete(wsId));
    return p;
  }

  /**
   * @param {string} wsId
   * @param {string} docId
   * @returns {string}
   */
  docKey(wsId, docId) {
    const key = docKeyOf(this.secret, wsId, docId);
    this.keys.set(key, { wsId, docId });
    return key;
  }

  /**
   * Resolves a content-origin capability key (null when no registered doc has it).
   * @param {string} key
   * @returns {Promise<{ wsId: string, docId: string } | null>}
   */
  async resolveDocKey(key) {
    if (typeof key !== 'string' || !DOC_KEY_RE.test(key)) return null;
    const hit = this.keys.get(key);
    if (hit) return hit;
    if (Date.now() - this.keysBuiltAt >= KEY_REBUILD_MIN_MS) await this.#rebuildKeys();
    return this.keys.get(key) ?? null;
  }

  async #rebuildKeys() {
    if (!this.rebuilding) {
      this.rebuilding = (async () => {
        try {
          for (const { wsId, store } of await this.workspaces()) {
            for (const doc of await store.listDocs()) this.docKey(wsId, doc.id);
          }
        } catch (err) {
          log.warn('could not rebuild doc keys', err);
        } finally {
          this.keysBuiltAt = Date.now();
          this.rebuilding = null;
        }
      })();
    }
    await this.rebuilding;
  }

  /**
   * Every registered workspace whose store still exists, with its Store.
   * @returns {Promise<Array<{ wsId: string, root: string, store: Store }>>}
   */
  async workspaces() {
    const out = [];
    for (const ws of await listWorkspaces()) {
      if (!ws.exists) continue;
      try {
        out.push({ wsId: ws.wsId, root: ws.root, store: await this.store(ws.wsId) });
      } catch (err) {
        log.debug(`skipping workspace ${ws.wsId}`, err);
      }
    }
    return out;
  }
}
