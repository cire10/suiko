// @ts-check
// `specreview open <file|dir...> [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]`
// `specreview open - [--title T] [--name N]` (design 3.2 / 9.2, amendments 5).
//
// A directory expands to its .md/.markdown/.html/.htm files, recursively (sorted; dot-directories, node_modules,
// paths isDeniedPath refuses, and symlinks whose target is outside the directory or in such a path are skipped; at
// most 200 files): one line per doc, then the review UI's home URL, which lists them. The directory's workspace is
// found once: a file below it without a store of its own goes to that workspace (one folder, one store).
// `-` reads Markdown from stdin (at most 5 MB) into a snapshot doc (store/snapshot.js, origin type "stdin"): a new
// doc each time, or with --name N the doc of that name (piping the same name again records a new version).
//
// For each file: find the workspace (refusing $HOME and '/' unless --workspace is given; then the file's directory
// is used), create `.specreview/` there if needed, track the doc and record v1 (engine openDoc), then make sure the
// daemon runs and print the review URL `http://127.0.0.1:<uiPort>/d/<wsId>/<docId>?k=<token>`. Also prints the
// external hosts the doc loads live, and a warning when the working copy differs from head.
// The URL opens in the system browser unless --browser (or $SPECREVIEW_BROWSER) says `pane` (print it for the agent
// to show in its built-in browser pane) or `none`.
// The `next:` hint names the doc the way follow-up commands run from the cwd should: by id when the cwd's own
// workspace is the doc's, else by its path relative to the cwd (which resolves from the file, e.g. when the agent
// runs from the project root and `.specreview/` lives in docs/), else by id with --workspace (see docRef).
// Exit 0; 4 when a file does not exist; 3 for a refused workspace; 1 when the server could not be started (the
// doc is still tracked; the message says so).

import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, UsageError, exitCodeOf } from '../../core/store/errors.js';
import { findWorkspace, initStoreDir } from '../../core/store/workspace.js';
import { formatOfPath, isDeniedPath, isWithin } from '../../core/util/paths.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { lineCount, shellArg } from '../format.js';
import { readAllBytes } from '../io.js';
import { decodeText } from '../../core/util/stable-read.js';
import { callOp, openContext, realpathOr, wsIdOfContext } from '../runtime.js';
import {
  MAX_SNAPSHOT_BYTES, defaultTitle, externalsLines, hostsOf, recordSnapshotDoc, scratchNote, showUrl, shownPrefix, snapshotLine,
  snapshotWorkspace,
} from '../snapshot.js';

export const spec = {
  name: 'open',
  usage: 'open <file|dir...> | open - [--name N] [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: 'Track a spec (recording v1 if it is new), make sure the review server runs, and print the review URL.',
  options: {
    title: { type: 'string' },
    browser: { type: 'string' },
    name: { type: 'string' },
  },
  details: [
    '<dir>             every .md/.markdown/.html/.htm file below it (no dot-directories or node_modules; at most 200)',
    '-                 review Markdown piped on stdin (at most 5 MB); a new doc each time unless --name is given',
    '--name N          with -: the doc of that name; piping the same name again records a new version',
    '--browser system  (default) also open the URL in the default browser',
    '--browser pane    print the URL for the agent to open in its built-in browser pane',
    '--browser none    only print the URL',
    '                  $SPECREVIEW_BROWSER=pane|system|none changes the default',
    '--workspace <dir> choose the workspace root explicitly (required when the root would be $HOME or /)',
  ],
};

/** Most files a directory argument opens. */
export const MAX_DIR_FILES = 200;

const BROWSERS = ['pane', 'system', 'none'];

/**
 * --browser, else $SPECREVIEW_BROWSER, else 'system'.
 * @param {string | undefined} flag
 * @param {Record<string, string | undefined>} env
 * @returns {'pane' | 'system' | 'none'}
 */
