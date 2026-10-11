// @ts-check
// Packet data of a code doc: what feedback / wait / show print for each thread (file, side, lines in the
// working tree, src> / was> lines, file state), the header label, the line basis and NEXT.
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
 * The kind adapter's loadExtra for code docs: adds `snap.code = { manifest, blobs, working, root }` to a loaded
 * snapshot (common.js loadSnapshot). `manifest`: head CodeManifest; `blobs`: (ref) => Promise<Buffer> (or a cache);
 * `working`: the working-tree state of the review's files; `root`: the repo top level.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {any} snap
 * @returns {Promise<void>}
 */
export async function loadCodeSnapshot(ctx, doc, snap) {
  void [ctx, doc, snap];
  throw notAvailable();
}

/**
 * The kind adapter's describeThread for code docs (packet items, `show`, `threads`). `lines`: working-tree lines
 * (new side) or base lines (old side); `src`: exact working-file lines (unique in the file, or `srcUnique: false`);
 * `was`: base lines of an old-side anchor; `nowBetween`: the working lines an old-side position falls between;
 * `fileStatus`: the file's CodeFile.status at head ('A' prints "(new file)").
 * @param {any} snap a loaded snapshot with `snap.code`
 * @param {Thread} thread
 * @param {{ cwd?: string | null, attachmentPath?: (rel: string) => string }} opts
 * @returns {{ file: string | null, fileFromCwd: string | null, side: 'new' | 'old' | null, lines: [number, number] | null,
 *   src: string | null, was: string[] | null, fileState: 'ok' | 'missing' | 'not-checked-out' | 'binary' | 'too-large' | null,
 *   srcUnique?: boolean, nowBetween?: [number, number] | null, fileStatus?: string | null }}
 */
export function describeCodeThread(snap, thread, opts) {
  void [snap, thread, opts];
  throw notAvailable();
}

/**
 * The header label of a code packet: 'since-base origin/main, merge-base 1a2b3c4'.
 * @param {any} snap
 * @returns {string}
 */
export function codePacketLabel(snap) {
  void [snap];
  throw notAvailable();
}

/**
 * The basis lines printed under the header, Repo root line first:
 * 'Repo root: /Users/me/repo (paths below are relative to it)', 'Line numbers = files in your working tree now
 * (all identical to v1).', a base change line.
 * @param {any} snap
 * @param {import('../review/packet-data.js').PacketThread[]} threads
 * @returns {string[]}
 */
export function codeLineBasis(snap, threads) {
  void [snap, threads];
  throw notAvailable();
}

/**
 * The NEXT line of a code packet (without 'NEXT: '), per mode.
 * @param {Doc} doc
 * @param {string} ref the doc as follow-up commands name it
 * @param {{ approved: boolean, finalNow: boolean }} approval
 * @param {number} actionable
 * @returns {string}
 */
export function codeNextStep(doc, ref, approval, actionable) {
  void [doc, ref, approval, actionable];
  throw notAvailable();
}
