// @ts-check
// Opening a code review (`specreview review`, MCP specreview_review): resolves the spec, takes round 1
// and creates (or reopens) the code doc.
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
 * ReviewInput = { mode?, base?, committed?, range?, commit?, paths?, context?, title?, browser?, maxFiles? }
 * Creates the code doc for the spec (identity: its origin key `diff:<mode>:<canonical spec>[+paths=...]`, via
 * Store#findDocByOrigin), or reopens the existing one and records a new round when the snapshot changed.
 * @param {Ctx} ctx
 * @param {{ input: Record<string, unknown>, title?: string }} p
 * @returns {Promise<{ doc: Doc, created: boolean, version: VersionManifest, recorded: boolean, code: CodeManifest }>}
 */
export async function openCodeReview(ctx, { input, title }) {
  void [ctx, input, title];
  throw notAvailable();
}
