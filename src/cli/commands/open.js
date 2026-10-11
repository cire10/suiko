// @ts-check
// `specreview open <file...> [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]`
// (design 3.2 / 9.2, amendments 5).
//
// For each file: find the workspace (refusing $HOME and '/' unless --workspace is given; then the file's directory
// is used), create `.specreview/` there if needed, track the doc and record v1 (engine openDoc), then make sure the
// daemon runs and print the review URL `http://127.0.0.1:<uiPort>/d/<wsId>/<docId>?k=<token>`. Also prints the
// external hosts the doc loads live, and a warning when the working copy differs from head.
// The `next:` hint names the doc the way follow-up commands run from the cwd should: by id when the cwd's own
// workspace is the doc's, else by its path relative to the cwd (which resolves from the file, e.g. when the agent
// runs from the project root and `.specreview/` lives in docs/), else by id with --workspace (see docRef).
// Exit 0; 4 when a file does not exist; 3 for a refused workspace; 1 when the server could not be started (the
// doc is still tracked; the message says so).

import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, UsageError, exitCodeOf } from '../../core/store/errors.js';
import { findWorkspace, initStoreDir } from '../../core/store/workspace.js';
import { formatOfPath } from '../../core/util/paths.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { shellArg } from '../format.js';
import { callOp, openContext, realpathOr, wsIdOfContext } from '../runtime.js';

export const spec = {
  name: 'open',
  usage: 'open <file...> [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: 'Track a spec (recording v1 if it is new), make sure the review server runs, and print the review URL.',
  options: {
    title: { type: 'string' },
    browser: { type: 'string' },
  },
  details: [
    '--browser pane    (default) print the URL for the agent to open in its browser pane',
    '--browser system  also open the URL in the default browser',
    '--browser none    only print the URL',
    '--workspace <dir> choose the workspace root explicitly (required when the root would be $HOME or /)',
  ],
};

const BROWSERS = ['pane', 'system', 'none'];

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @returns {Promise<{ paths: string[], title?: string, browser: 'pane' | 'system' | 'none' }>}
 */
export async function parse({ values, positionals }) {
  expectPositionals('open', positionals, 1, Infinity, spec.usage);
  const browser = values.browser ?? 'pane';
  if (!BROWSERS.includes(browser)) throw new UsageError(`open: --browser must be one of ${BROWSERS.join(', ')}`);
  if (values.title !== undefined && positionals.length > 1) throw new UsageError('open: --title applies to a single file');
  return { paths: positionals, title: values.title, browser };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ paths: string[], title?: string, browser?: 'pane' | 'system' | 'none' }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const browser = input.browser ?? 'pane';
  /** @type {Array<Awaited<ReturnType<typeof trackOne>>>} */
  const tracked = [];
  for (const p of input.paths) tracked.push(await trackOne(rt, p, input.paths.length === 1 ? input.title : undefined));

  /** @type {import('../../shared/types.js').DaemonInfo | null} */
  let info = null;
  /** @type {unknown} */
  let daemonError = null;
  try {
    info = await rt.ensureDaemon();
  } catch (err) {
    daemonError = err;
  }

  /** @type {string[]} */
  const stderr = [];
  /** @type {string[]} */
  const text = [];
  /** @type {any[]} */
  const docsJson = [];
  for (const t of tracked) {
    const url = info ? rt.reviewUrl(info, t.wsId, t.doc.id) : null;
    const ref = await docRef(rt, t);
    text.push(...describe(t, url, daemonError, browser, ref));
    if (url && browser === 'system') {
      try {
        await rt.openBrowser(url);
      } catch (err) {
        stderr.push(`specreview: could not open the system browser: ${/** @type {Error} */ (err).message}`);
      }
    }
    docsJson.push({
      doc: t.doc.id,
      path: t.doc.path,
      format: t.doc.format,
      title: t.doc.title ?? null,
      version: t.version,
      lines: t.lines,
      created: t.created,
      workingDirty: t.workingDirty,
      url,
      wsId: t.wsId,
      root: t.root,
      storeCreated: t.storeCreated,
      externals: t.externalHosts,
      ref,
    });
  }
  if (daemonError) {
    stderr.push(
      `specreview: the review server could not be started: ${/** @type {Error} */ (daemonError).message} ` +
        '(the doc is tracked; run `specreview doctor`)',
    );
  }
  const json = docsJson.length === 1 ? docsJson[0] : { docs: docsJson };
  if (daemonError) Object.assign(json, { error: { message: /** @type {Error} */ (daemonError).message } });
  return { exit: daemonError ? exitCodeOf(daemonError) || EXIT.ERROR : EXIT.OK, text: text.join('\n'), json, stderr };
}

/**
 * Tracks one file and gathers what `describe` prints.
 * @param {import('../runtime.js').Runtime} rt
 * @param {string} p
 * @param {string | undefined} title
 */
async function trackOne(rt, p, title) {
  const abs = path.resolve(rt.cwd, p);
  /** @type {fs.Stats} */
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new NotFoundError(`no such file: ${p}`, { details: { path: abs } });
  }
  if (!st.isFile()) throw new UsageError(`open: not a file: ${p}`);
  if (!formatOfPath(abs)) throw new UsageError(`open: unsupported file type: ${p} (expected .md, .markdown, .html or .htm)`);

  // Workspace discovery happens here (not only in the engine) so the $HOME refusal and --workspace fallback are
  // applied uniformly, and so the store exists before the engine looks for it.
  const ws = await findWorkspace(abs, { create: false, explicitRoot: rt.workspace ?? null });
  const storeCreated = !ws.exists;
  if (storeCreated) await initStoreDir(ws.root);

  const { ctx, engine } = await openContext(rt, { file: abs, create: true, root: ws.root });
  const res = await callOp(engine, 'openDoc', ctx, { path: abs, title });
  const doc = res?.doc;
  if (!doc || !doc.id) throw new Error('engine openDoc returned no doc');
  const version = typeof res.version === 'number' ? res.version : (res.version?.v ?? doc.head ?? 1);
  const lines = typeof res.version === 'object' && typeof res.version?.lines === 'number' ? res.version.lines : countFileLines(abs);
  return {
    doc,
    version,
    lines,
    created: Boolean(res.created),
    workingDirty: Boolean(res.workingDirty),
    wsId: wsIdOfContext(ctx) || ws.wsId,
    root: ws.root,
    storeCreated,
    externalHosts: await externalHosts(ctx, doc, res),
  };
}

