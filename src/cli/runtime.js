// @ts-check
// The Runtime: everything a command needs, built once per invocation by main() (CLI) or per tool call by the MCP
// server. All side-effecting collaborators are injectable so the commands can be tested with a stub engine:
//
//   createRuntime({ ops, createContext, format,            // engine (default: lazy import of src/core/review/*)
//                   ensureDaemon, reviewUrl, openBrowser,  // daemon client (default: ./daemon-client.js)
//                   stdout, stderr, stdin, env, cwd,       // process I/O (defaults: process.*)
//                   signal, heartbeatMs, pollMs, progressMs, // wait tuning (tests shorten the intervals)
//                   startDaemon, startMcp },               // serve --foreground / mcp entry points
//                 { agent, workspace, json, mode })
//
// Also here: workspace/doc resolution shared by every `<doc>` command (design 9.1: `<doc>` is an id or a path).

import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, SuikoError, UsageError } from '../core/store/errors.js';
import { isWithin } from '../core/util/paths.js';
import { isGated } from '../core/store/snapshot.js';
import { loadEngine } from './engine.js';

/**
 * @typedef {import('./engine.js').Engine} Engine
 * @typedef {import('../shared/types.js').DaemonInfo} DaemonInfo
 */

/**
 * @typedef {object} Deps
 * @property {Record<string, any>} [ops]
 * @property {Function} [createContext]
 * @property {Partial<import('./engine.js').Formatters>} [format]
 * @property {(opts?: object) => Promise<DaemonInfo>} [ensureDaemon]
 * @property {(info: DaemonInfo, wsId: string, docId: string) => string} [reviewUrl]
 * @property {(url: string) => Promise<void>} [openBrowser]
 * @property {NodeJS.WritableStream} [stdout]
 * @property {NodeJS.WritableStream} [stderr]
 * @property {NodeJS.ReadableStream} [stdin]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {AbortSignal} [signal] aborts long-running commands (wait); main() wires SIGINT/SIGTERM to it
 * @property {import('node:events').EventEmitter} [signals] source of 'SIGINT'/'SIGTERM' (default: process)
 * @property {number} [heartbeatMs] waiter heartbeat period (default 10 s)
 * @property {number} [pollMs] wait's safety-net poll period (default: the engine's, 2 s)
 * @property {number} [progressMs] MCP progress-notification period (default 15 s)
 * @property {(opts: object) => Promise<any>} [startDaemon] serve --foreground (default: src/daemon/main.js)
 * @property {(deps?: Deps) => Promise<any>} [startMcp] mcp (default: src/mcp/server.js)
 * @property {(opts?: { rotate?: boolean }) => Promise<any>} [stopDaemon] stop (default: daemon-client.js)
 * @property {() => Promise<any>} [daemonStatus] doctor (default: daemon-client.js)
 * @property {string} [claudeHome] install claude --user target (default: $CLAUDE_CONFIG_DIR or ~/.claude)
 */

/**
 * @typedef {object} Runtime
 * @property {() => Promise<Engine>} engine lazily loaded (cached) engine
 * @property {(opts?: object) => Promise<DaemonInfo>} ensureDaemon
 * @property {(info: DaemonInfo, wsId: string, docId: string) => string} reviewUrl
 * @property {(url: string) => Promise<void>} openBrowser
 * @property {NodeJS.WritableStream} stdout
 * @property {NodeJS.WritableStream} stderr
 * @property {NodeJS.ReadableStream} stdin
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 * @property {string} agent
 * @property {string | undefined} workspace --workspace <dir> (resolved against cwd)
 * @property {boolean} json
 * @property {'cli' | 'mcp'} mode
 * @property {AbortSignal | undefined} signal
 * @property {number} heartbeatMs
 * @property {number} progressMs
 * @property {Deps} deps the raw injected deps (serve/mcp/doctor use the extra entry points)
 */

/**
 * @param {Deps} deps
 * @param {{ agent: string, workspace?: string, json?: boolean, mode?: 'cli' | 'mcp' }} opts
 * @returns {Runtime}
 */
