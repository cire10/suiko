// @ts-check
// Applying code suggestions to the real repo files (Store#writeRepoFile, CAS against the working file).
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
 * `apply` on a code doc, and the reviewer's "Apply now" (actor human; ops/revise.js then records a 'ui-apply'
 * round). Each thread needs `suggestion.file` and a new-side anchor; otherwise it is a conflict.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string[]} tids
 * @param {{ dryRun?: boolean, actor: Actor }} opts
 * The result has the shape of ops.applySuggestions on a spec (packet.js formatApply prints both): `applied` rows add
 * the repo `file` their `lines` are in; `how` is 'exact' | 'fuzzy' | ...
 * @returns {Promise<{ applied: Array<{ id: string, file: string, lines: [number, number], how: string }>,
 *   conflicts: Array<{ id: string, reason: string }>, skipped?: Array<{ id: string, reason: string }>, dryRun: boolean }>}
 */
export async function applyCodeSuggestions(ctx, doc, tids, { dryRun, actor }) {
  void [ctx, doc, tids, dryRun, actor];
  throw notAvailable();
}