export function resolveBrowser(flag, env) {
  if (flag !== undefined) {
    if (!BROWSERS.includes(flag)) throw new UsageError(`open: --browser must be one of ${BROWSERS.join(', ')}`);
    return /** @type {'pane' | 'system' | 'none'} */ (flag);
  }
  const fromEnv = env.SPECREVIEW_BROWSER?.trim();
  if (!fromEnv) return 'system';
  if (!BROWSERS.includes(fromEnv)) throw new UsageError(`open: SPECREVIEW_BROWSER must be one of ${BROWSERS.join(', ')} (got "${fromEnv}")`);
  return /** @type {'pane' | 'system' | 'none'} */ (fromEnv);
}

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<{ paths: string[], title?: string, browser: 'pane' | 'system' | 'none' }>}
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('open', positionals, 1, Infinity, spec.usage);
  const browser = resolveBrowser(/** @type {string | undefined} */ (values.browser), rt.env);
  const stdin = positionals.includes('-');
  if (stdin && positionals.length > 1) throw new UsageError("open: '-' (read stdin) cannot be combined with other paths");
  const name = /** @type {string | undefined} */ (values.name);
  if (name !== undefined) {
    if (!stdin) throw new UsageError('open: --name applies to piped text (`specreview open - --name N`)');
    if (!name.trim() || name.length > 200 || /[\0-\x1f]/.test(name)) throw new UsageError('open: --name must be a short single-line name');
  }
  if (values.title !== undefined && positionals.length > 1) throw new UsageError('open: --title applies to a single file');
  return { paths: positionals, title: values.title, browser, ...(stdin ? { stdin: true, name: name?.trim() } : {}) };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ paths: string[], title?: string, browser?: 'pane' | 'system' | 'none', stdin?: boolean, name?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const browser = input.browser ?? resolveBrowser(undefined, rt.env);
  if (input.stdin) return openStdin(rt, input, browser);
  const expanded = expandPaths(rt.cwd, input.paths);
  if (input.title !== undefined && expanded.files.length > 1) throw new UsageError('open: --title applies to a single file');
  /** @type {Array<Awaited<ReturnType<typeof trackOne>>>} */
  const tracked = [];
  /** @type {Map<string, string | null>} directory argument -> its workspace root (null: refused, decided per file) */
  const dirRoots = new Map();
  for (const f of expanded.files) {
    let root = null;
    if (f.dir && !rt.workspace) {
      if (!dirRoots.has(f.dir)) dirRoots.set(f.dir, await dirWorkspace(f.dir));
      root = dirRoots.get(f.dir) ?? null;
    }
    tracked.push(await trackOne(rt, f.path, expanded.files.length === 1 ? input.title : undefined, root));
  }
  if (expanded.dirs) return folderResult(rt, tracked, expanded, browser);

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
    let shown = browser;
    if (url && browser === 'system') {
      try {
        await rt.openBrowser(url);
      } catch (err) {
        stderr.push(`specreview: could not open the system browser: ${/** @type {Error} */ (err).message}`);
        shown = 'failed';
      }
    }
    text.push(...describe(t, url, daemonError, shown, ref));
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
 * @typedef {{ dot: number, nodeModules: number, denied: number, symlinks: number, overCap: number }} Skipped
 */

/**
 * Expands directory arguments to their spec files (see the header); files are kept as given. Each file appears once
 * (by real path), also when arguments overlap; `dir` is the absolute directory argument a file was found in.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ files: Array<{ path: string, dir: string | null }>, dirs: number, skipped: Skipped }}
 */
