// @ts-check
// Rounds of a code review: `revise` on a code doc (the agent records its working tree as vN+1 with replies)
// and the reviewer's "Re-snapshot" / apply rounds.
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
 * `revise` on a code doc (dispatched by ops/revise.js before any snapshot or file logic). `input` is the parsed
 * ReviseInput (threads replies with `at` in the code forms of util/code-at.js, other, force, dryRun...).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {import('../../shared/types.js').ReviseInput & Record<string, unknown>} input
 * @returns {Promise<import('../../shared/types.js').ReviseReport & { code: { files: number, baseMoved: { from: string, to: string } | null, carried: string[] } }>}
 */
export async function reviseCode(ctx, doc, input) {
  void [ctx, doc, input];
  throw notAvailable();
}

/**
 * Records the working tree as a new round without agent replies (UI "Re-snapshot": capturedBy 'ui-record'; after a
 * reviewer apply: 'ui-apply'). `{ nothing: true, v }` when the snapshot equals head.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ author: Actor, capturedBy: 'ui-record' | 'ui-apply' | 'round' }} p
 * @returns {Promise<{ manifest: VersionManifest } | { nothing: true, v: number }>}
 */
export async function recordCodeRound(ctx, doc, { author, capturedBy }) {
  void [ctx, doc, author, capturedBy];
  throw notAvailable();
}
