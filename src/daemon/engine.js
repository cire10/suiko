// @ts-check
// Access to the review engine (src/core/review/ops.js + context.js, WP3) for the daemon.
// - The engine is injected (`startDaemon({ ops })`, used by tests with a stub) or imported lazily on first use.
//   When it cannot be loaded (not built yet, or a load error), engine-backed routes answer 503
//   {code:'ENGINE_UNAVAILABLE'}; a missing op function answers 501 {code:'NOT_IMPLEMENTED'}. A failed import is
//   retried at most every RETRY_MS so a daemon started before the engine existed recovers by itself.
// - Contexts are created per workspace with `createContext({ root, cwd: root, store })` (the daemon's cached Store)
//   and cached by wsId for CTX_TTL_MS (config edits are picked up after that). When the engine has no createContext (e.g. a test stub), a minimal
//   context is built here: { root, cwd, wsId, store, config, reviewer, agent: null, now(), render(doc, ver) }.

import { getRender } from '../core/render/index.js';
import { createLogger } from '../core/util/log.js';
import { HttpError } from './http-util.js';

const log = createLogger('daemon.engine');

const RETRY_MS = 2_000;
const CTX_TTL_MS = 60_000;

/**
 * @typedef {Record<string, any>} Ops  the ops module namespace (functions taking (ctx, docId, ...))
 * @typedef {(opts: { root: string, cwd: string, store: import('../core/store/store.js').Store }) => Promise<any> | any} CreateContext
 * @typedef {{ ops: Ops, createContext: CreateContext | null }} LoadedEngine
 */

export class Engine {
  /**
   * @param {{ index: import('./workspaces.js').WorkspaceIndex, ops?: Ops | null, createContext?: CreateContext | null,
   *   load?: () => Promise<LoadedEngine> }} opts
   */
  constructor({ index, ops = null, createContext = null, load }) {
    this.index = index;
    /** @type {LoadedEngine | null} */
    this.loaded = ops ? { ops, createContext: createContext ?? (typeof ops.createContext === 'function' ? ops.createContext : null) } : null;
    this.load = load ?? defaultLoad;
    /** @type {Promise<LoadedEngine> | null} */
    this.loading = null;
    this.lastFailureAt = 0;
    /** @type {string} */
    this.lastFailure = '';
    /** @type {Map<string, { ctx: Promise<any>, at: number }>} */
    this.contexts = new Map();
  }

  /**
   * The loaded engine, or HttpError 503.
   * @returns {Promise<LoadedEngine>}
   */
  async engine() {
    if (this.loaded) return this.loaded;
    if (!this.loading) {
      if (this.lastFailureAt && Date.now() - this.lastFailureAt < RETRY_MS) throw this.#unavailable();
      this.loading = this.load().then(
        (e) => {
          this.loaded = e;
          this.loading = null;
          return e;
        },
        (err) => {
          this.loading = null;
          this.lastFailureAt = Date.now();
          this.lastFailure = /** @type {Error} */ (err)?.message ?? String(err);
          log.warn('review engine unavailable', err);
          throw this.#unavailable();
        },
      );
    }
    return this.loading;
  }

  #unavailable() {
    return new HttpError(503, `the review engine is not available${this.lastFailure ? `: ${this.lastFailure}` : ''}`, {
      code: 'ENGINE_UNAVAILABLE',
      headers: { 'Retry-After': '2' },
    });
  }

  /**
   * True when `name` is an op of the loaded engine (loads it if needed; false when unavailable).
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async has(name) {
    try {
      return typeof (await this.engine()).ops[name] === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Context for a workspace (cached).
   * @param {string} wsId
   * @returns {Promise<any>}
   */
  async context(wsId) {
    const now = Date.now();
    const hit = this.contexts.get(wsId);
    if (hit && now - hit.at < CTX_TTL_MS) return hit.ctx;
    const p = (async () => {
      const { createContext } = await this.engine();
      const store = await this.index.store(wsId);
      if (createContext) return createContext({ root: store.root, cwd: store.root, store });
      return minimalContext(store, await this.index.config(wsId));
    })();
    this.contexts.set(wsId, { ctx: p, at: now });
    p.catch(() => this.contexts.delete(wsId));
    return p;
  }

  /**
   * Calls `ops[name](ctx, ...args)` with the workspace's context.
   * @param {string} name
   * @param {string} wsId
   * @param {...unknown} args
   * @returns {Promise<any>}
   */
  async call(name, wsId, ...args) {
    const { ops } = await this.engine();
    const fn = ops[name];
    if (typeof fn !== 'function') {
      throw new HttpError(501, `the review engine does not implement ${name}()`, { code: 'NOT_IMPLEMENTED' });
    }
    const ctx = await this.context(wsId);
    return fn(ctx, ...args);
  }

  /**
   * Reviewer display name for the `by` argument of reviewer ops (the engine expects a name string and builds the
   * {kind:'human', name} actor itself): ctx.reviewer, else config.reviewer.name, else 'reviewer'.
   * @param {string} wsId
   * @returns {Promise<string>}
   */
  async reviewer(wsId) {
    /** @type {any} */
    let ctx = null;
    try {
      ctx = await this.context(wsId);
    } catch {
      // engine unavailable: fall back to the config
    }
    const r = ctx?.reviewer;
    let name = typeof r === 'string' ? r : typeof r?.name === 'string' ? r.name : '';
    if (!name) {
      try {
        name = (await this.index.config(wsId)).reviewer?.name ?? '';
      } catch {
        name = '';
      }
    }
    return name.trim() || 'reviewer';
  }
}

/** @returns {Promise<LoadedEngine>} */
async function defaultLoad() {
  const ops = await import('../core/review/ops.js');
  /** @type {CreateContext | null} */
  let createContext = typeof ops.createContext === 'function' ? ops.createContext : null;
  if (!createContext) {
    try {
      const mod = await import('../core/review/context.js');
      createContext = typeof mod.createContext === 'function' ? mod.createContext : null;
    } catch (err) {
      log.warn('src/core/review/context.js could not be loaded; using a minimal context', err);
    }
  }
  return { ops: { ...ops }, createContext };
}

/**
 * Minimal engine context (stub ops, or an engine without createContext).
 * @param {import('../core/store/store.js').Store} store
 * @param {import('../shared/types.js').Config} config
 */
export function minimalContext(store, config) {
  return {
    root: store.root,
    cwd: store.root,
    wsId: store.wsId,
    store,
    config,
    reviewer: { name: config?.reviewer?.name ?? '' },
    agent: null,
    now: () => new Date(),
    /** @param {import('../shared/types.js').Doc} doc @param {number | 'live'} ver */
    render: (doc, ver) => getRender(store, doc, ver),
  };
}
