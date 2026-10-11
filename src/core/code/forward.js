// @ts-check
// Carrying code anchors forward across rounds (drafts made on older rounds, moved threads).
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
 * The kind adapter's forwarder for code docs: maps an anchor of round `anchor.v` to every round up to `toVersion`
 * (keys are version numbers as strings, like forwardAnchor). It must keep `anchor.file` (following renames) and map
 * the line numbers of that file side; it never re-anchors on the diff text.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {(anchor: Anchor, toVersion: number) => Promise<Record<string, Anchor>>}
 */
export function codeForwarder(ctx, doc) {
  void [ctx, doc];
  throw notAvailable();
}
