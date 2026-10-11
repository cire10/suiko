// @ts-check
// Dirty state of a code doc: whether the files of the review differ from the head round (stat-first,
// memoized).
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
 * The kind adapter's workingState for code docs (kinds.js). `text`/`sha256`/`buf` describe the canonical diff text
 * of the working tree (what the next round would record); `dirty` compares it with head; `changedFiles` lists the
 * repo-relative paths whose content differs from the head round.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {import('../review/ops/common.js').HeadState | null} head
 * @returns {Promise<import('../review/ops/common.js').WorkingState & { changedFiles: string[] }>}
 */
export async function codeWorkingState(ctx, doc, head) {
  void [ctx, doc, head];
  throw notAvailable();
}
