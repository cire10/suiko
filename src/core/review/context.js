// @ts-check
// Operation context for the review engine (design 4.4): every op in ops.js takes a Ctx as its first argument.
//
// createContext({ cwd, file, root, agent, reviewer, createStore, store }) -> Ctx
//   - store:        an already-open Store (the daemon keeps one per workspace); otherwise
//   - root:         workspace root to open (with `file`, it is the explicit `--workspace` for discovery);
//   - file / cwd:   discovery start (design 5.1: nearest .specreview, git top level, the file's directory);
//   - createStore:  true to create `.specreview/` when missing (`open`), or a factory `(opts) => Promise<Store>`;
//   - agent:        --as name, else $SPECREVIEW_AGENT, else 'claude' when $CLAUDECODE is set, else 'agent';
//   - reviewer:     reviewer display name, else config.reviewer.name.
// Ctx = { store, wsId, root, cwd, agent, reviewer, config, now(), render(doc, ver) }.

import { NotFoundError } from '../store/errors.js';
import { Store } from '../store/store.js';
import { findWorkspace } from '../store/workspace.js';
import { getRender } from '../render/index.js';
import { nowIso } from '../util/time.js';

/**
 * @typedef {import('../../shared/types.js').Config} Config
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {object} Ctx
 * @property {Store} store
 * @property {string} wsId
 * @property {string} root
 * @property {string} cwd
 * @property {string} agent agent name used for delivery receipts, waiters and replies
 * @property {string} reviewer reviewer display name
 * @property {Config} config
 * @property {() => string} now ISO timestamp (injectable clock, see util/time.js)
 * @property {(doc: Doc, ver: number | 'live') => Promise<RenderResult>} render cached render of a version
 */

/**
 * Agent name: explicit, else $SPECREVIEW_AGENT, else 'claude' inside Claude Code, else 'agent'.
 * @param {string | null | undefined} [explicit]
 * @returns {string}
 */
export function resolveAgentName(explicit) {
  const name = explicit || process.env.SPECREVIEW_AGENT || (process.env.CLAUDECODE ? 'claude' : 'agent');
  return String(name).trim() || 'agent';
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string | null} [opts.file]
 * @param {string | null} [opts.root]
 * @param {string | null} [opts.agent]
 * @param {string | null} [opts.reviewer]
 * @param {boolean | ((opts: { root: string | null, file: string | null, cwd: string }) => Promise<Store>)} [opts.createStore]
 * @param {Store} [opts.store]
 * @returns {Promise<Ctx>}
 */
export async function createContext(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const file = opts.file ?? null;
  const root = opts.root ?? null;
  /** @type {Store} */
  let store;
  if (opts.store) {
    store = opts.store;
  } else if (typeof opts.createStore === 'function') {
    store = await opts.createStore({ root, file, cwd });
  } else if (root && !file) {
    store = await Store.open(root, { create: Boolean(opts.createStore) });
  } else {
    const ws = await findWorkspace(file ?? cwd, { create: Boolean(opts.createStore), explicitRoot: root });
    if (!ws.exists) {
      throw new NotFoundError(`no Suiko workspace found for ${file ?? cwd} (run suiko open <file> first)`, {
        details: { path: file ?? cwd },
      });
    }
    store = await Store.open(ws.root, { create: Boolean(opts.createStore) });
  }
  const config = await store.config();
  const reviewer = (opts.reviewer && String(opts.reviewer).trim()) || config.reviewer?.name || 'reviewer';
  return {
    store,
    wsId: store.wsId,
    root: store.root,
    cwd,
    agent: resolveAgentName(opts.agent),
    reviewer,
    config,
    now: () => nowIso(),
    render: (doc, ver) => getRender(store, doc, ver),
  };
}