export function createRuntime(deps, opts) {
  const cwd = deps.cwd ?? process.cwd();
  /** @type {Promise<Engine> | null} */
  let enginePromise = null;
  /** @type {Promise<typeof import('./daemon-client.js')> | null} */
  let clientPromise = null;
  const client = () => (clientPromise ??= import('./daemon-client.js'));
  return {
    engine: () =>
      (enginePromise ??= loadEngine({
        ops: deps.ops,
        createContext: deps.createContext,
        format: deps.format,
      })),
    ensureDaemon: deps.ensureDaemon ?? (async (o) => (await client()).ensureDaemon(o)),
    reviewUrl:
      deps.reviewUrl ??
      ((info, wsId, docId) =>
        `http://127.0.0.1:${info.uiPort}/d/${encodeURIComponent(wsId)}/${encodeURIComponent(docId)}?k=${encodeURIComponent(info.token)}`),
    openBrowser: deps.openBrowser ?? (async (url) => (await client()).openInSystemBrowser(url)),
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    stdin: deps.stdin ?? process.stdin,
    env: deps.env ?? process.env,
    cwd,
    agent: opts.agent,
    workspace: opts.workspace ? path.resolve(cwd, opts.workspace) : undefined,
    json: Boolean(opts.json),
    mode: opts.mode ?? 'cli',
    signal: deps.signal,
    heartbeatMs: deps.heartbeatMs ?? 10000,
    progressMs: deps.progressMs ?? 15000,
    deps,
  };
}

/**
 * Engine context for a workspace (from --workspace, a file, or the cwd).
 * Passed fields: { cwd, file?, agent, workspace?, root?, create?, createStore? } (root = explicit workspace root;
 * create/createStore = create `.specreview/` when missing, used by `open`).
 * Without a file, an explicit root or `create`, a cwd that has no workspace of its own falls back to the single
 * registered workspace related to it (see relatedWorkspaceRoots); `related: false` turns that off. Several related
 * workspaces are a UsageError naming them.
 * @param {Runtime} rt
 * @param {{ file?: string, create?: boolean, root?: string, related?: boolean }} [opts]
 * @returns {Promise<{ ctx: any, engine: Engine }>}
 */
export async function openContext(rt, opts = {}) {
  const engine = await rt.engine();
  /** @type {Record<string, any>} */
  const args = { cwd: rt.cwd, agent: rt.agent };
  if (opts.file) args.file = opts.file;
  if (rt.workspace) args.workspace = rt.workspace;
  const root = opts.root ?? rt.workspace;
  if (root) args.root = root;
  if (opts.create) {
    args.create = true;
    args.createStore = true; // WP3 createContext option name
  }
  try {
    const ctx = await engine.createContext(args);
    return { ctx, engine };
  } catch (err) {
    // No workspace at/above the cwd. Without git, `.specreview/` lives next to the spec (e.g. docs/), so an agent
    // running from the project root would otherwise miss it: fall back to the single registered workspace below
    // (or above) the cwd.
    if (!(err instanceof NotFoundError) || opts.file || root || opts.create || opts.related === false) throw err;
    const related = await relatedWorkspaceRoots(rt.cwd);
    if (related.length === 0) throw err;
    if (related.length > 1) {
      throw new UsageError(
        `no Suiko workspace at ${rt.cwd}, and several below it (${related.join(', ')}); ` +
          'pass the doc (its file path) or --workspace <dir>',
        { details: { workspaces: related } },
      );
    }
    const ctx = await engine.createContext({ ...args, root: related[0] });
    return { ctx, engine };
  }
}