export function expandPaths(cwd, args) {
  /** @type {Array<{ path: string, dir: string | null }>} */
  const files = [];
  /** @type {Skipped} */
  const skipped = { dot: 0, nodeModules: 0, denied: 0, symlinks: 0, overCap: 0 };
  /** @type {Set<string>} */
  const seen = new Set();
  let dirs = 0;
  let collected = 0;
  /** spec files found under the current directory argument, duplicates included */
  let hits = 0;
  for (const arg of args) {
    const abs = path.resolve(cwd, arg);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      files.push({ path: arg, dir: null }); // trackOne reports it (not found)
      continue;
    }
    if (!st.isDirectory()) {
      const real = realpathOr(abs);
      if (seen.has(real)) continue;
      seen.add(real);
      files.push({ path: arg, dir: null });
      continue;
    }
    dirs += 1;
    hits = 0;
    walkDir(realpathOr(abs), abs, '', (file) => {
      hits += 1;
      const real = realpathOr(file);
      if (seen.has(real)) return;
      seen.add(real);
      if (collected >= MAX_DIR_FILES) {
        skipped.overCap += 1;
        return;
      }
      collected += 1;
      files.push({ path: file, dir: abs });
    }, skipped);
    if (!hits) throw new UsageError(`open: no .md, .markdown, .html or .htm files in ${arg}`, { details: { path: abs } });
  }
  return { files, dirs, skipped };
}

/**
 * Collects the spec files below `dir` (sorted, depth first). A symlinked file counts only when its target is a spec
 * file inside the expanded directory and not in a path the walk skips (dot segment, node_modules, denied); symlinked
 * directories are never followed.
 * @param {string} realRoot realpath of the expanded directory
 * @param {string} dir directory being listed
 * @param {string} rel its path relative to the expanded directory (POSIX, '' for the root)
 * @param {(abs: string) => void} add
 * @param {Skipped} skipped
 */
function walkDir(realRoot, dir, rel, add, skipped) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.startsWith('.')) {
      if (e.isDirectory()) skipped.dot += 1;
      continue;
    }
    if (e.isDirectory()) {
      if (e.name === 'node_modules') skipped.nodeModules += 1;
      else if (isDeniedPath(r)) skipped.denied += 1;
      else walkDir(realRoot, abs, r, add, skipped);
      continue;
    }
    if (!formatOfPath(e.name)) continue;
    if (isDeniedPath(r)) {
      skipped.denied += 1;
      continue;
    }
    if (e.isSymbolicLink()) {
      if (!symlinkTargetOk(realRoot, abs)) {
        skipped.symlinks += 1;
        continue;
      }
    } else if (!e.isFile()) {
      continue;
    }
    add(abs);
  }
}

/**
 * Whether a symlinked file may be opened as part of the directory: its target is a regular spec file inside the
 * directory, and the target's own path (relative to the directory) passes the same rules as walked files.
 * @param {string} realRoot
 * @param {string} link
 * @returns {boolean}
 */
