// @ts-check
// Snapshot docs: docs whose content is not a user-authored file in the workspace (a Claude Code plan, an agent's
// message, piped text; later a diff or a fetched URL). Everything kind-specific lives here so new origin types only
// add a row to ORIGIN_TYPES.
//
// doc.json of a snapshot doc:
//   "kind": "snapshot"                         (absent = "file": a tracked working file)
//   "origin": { "type": "plan" | "message" | "stdin" | ..., "key": string | null, ...type-specific fields }
//   "path": "<dir>/<slug>.md"                   synthetic, workspace-relative, never a dot segment, never read or written
// Rules (see Store): the working copy of a snapshot doc IS its head version (never dirty, never missing once v1
// exists); writeWorking refuses; findDoc never matches a snapshot by path or basename, so a synthetic path can never
// shadow a real file; findDocByOrigin(key) is the identity used to record re-snapshots as vN+1 of the same doc.
// Versions are recorded from bytes (ops/snapshot.js openSnapshot / recordSnapshot), never from the workspace.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';
import { homeDir } from './home.js';
import { isWithin } from '../util/paths.js';

export const SNAPSHOT_KIND = 'snapshot';

/**
 * @typedef {object} OriginInfo
 * @property {string} dir top directory of the synthetic path ('plans/<slug>.md')
 * @property {string} label what the snapshot is, for messages ('Claude Code plan')
 * @property {string} noun short name ('plan')
 * @property {boolean} rerecord whether taking the snapshot again under the same key records the new text as vN+1
 *   (a plan file and a named pipe change; a message under its id never does, so re-taking it only reopens the doc
 *   and never reverts the agent's revisions)
 * @property {boolean} gated reviews are delivered only by the command that took the snapshot (the plan gate) or
 *   an explicit `wait <doc>`: never by `wait --all` or a doc-less default
 */

/** @type {Record<string, OriginInfo>} */
const ORIGIN_TYPES = {
  plan: { dir: 'plans', label: 'Claude Code plan', noun: 'plan', rerecord: true, gated: true },
  message: { dir: 'messages', label: 'agent message', noun: 'message', rerecord: false, gated: false },
  stdin: { dir: 'text', label: 'piped text', noun: 'text', rerecord: true, gated: false },
};

/** Origin types without a row (future kinds) still work with these defaults. */
const DEFAULT_INFO = { dir: 'snapshots', label: 'snapshot', noun: 'snapshot', rerecord: true, gated: false };

const ORIGIN_TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_KEY = 1024;

/**
 * @typedef {{ type: string, key: string | null } & Record<string, unknown>} Origin
 */

/**
 * Whether a doc is a snapshot doc (doc.json `kind: "snapshot"`).
 * @param {unknown} doc
 * @returns {boolean}
 */
export function isSnapshot(doc) {
  return Boolean(doc) && typeof doc === 'object' && /** @type {any} */ (doc).kind === SNAPSHOT_KIND;
}

/**
 * The origin type of a snapshot doc ('' for a file doc).
 * @param {unknown} doc
 * @returns {string}
 */
export function originType(doc) {
  if (!isSnapshot(doc)) return '';
  const t = /** @type {any} */ (doc).origin?.type;
  return typeof t === 'string' ? t : '';
}

/**
 * Display data of an origin type (defaults for unknown types).
 * @param {string} type
 * @returns {OriginInfo}
 */
export function originInfo(type) {
  return Object.hasOwn(ORIGIN_TYPES, type) ? ORIGIN_TYPES[type] : { ...DEFAULT_INFO, label: type ? `${type} snapshot` : DEFAULT_INFO.label };
}

/**
 * Whether a doc's reviews belong to the command that took it (a plan: the plan gate). `wait --all` and doc-less
 * defaults skip such docs, so they can never take the verdict the gate is blocking on.
 * @param {unknown} doc
 * @returns {boolean}
 */
export function isGated(doc) {
  return isSnapshot(doc) && originInfo(originType(doc)).gated;
}

/**
 * Validates and normalises an origin: a known-shaped `type`, a string `key` (or null), other fields kept as given.
 * @param {unknown} origin
 * @returns {Origin}
 */
