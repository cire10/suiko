// @ts-check
// Captures on a code doc: a line range of one file side, a whole file, or the whole review.
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
 * The kind adapter's capture for code docs: `{kind:'line', file, side, startLine, endLine}`,
 * `{kind:'file', file}` or `{kind:'doc'}` (a whole-review thread) at version `v` -> an Anchor with `file` set
 * (none for 'doc') and the composer preview. Other capture kinds are refused (UsageError).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Capture} capture
 * @param {number} v
 * @returns {Promise<{ anchor: Anchor, preview: { label: string, lines: [number, number] | null, section: string[], src: string, text: string } }>}
 */
export async function resolveCodeCapture(ctx, doc, capture, v) {
  void [ctx, doc, capture, v];
  throw notAvailable();
}

/**
 * The stored suggestion of a code draft: mode 'lines', `file` (new side only), `old` = the anchored whole lines of
 * that file at version `v`. The caller sets `new` (the reviewer's text), `status: 'pending'`, `appliedIn: null`.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Anchor} anchor
 * @param {number} v
 * @returns {Promise<import('../../shared/types.js').Suggestion>}
 */
export async function codeSuggestionFor(ctx, doc, anchor, v) {
  void [ctx, doc, anchor, v];
  throw notAvailable();
}