function symlinkTargetOk(realRoot, link) {
  let real;
  try {
    real = fs.realpathSync(link);
    if (!fs.statSync(real).isFile()) return false;
  } catch {
    return false; // dangling
  }
  if (!isWithin(realRoot, real) || !formatOfPath(real)) return false;
  const rel = path.relative(realRoot, real).split(path.sep).join('/');
  if (rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules')) return false;
  return !isDeniedPath(rel);
}

/**
 * The workspace root of a directory argument: the root discovery finds for the directory itself (an enclosing
 * store or git root, else the directory). null when discovery is refused ($HOME, /): each file then decides (and
 * reports the refusal) as before.
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function dirWorkspace(dir) {
  try {
    return (await findWorkspace(dir, { create: false })).root;
  } catch {
    return null;
  }
}

/**
 * `skipped: ...` for the folder output ('' when nothing was skipped).
 * @param {Skipped} s
 * @returns {string}
 */
function skippedLine(s) {
  const parts = [];
  if (s.overCap) parts.push(`${s.overCap} more file${s.overCap === 1 ? '' : 's'} over the ${MAX_DIR_FILES}-file limit (open a subdirectory)`);
  if (s.dot) parts.push(`${s.dot} dot-director${s.dot === 1 ? 'y' : 'ies'}`);
  if (s.nodeModules) parts.push(`${s.nodeModules} node_modules`);
  if (s.denied) parts.push(`${s.denied} denied path${s.denied === 1 ? '' : 's'}`);
  if (s.symlinks) parts.push(`${s.symlinks} symlink${s.symlinks === 1 ? '' : 's'} leading outside the directory or into a skipped path`);
  return parts.length ? `skipped: ${parts.join(', ')}` : '';
}

/**
 * The output of `open <dir>`: one line per doc, the review UI's home URL (it lists them), what was skipped, and the
 * `wait --all` to run per workspace.
 * @param {import('../runtime.js').Runtime} rt
 * @param {Array<Awaited<ReturnType<typeof trackOne>>>} tracked
 * @param {{ skipped: Skipped }} expanded
 * @param {'pane' | 'system' | 'none'} browser
 * @returns {Promise<import('../io.js').CommandResult>}
 */
async function folderResult(rt, tracked, expanded, browser) {
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
  for (const t of tracked) text.push(describe(t, null, null, 'none', t.doc.id)[0], ...externalsLines(t.externalHosts));
  const home = info ? `http://127.0.0.1:${info.uiPort}/?k=${encodeURIComponent(info.token)}` : null;
  const shown = home ? await showUrl(rt, home, browser, stderr) : 'none';
  text.push(home ? `review UI (all docs): ${home}` : `review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`);
  const skipped = skippedLine(expanded.skipped);
  if (skipped) text.push(skipped);
  /** @type {string[]} */
  const waits = [];
  const here = await discoveredRoot(rt.cwd);
  for (const root of [...new Set(tracked.map((t) => realpathOr(t.root)))]) {
    const ws = here === root ? '' : ` --workspace ${shellArg(path.relative(realpathOr(rt.cwd), root) || '.')}`;
    waits.push(`\`specreview wait --all${ws}\``);
  }
  const dirty = tracked.filter((t) => t.workingDirty);
  if (dirty.length) {
    // `wait --all` refuses while a working copy has unrecorded edits
    const refs = await Promise.all(dirty.map((t) => docRef(rt, t)));
    text.push(`next: record the unrecorded edits first (${refs.map((r) => `\`specreview revise ${r} --replies -\``).join(', ')}, or ask the reviewer to click Record as my revision), then run ${waits.join(' and ')} in the background`);
  } else {
    text.push(`next: ${shownPrefix(shown)}run ${waits.join(' and ')} in the background`);
  }
  for (const root of [...new Set(tracked.filter((t) => t.storeCreated).map((t) => t.root))]) {
    text.push(`created ${path.join(root, '.specreview')}/ (commit it with the specs)`);
  }
  if (daemonError) {
    stderr.push(`specreview: the review server could not be started: ${/** @type {Error} */ (daemonError).message} (the docs are tracked; run \`specreview doctor\`)`);
  }
  const docs = tracked.map((t) => ({
    doc: t.doc.id,
    path: t.doc.path,
    version: t.version,
    created: t.created,
    workingDirty: t.workingDirty,
    externals: t.externalHosts,
    url: info ? rt.reviewUrl(info, t.wsId, t.doc.id) : null,
    wsId: t.wsId,
    root: t.root,
  }));
  return {
    exit: daemonError ? exitCodeOf(daemonError) || EXIT.ERROR : EXIT.OK,
    text: text.join('\n'),
    stderr,
    json: { docs, home, skipped: expanded.skipped, ...(daemonError ? { error: { message: /** @type {Error} */ (daemonError).message } } : {}) },
  };
}

/**
 * `open -`: piped Markdown as a snapshot doc.
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ title?: string, name?: string }} input
 * @param {'pane' | 'system' | 'none'} browser
 * @returns {Promise<import('../io.js').CommandResult>}
 */
