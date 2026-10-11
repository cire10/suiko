// @ts-check
// File lists, per-file diffs and file sources of a code doc (the daemon D/files routes, Changes mode,
// `diff`, mini-diffs).
//
// STUB (WP0b): the frozen signatures of the code-review engine. Every function throws
// UsageError('code review is not available in this build') until WP3 replaces this file. Callers (the op dispatch in
// src/core/review/ops/*, the kind adapter src/core/review/kinds.js, the daemon routes) are wired already, so
// replacing the bodies is all the engine has to do (the data shapes are in src/shared/types.js).

import { UsageError } from '../store/errors.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Actor} Actor
 * @typedef {import('../../shared/types.js').Capture} Capture
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../../shared/types.js').VersionManifest} VersionManifest
 */

/** @returns {UsageError} */
function notAvailable() {
  return new UsageError('code review is not available in this build', { details: { kind: 'code' } });
}

/**
 * GET D/files?v=N -> { v, files: Array<CodeFile & { threads: string[] }>, skipped };
 * GET D/files?from=A&to=B -> { from, to, files: Array<{ path, oldPath?, change: 'changed' | 'added' | 'dropped' |
 * 'renamed', added, removed, threads }> }.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ v: number } | { from: number, to: number }} q
 * @returns {Promise<object>}
 */
export async function codeFiles(ctx, ref, q) {
  void [ctx, ref, q];
  throw notAvailable();
}

/**
 * GET D/files/diff?path=P&v=N[&context=K] (or &from=A&to=B) -> { path, oldPath?, v | from+to, stub?: 'binary' |
 * 'too-large' | 'submodule' | 'excluded' | 'unsupported-name', hunks: Array<DisplayHunk & { threads: string[] }> }.
 * NotFoundError for a path that is not in the round.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {({ path: string, v: number } | { path: string, from: number, to: number }) & { context?: number }} q
 * @returns {Promise<object>}
 */
export async function codeFileDiff(ctx, ref, q) {
  void [ctx, ref, q];
  throw notAvailable();
}

/**
 * GET D/files/source?path=P&v=N&side=new|old -> { path, side, v, text, lines }.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ path: string, v: number, side: 'new' | 'old' }} q
 * @returns {Promise<{ path: string, side: 'new' | 'old', v: number, text: string, lines: number }>}
 */
export async function codeFileSource(ctx, ref, { path, v, side }) {
  void [ctx, ref, path, v, side];
  throw notAvailable();
}

/**
 * ops.changes on a code doc (Verify / Changes mode, `diff --stat`): the interdiff between two rounds.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | 'live', to?: number | 'live' } & Record<string, unknown>} range
 * @returns {Promise<object>}
 */
export async function codeChanges(ctx, ref, range) {
  void [ctx, ref, range];
  throw notAvailable();
}

/**
 * ops.unifiedDiff on a code doc (`diff A..B --unified`).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | 'live', to?: number | 'live' } & Record<string, unknown>} range
 * @returns {Promise<object>}
 */
export async function codeUnifiedDiff(ctx, ref, range) {
  void [ctx, ref, range];
  throw notAvailable();
}

/**
 * ops.threadMiniDiff on a code doc: the change linked to a thread in its file.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @returns {Promise<object>}
 */
export async function codeThreadMiniDiff(ctx, ref, tid) {
  void [ctx, ref, tid];
  throw notAvailable();
}
