// @ts-check
// CLI plumbing shared by the commands that review text which is not a workspace file (`plan-gate`, `last`,
// `open -`, `snapshot <url>`): where the snapshot doc lives, recording it (engine takeSnapshot: v1, or vN+1 of the doc with the same
// origin key), and what is printed about it.
//
// Workspace: --workspace, else discovery from the relevant directory (the hook's or the shell's cwd) as `open`
// does; when discovery is refused (that directory is $HOME or /), the scratch workspace
// `<SPECREVIEW_HOME>/scratch/<first 8 hex of sha256(realpath dir)>/`. Discovery from the cwd never finds a scratch
// workspace, so every printed follow-up command names it with `--workspace <dir>` (store/snapshot.js docRefFor).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { RefusedError } from '../core/store/errors.js';
import { ensureHome } from '../core/store/home.js';
import { findWorkspace, initStoreDir } from '../core/store/workspace.js';
import { docRefFor, isScratchRoot, originInfo, scratchBase } from '../core/store/snapshot.js';
import { sha256 } from '../core/util/hash.js';
import { lineCount } from './format.js';
import { callOp, openContext, realpathOr, wsIdOfContext } from './runtime.js';

/** Largest text `open -`, `last` and `revise --source` accept. */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {object} SnapshotWorkspace
 * @property {string} root
 * @property {string} wsId
 * @property {boolean} scratch
 * @property {boolean} storeCreated
 */

/**
 * The workspace a snapshot taken from `dir` belongs to (see the header).
 * @param {import('./runtime.js').Runtime} rt
 * @param {string} dir
 * @returns {Promise<SnapshotWorkspace>}
 */
export async function snapshotWorkspace(rt, dir) {
  let ws;
  try {
    ws = await findWorkspace(dir, { create: false, explicitRoot: rt.workspace ?? null });
  } catch (err) {
    if (!(err instanceof RefusedError) || rt.workspace) throw err;
    const root = scratchRootFor(dir);
    // the home first, so it gets its 0700 mode even when a snapshot is the first thing ever run; plans and messages
    // in the scratch stores stay private
    ensureHome();
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    ws = await findWorkspace(root, { create: false, explicitRoot: root });
  }
  const storeCreated = !ws.exists;
  if (storeCreated) await initStoreDir(ws.root);
  return { root: ws.root, wsId: ws.wsId, scratch: isScratchRoot(ws.root), storeCreated };
}

/**
 * `<SPECREVIEW_HOME>/scratch/<first 8 hex of sha256(realpath dir)>`.
 * @param {string} dir
 * @returns {string}
 */
export function scratchRootFor(dir) {
  return path.join(scratchBase(), sha256(realpathOr(dir)).slice(0, 8));
}

/**
 * Records a snapshot (engine takeSnapshot) in the workspace.
 * @param {import('./runtime.js').Runtime} rt
 * @param {SnapshotWorkspace} ws
 * @param {{ source: string | Buffer, format?: 'markdown' | 'html', title?: string | null, slug?: string | null,
 *   origin: { type: string, key?: string | null } & Record<string, unknown>, summary?: string, autoAddress?: boolean,
 *   render?: { network?: 'allow' | 'block' }, replies?: Record<string, { status: string, reply: string, at?: string }>,
 *   other?: Array<{ at: string, why: string }> }} input
 */
export async function recordSnapshotDoc(rt, ws, input) {
  const { ctx, engine } = await openContext(rt, { create: true, root: ws.root });
  const res = await callOp(engine, 'takeSnapshot', ctx, input);
  return {
    ctx,
    engine,
    doc: res.doc,
    created: Boolean(res.created),
    reopened: Boolean(res.reopened),
    version: res.version,
    report: res.report ?? null,
    ref: docRefFor(res.doc.id, ws.root),
    wsId: wsIdOfContext(ctx) || ws.wsId,
    externalHosts: hostsOf(res.externals),
  };
}

/**
 * The hosts of absolute http(s) URLs, sorted (render.externals -> 'cdn.example.com').
 * @param {unknown} urls
 * @returns {string[]}
 */
export function hostsOf(urls) {
  const hosts = new Set();
  for (const u of Array.isArray(urls) ? urls : []) {
    try {
      hosts.add(new URL(String(u)).host);
    } catch {
      // not a URL: ignore
    }
  }
  return [...hosts].sort();
}

/**
 * The warning about hosts a doc loads live ([] when none).
 * @param {string[]} hosts
 * @returns {string[]}
 */
export function externalsLines(hosts) {
  return hosts.length ? [`external hosts loaded live by the doc: ${hosts.join(', ')} (set render.network to "block" in .specreview/config.json to block them)`] : [];
}

/**
 * The first output line about a recorded snapshot.
 * @param {{ doc: any, created: boolean, reopened?: boolean, version: any, report: any }} t
 * @returns {string}
 */
export function snapshotLine(t) {
  const { doc, version } = t;
  const what = originInfo(String(doc.origin?.type ?? '')).label;
  if (t.created) return `specreview: tracking ${what} as "${doc.id}" (${doc.format}, ${lineCount(version?.lines)}) · recorded v${version?.v ?? doc.head}`;
  if (t.reopened) return `specreview: ${what} "${doc.id}" is already tracked (head v${doc.head}); reopened it`;
  const r = t.report;
  if (r && r.version && !r.dryRun) return `specreview: recorded v${r.version} of "${doc.id}" (${what}; +${r.stats.added} -${r.stats.removed} lines)`;
  return `specreview: "${doc.id}" (${what}) is unchanged (identical to v${doc.head})`;
}

/**
 * The note printed when the snapshot went to a scratch workspace.
 * @param {SnapshotWorkspace} ws
 * @returns {string[]}
 */
export function scratchNote(ws) {
  return ws.scratch ? [`note: this directory cannot be a workspace, so the doc lives in the scratch workspace ${ws.root} (follow-up commands need --workspace, as shown)`] : [];
}

/**
 * A title for a snapshot without one: its first Markdown heading, else its first line (shortened), else `fallback`.
 * @param {string} text
 * @param {string} fallback
 * @returns {string}
 */
export function defaultTitle(text, fallback) {
  const lines = String(text ?? '').split(/\r?\n/);
  const heading = lines.map((l) => /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(l)?.[1]).find(Boolean);
  const first = heading ?? lines.map((l) => l.replace(/^[\s>*+#`|-]+/, '').replace(/[*_`]+/g, '').trim()).find(Boolean);
  if (!first) return fallback;
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

/**
 * The review UI line, opening it in the system browser when asked (the `open` command's behaviour).
 * @param {import('./runtime.js').Runtime} rt
 * @param {string} url
 * @param {'pane' | 'system' | 'none'} browser
 * @param {string[]} stderr collects a note when the browser could not be opened
 * @returns {Promise<'pane' | 'system' | 'none' | 'failed'>}
 */
export async function showUrl(rt, url, browser, stderr) {
  if (browser !== 'system') return browser;
  try {
    await rt.openBrowser(url);
    return 'system';
  } catch (err) {
    stderr.push(`specreview: could not open the system browser: ${/** @type {Error} */ (err).message}`);
    return 'failed';
  }
}

/**
 * How the URL reached the user, as the start of a `next:` line.
 * @param {'pane' | 'system' | 'none' | 'failed'} shown
 * @returns {string}
 */
export function shownPrefix(shown) {
  if (shown === 'system') return 'the URL was opened in the system browser; ';
  if (shown === 'pane') return 'open the URL (browser pane), then ';
  if (shown === 'failed') return 'the system browser could not be opened; give the user the URL, then ';
  return '';
}
