// @ts-check
// Agent questions and re-anchoring on a code doc (`ask --file`, `reanchor --file`).
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
 * ops.ask on a code doc: an agent-question thread on `file` lines of head (new side), or a whole-review thread when
 * `file` is absent.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ file?: string | null, lines?: [number, number] | null, body: string }} input
 * @returns {Promise<{ thread: Thread, version: number, lines: [number, number] | null }>}
 */
export async function askCode(ctx, doc, { file, lines, body }) {
  void [ctx, doc, file, lines, body];
  throw notAvailable();
}

/**
 * ops.reanchorThread on a code doc: the agent's override of a thread's anchor to `file` lines.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string} tid
 * @param {{ file?: string | null, lines?: [number, number] | null }} input
 * @returns {Promise<{ thread: Thread, anchor: Anchor | null, staged: boolean }>}
 */
export async function reanchorCode(ctx, doc, tid, { file, lines }) {
  void [ctx, doc, tid, file, lines];
  throw notAvailable();
}