/**
 * How follow-up commands (`wait`, `revise`...) run from the cwd should name the doc:
 *   - its id when workspace discovery from the cwd finds the doc's workspace (an id is looked up there first);
 *   - else its path relative to the cwd: a path resolves from the file itself, so it works whatever the cwd's own
 *     workspace and the other registered workspaces are (e.g. the agent runs from the project root while
 *     `.specreview/` lives next to the spec in docs/);
 *   - else (the doc's workspace is not the one discovered from its file, e.g. an explicit --workspace above a
 *     nearer store) the id with `--workspace <root>`.
 * Paths are shell-quoted when needed.
 * @param {import('../runtime.js').Runtime} rt
 * @param {Awaited<ReturnType<typeof trackOne>>} t
 * @returns {Promise<string>}
 */
export async function docRef(rt, t) {
  if (!t.root) return t.doc.id;
  const root = realpathOr(t.root);
  if ((await discoveredRoot(rt.cwd)) === root) return t.doc.id;
  const cwd = realpathOr(rt.cwd);
  const abs = path.resolve(root, String(t.doc.path ?? ''));
  if (t.doc.path && (await discoveredRoot(abs)) === root) return shellArg(path.relative(cwd, abs) || abs);
  return `${t.doc.id} --workspace ${shellArg(path.relative(cwd, root) || '.')}`;
}

/**
 * Root of the existing workspace that discovery finds for a file or directory, else null.
 * @param {string} p
 * @returns {Promise<string | null>}
 */
async function discoveredRoot(p) {
  try {
    const ws = await findWorkspace(p, { create: false });
    return ws.exists ? ws.root : null;
  } catch {
    return null;
  }
}

/**
 * Output lines for one tracked doc.
 * @param {Awaited<ReturnType<typeof trackOne>>} t
 * @param {string | null} url
 * @param {unknown} daemonError
 * @param {string} browser
 * @param {string} ref the doc as follow-up commands from the cwd should name it (see docRef)
 * @returns {string[]}
 */
function describe(t, url, daemonError, browser, ref) {
  const { doc } = t;
  const out = [];
  if (t.created) {
    out.push(`specreview: tracking ${doc.path} as "${doc.id}" (${doc.format}, ${t.lines} lines) · recorded v${t.version}`);
  } else {
    const dirty = t.workingDirty ? ` · working copy differs from v${doc.head ?? t.version} (unrecorded)` : '';
    out.push(`specreview: ${doc.path} is already tracked as "${doc.id}" (head v${doc.head ?? t.version})${dirty}`);
  }
  out.push(url ? `review UI: ${url}` : `review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`);
  if (t.externalHosts.length) {
    out.push(`external hosts loaded live by the doc: ${t.externalHosts.join(', ')} (set render.network to "block" in .specreview/config.json to block them)`);
  }
  if (t.workingDirty) {
    out.push(
      `next: record the unrecorded edits first (\`specreview revise ${ref} --replies -\`, or ask the reviewer to click Record as my revision), then run \`specreview wait ${ref}\` in the background`,
    );
  } else if (browser === 'system') {
    out.push(`next: the URL was opened in the system browser; run \`specreview wait ${ref}\` in the background`);
  } else if (browser === 'none') {
    out.push(`next: run \`specreview wait ${ref}\` in the background`);
  } else {
    out.push(`next: open the URL (browser pane), then run \`specreview wait ${ref}\` in the background`);
  }
  if (t.storeCreated) {
    out.push(
      `created ${path.join(t.root, '.specreview')}/ (commit it with the spec). Recommended .gitattributes lines:`,
      '  .specreview/assets/** binary',
      '  .specreview/docs/*/versions/* linguist-generated=true',
    );
  }
  return out;
}

/**
 * Hosts of the absolute http(s) URLs the doc references (render.externals), sorted. Best effort: [] on failure.
 * @param {any} ctx
 * @param {any} doc
 * @param {any} res
 * @returns {Promise<string[]>}
 */
async function externalHosts(ctx, doc, res) {
  try {
    // the engine reports externals when it renders (a new doc); for a re-open, ask the (cached) live render
    let externals = Array.isArray(res?.externals) && (res.externals.length || res.created) ? res.externals : null;
    if (!externals && typeof ctx?.render === 'function') externals = (await ctx.render(doc, 'live'))?.externals;
    if (!externals && ctx?.store) {
      const { getRender } = await import('../../core/render/index.js');
      externals = (await getRender(ctx.store, doc, 'live')).externals;
    }
    const hosts = new Set();
    for (const u of externals ?? []) {
      try {
        hosts.add(new URL(u).host);
      } catch {
        // not a URL: ignore
      }
    }
    return [...hosts].sort();
  } catch {
    return [];
  }
}

/**
 * @param {string} abs
 * @returns {number}
 */
function countFileLines(abs) {
  try {
    const text = fs.readFileSync(abs, 'utf8');
    if (!text) return 0;
    const n = text.split('\n').length;
    return text.endsWith('\n') ? n - 1 : n;
  } catch {
    return 0;
  }
}