async function openStdin(rt, input, browser) {
  if (/** @type {any} */ (rt.stdin).isTTY) throw new UsageError('open -: pipe the text in, e.g. `pbpaste | specreview open -`');
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = await readAllBytes(rt.stdin, { maxBytes: MAX_SNAPSHOT_BYTES });
  } catch (err) {
    if (err instanceof RangeError) throw new UsageError(`open -: the piped text is larger than ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB`);
    throw err;
  }
  // bytes go to the engine as they are (it detects a BOM: UTF-8, UTF-16), as for files
  const text = decodeText(bytes).text;
  if (!text.trim()) throw new UsageError('open -: nothing was piped on stdin');
  const ws = await snapshotWorkspace(rt, rt.cwd);
  const origin = { type: 'stdin', key: input.name ? `stdin:${input.name}` : null, ...(input.name ? { name: input.name } : {}) };
  const t = await recordSnapshotDoc(rt, ws, { source: bytes, origin, title: input.title || defaultTitle(text, input.name || 'Piped text'), slug: input.name ?? null });

  /** @type {string[]} */
  const stderr = [];
  /** @type {import('../../shared/types.js').DaemonInfo | null} */
  let info = null;
  /** @type {unknown} */
  let daemonError = null;
  try {
    info = await rt.ensureDaemon();
  } catch (err) {
    daemonError = err;
  }
  const url = info ? rt.reviewUrl(info, t.wsId, t.doc.id) : null;
  const shown = url ? await showUrl(rt, url, browser, stderr) : 'none';
  const lines = [snapshotLine(t), url ? `review UI: ${url}` : `review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`];
  lines.push(...externalsLines(t.externalHosts));
  lines.push(`next: ${shownPrefix(shown)}run \`specreview wait ${t.ref}\` in the background`);
  lines.push(...scratchNote(ws));
  if (daemonError) stderr.push(`specreview: the review server could not be started: ${/** @type {Error} */ (daemonError).message} (the doc is tracked; run \`specreview doctor\`)`);
  return {
    exit: daemonError ? exitCodeOf(daemonError) || EXIT.ERROR : EXIT.OK,
    text: lines.join('\n'),
    stderr,
    json: { doc: t.doc.id, version: t.doc.head, created: t.created, url, wsId: t.wsId, root: ws.root, scratch: ws.scratch, ref: t.ref, name: input.name ?? null, externals: t.externalHosts },
  };
}

/**
 * Tracks one file and gathers what `describe` prints.
 * @param {import('../runtime.js').Runtime} rt
 * @param {string} p
 * @param {string | undefined} title
 * @param {string | null} [dirRoot] the workspace of the directory argument the file was found in: used when the
 *   file has no store of its own yet (so a folder never gets a store per subdirectory)
 */
async function trackOne(rt, p, title, dirRoot = null) {
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
  let ws = await findWorkspace(abs, { create: false, explicitRoot: rt.workspace ?? null });
  if (!ws.exists && dirRoot && !rt.workspace && realpathOr(dirRoot) !== ws.root) ws = await findWorkspace(abs, { create: false, explicitRoot: dirRoot });
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
    out.push(`specreview: tracking ${doc.path} as "${doc.id}" (${doc.format}, ${lineCount(t.lines)}) · recorded v${t.version}`);
  } else {
    const dirty = t.workingDirty ? ` · working copy differs from v${doc.head ?? t.version} (unrecorded)` : '';
    out.push(`specreview: ${doc.path} is already tracked as "${doc.id}" (head v${doc.head ?? t.version})${dirty}`);
  }
  out.push(url ? `review UI: ${url}` : `review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`);
  out.push(...externalsLines(t.externalHosts));
  if (t.workingDirty) {
    out.push(
      `next: record the unrecorded edits first (\`specreview revise ${ref} --replies -\`, or ask the reviewer to click Record as my revision), then run \`specreview wait ${ref}\` in the background`,
    );
  } else if (browser === 'system') {
    out.push(`next: the URL was opened in the system browser; run \`specreview wait ${ref}\` in the background`);
  } else if (browser === 'none') {
    out.push(`next: run \`specreview wait ${ref}\` in the background`);
  } else if (browser === 'failed') {
    out.push(`next: the system browser could not be opened; give the user the URL, then run \`specreview wait ${ref}\` in the background`);
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
    return hostsOf(externals);
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