export function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw new UsageError('a snapshot needs an origin object {type, key}');
  const o = /** @type {Record<string, unknown>} */ (origin);
  if (typeof o.type !== 'string' || !ORIGIN_TYPE_RE.test(o.type)) throw new UsageError(`invalid snapshot origin type: ${JSON.stringify(o.type)}`);
  let key = null;
  if (o.key !== undefined && o.key !== null) {
    if (typeof o.key !== 'string' || !o.key || o.key.length > MAX_KEY || /[\0-\x1f]/.test(o.key)) {
      throw new UsageError(`invalid snapshot origin key: ${JSON.stringify(o.key)}`);
    }
    key = o.key;
  }
  return { ...o, type: o.type, key };
}

/**
 * Synthetic workspace-relative path of a snapshot doc: '<dir>/<slug>.md' (or .html). No leading dot segment, and it
 * carries the extension that drives the version file name and the renderer's format fallback.
 * @param {string} type
 * @param {string} slug a doc id
 * @param {'markdown' | 'html'} format
 * @returns {string}
 */
export function snapshotPath(type, slug, format) {
  return `${originInfo(type).dir}/${slug}.${format === 'html' ? 'html' : 'md'}`;
}

/**
 * Root directory of the per-user scratch workspaces: `<SPECREVIEW_HOME>/scratch`.
 * @returns {string}
 */
export function scratchBase() {
  return path.join(homeDir(), 'scratch');
}

/**
 * Whether a workspace root is a scratch workspace (snapshots taken where discovery is refused, e.g. in $HOME).
 * Follow-up commands must name such a workspace with --workspace: discovery from the cwd never finds it.
 * @param {string | null | undefined} root
 * @returns {boolean}
 */
export function isScratchRoot(root) {
  if (!root) return false;
  // real paths on both sides: workspace roots are realpath'd, SPECREVIEW_HOME (or $HOME) may be a symlink
  const base = realpathOr(scratchBase());
  const r = realpathOr(root);
  return r !== base && isWithin(base, r);
}

/**
 * @param {string} p
 * @returns {string} the real path, else the resolved path (it does not exist yet)
 */
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Quotes a shell argument when needed (same rule as the CLI's shellArg).
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
  return /^[A-Za-z0-9_.\/@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * How follow-up commands name a doc: its id, plus `--workspace <root>` for a scratch workspace.
 * @param {string} docId
 * @param {string | null | undefined} root
 * @returns {string}
 */
export function docRefFor(docId, root) {
  return isScratchRoot(root) ? `${docId} --workspace ${shellQuote(String(root))}` : docId;
}

/**
 * The plan file of a plan snapshot (absolute path from the origin), or null.
 * @param {unknown} doc
 * @returns {string | null}
 */
export function planFileOf(doc) {
  if (originType(doc) !== 'plan') return null;
  const p = /** @type {any} */ (doc).origin?.planFilePath;
  return typeof p === 'string' && path.isAbsolute(p) ? p : null;
}

/**
 * One sentence telling an agent how a snapshot doc is revised (refusals, `revise` without --source, packets).
 * @param {unknown} doc
 * @param {string} ref the doc as follow-up commands name it (see docRefFor)
 * @returns {string}
 */
export function reviseHint(doc, ref) {
  if (originType(doc) === 'plan') {
    const file = planFileOf(doc);
    return `edit the plan file${file ? ` ${file}` : ''} with targeted Edit-tool changes (never rewrite it), then call ExitPlanMode again; the plan gate records the new version and the reviewer sees a diff`;
  }
  return `write the complete revised text to a file (\`specreview show ${ref}\` prints the current version), then record it with \`specreview revise ${ref} --source <file> --replies -\` (replies JSON on stdin)`;
}

/**
 * Why an edit command is refused for a snapshot doc, with what to do instead.
 * @param {unknown} doc
 * @param {string} what the refused action ('apply', 'edit', 'revert', 'write')
 * @param {string} [ref]
 * @returns {string}
 */
export function snapshotRefusal(doc, what, ref) {
  const d = /** @type {any} */ (doc);
  return `${d?.id ?? 'this doc'} is ${snapshotNoun(doc)}, not a file in the workspace, so SpecReview cannot ${what} it. Instead, ${reviseHint(doc, ref ?? d?.id ?? '<doc>')}.`;
}

/**
 * 'a snapshot (Claude Code plan)'.
 * @param {unknown} doc
 * @returns {string}
 */
export function snapshotNoun(doc) {
  return `a snapshot (${originInfo(originType(doc)).label})`;
}