/**
 * Registered workspaces (see store/home.js) that still exist and whose root is inside the cwd or contains it,
 * nearest first. Other registered workspaces (siblings, other projects) are never related. Paths are compared
 * after realpath (the registry stores real paths; the cwd may come through a symlink such as /tmp on macOS).
 * Nothing is related to the home directory or the filesystem root, which are never workspace roots; with
 * `fromHome`, every registered workspace is a candidate there instead (a doc id named from those directories,
 * where desktop MCP clients start their servers, is looked up everywhere; one hit or an error naming several).
 * @param {string} cwd
 * @param {{ fromHome?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function relatedWorkspaceRoots(cwd, { fromHome = false } = {}) {
  /** @type {Array<{ root: string, exists: boolean }>} */
  let all = [];
  /** @type {(dir: string) => boolean} */
  let forbidden;
  try {
    const [{ listWorkspaces }, { isForbiddenRoot }] = await Promise.all([import('../core/store/home.js'), import('../core/store/workspace.js')]);
    all = await listWorkspaces();
    forbidden = isForbiddenRoot;
  } catch {
    return [];
  }
  const here = realpathOr(cwd);
  if (forbidden(here) || forbidden(path.resolve(cwd))) {
    return fromHome ? all.filter((w) => w.exists).map((w) => w.root).sort() : [];
  }
  const depth = (/** @type {string} */ p) => p.split(path.sep).filter(Boolean).length;
  const distance = (/** @type {string} */ p) => Math.abs(depth(p) - depth(here));
  return all
    .filter((w) => w.exists && (isWithin(here, w.root) || isWithin(w.root, here)))
    .map((w) => w.root)
    .sort((a, b) => distance(a) - distance(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Whether `cwd` is the home directory or the filesystem root (never a workspace root).
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isHomeOrRoot(cwd) {
  try {
    const { isForbiddenRoot } = await import('../core/store/workspace.js');
    return isForbiddenRoot(realpathOr(cwd)) || isForbiddenRoot(path.resolve(cwd));
  } catch {
    return false;
  }
}

/**
 * Resolves `<doc>` (an id or a path) to its workspace context and Doc. Throws NotFoundError (exit 4).
 * A path is resolved from the file (its workspace is discovered from it). An id is looked up in the cwd's own
 * workspace first; when it is not tracked there (or the cwd has none), in the registered workspaces related to the
 * cwd (see relatedWorkspaceRoots), so `suiko wait my-spec` works from the project root while the store is in
 * docs/.specreview. An id tracked in several related workspaces is a UsageError naming them. --workspace disables
 * the fallback.
 * @param {Runtime} rt
 * @param {string} docArg
 * @returns {Promise<{ ctx: any, engine: Engine, doc: any, docId: string }>}
 */
export async function docContext(rt, docArg) {
  const file = existingFile(rt.cwd, docArg);
  /** @type {SuikoError} */
  let notFound;
  // the home directory or the filesystem root is never a workspace: opening one is refused, and the id is looked up
  // in every registered workspace instead
  const fromHome = !file && !rt.workspace && (await isHomeOrRoot(rt.cwd));
  try {
    const { ctx, engine } = await openContext(rt, file ? { file } : { related: false });
    const doc = await resolveDoc(engine, ctx, file ?? docArg, docArg);
    return { ctx, engine, doc, docId: doc.id };
  } catch (err) {
    if (!(err instanceof NotFoundError || (fromHome && err instanceof SuikoError)) || file || rt.workspace) throw err;
    notFound = err;
  }
  const engine = await rt.engine();
  const roots = await relatedWorkspaceRoots(rt.cwd, { fromHome });
  /** @type {Array<{ ctx: any, doc: any }>} */
  const hits = [];
  /** @type {Set<string>} */
  const tracked = new Set();
  for (const root of roots) {
    /** @type {any} */
    let ctx;
    try {
      ctx = await engine.createContext({ cwd: rt.cwd, agent: rt.agent, root });
    } catch {
      continue; // unreadable store: not a candidate
    }
    try {
      hits.push({ ctx, doc: await resolveDoc(engine, ctx, docArg, docArg) });
    } catch {
      for (const id of await listDocIds(ctx)) tracked.add(id); // not tracked there
    }
  }
  if (hits.length === 1) return { ctx: hits[0].ctx, engine, doc: hits[0].doc, docId: hits[0].doc.id };
  if (hits.length > 1) {
    throw new UsageError(
      `doc "${docArg}" is tracked in several workspaces (${hits.map((h) => h.ctx.root ?? h.ctx.store?.root).join(', ')}); pass its file path or --workspace`,
      { details: { doc: docArg, workspaces: hits.map((h) => h.ctx.root ?? h.ctx.store?.root) } },
    );
  }
  if (tracked.size) {
    const ids = [...tracked].sort();
    throw new NotFoundError(`doc not found: ${docArg} (tracked: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''})`, { details: { doc: docArg } });
  }
  throw notFound;
}

/**
 * @param {Engine} engine
 * @param {any} ctx
 * @param {string} key id or absolute path
 * @param {string} shown the argument as the user typed it
 * @returns {Promise<any>}
 */
export async function resolveDoc(engine, ctx, key, shown = key) {
  /** @type {any} */
  let doc = null;
  if (typeof engine.ops.resolveDoc === 'function') {
    doc = await engine.ops.resolveDoc(ctx, key);
  } else if (ctx?.store && typeof ctx.store.findDoc === 'function') {
    doc = await ctx.store.findDoc(key);
  }
  if (!doc) {
    const tracked = await listDocIds(ctx);
    const hint = tracked.length ? ` (tracked: ${tracked.slice(0, 10).join(', ')}${tracked.length > 10 ? ', ...' : ''})` : ' (no docs are tracked here; run `suiko open <file>`)';
    throw new NotFoundError(`doc not found: ${shown}${hint}`, { details: { doc: shown } });
  }
  return doc;
}

/**
 * Ids of the tracked docs of a context's workspace (empty when unknown).
 * @param {any} ctx
 * @param {{ skipGated?: boolean }} [opts] skipGated: leave out plan snapshots (store/snapshot.js isGated)
 * @returns {Promise<string[]>}
 */
export async function listDocIds(ctx, { skipGated = false } = {}) {
  try {
    const docs = ctx?.store?.listDocs ? await ctx.store.listDocs() : [];
    return docs.filter((/** @type {any} */ d) => !skipGated || !isGated(d)).map((/** @type {any} */ d) => d.id);
  } catch {
    return [];
  }
}

/**
 * The id of the workspace's only doc (for tools whose doc argument is optional; plan snapshots, which belong to the
 * plan gate, do not count). Throws NotFoundError when no doc is tracked and UsageError when several are.
 * @param {Runtime} rt
 * @returns {Promise<string>}
 */
export async function defaultDocId(rt) {
  const { ctx } = await openContext(rt);
  const ids = await listDocIds(ctx, { skipGated: true });
  if (ids.length === 1) return ids[0];
  if (!ids.length) throw new NotFoundError('no tracked docs in this workspace; open one first');
  throw new UsageError(`several docs are tracked (${ids.join(', ')}); pass the doc`);
}

/**
 * Calls an engine op by name, with a clear error when the engine lacks it.
 * @param {Engine} engine
 * @param {string} name
 * @param {...any} args
 * @returns {Promise<any>}
 */
export async function callOp(engine, name, ...args) {
  const fn = engine.ops[name];
  if (typeof fn !== 'function') throw new SuikoError(`the review engine does not implement ${name}()`);
  return fn.apply(engine.ops, args);
}

/**
 * The workspace id of a context (ctx.wsId, else ctx.store.wsId).
 * @param {any} ctx
 * @returns {string}
 */
export function wsIdOfContext(ctx) {
  return ctx?.wsId ?? ctx?.store?.wsId ?? '';
}

/**
 * Absolute path when `arg` names an existing regular file (relative to cwd), else null.
 * @param {string} cwd
 * @param {string} arg
 * @returns {string | null}
 */
export function existingFile(cwd, arg) {
  if (!arg) return null;
  const abs = path.resolve(cwd, arg);
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * realpath of a path, else the path resolved (it may not exist).
 * @param {string} p
 * @returns {string}
 */
export function realpathOr(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}
