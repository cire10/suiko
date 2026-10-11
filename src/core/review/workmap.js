// @ts-check
// Precise offset mapping from one source text to another (typically head -> working copy).
//
// offsetMapper (diff/offsets.js) maps unchanged regions exactly but collapses every offset inside a changed hunk to
// the hunk's start. Packets, `apply`, `revert --lock` and live DOM targets need better: an anchor whose own text
// survived inside a hunk (another word on the same line changed) must keep its exact place. This module refines
// the line hunks with a word diff of each hunk (computed lazily and cached), so:
//   - offsets in unchanged text (also inside a hunk) map exactly;
//   - an offset inside deleted text maps to the point where the deletion happened;
//   - at a pure insertion point, `bias` decides whether the mapped offset lands before ('left') or after
//     ('right') the inserted text. Range starts use 'right' (insertions just before a range are not part of it),
//     range ends use 'left' (insertions just after a range are not part of it).
// `touched(s, e)` reports whether any changed character of the old text lies in [s, e) (an insertion strictly
// inside the range counts), i.e. whether the anchored text itself was edited.

import { lineHunks } from '../diff/index.js';
import { hunkWordOps } from '../diff/words.js';

/**
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {import('../diff/words.js').WordOp} WordOp
 * @typedef {object} PreciseMapper
 * @property {Hunk[]} hunks line hunks old -> new (sorted by old offset)
 * @property {(off: number, bias?: 'left' | 'right') => number} map
 * @property {(start: number, end: number) => { start: number, end: number }} mapRange
 * @property {(start: number, end: number) => boolean} touched
 * @property {(start: number, end: number) => Hunk[]} hunksTouching hunks whose changed old text intersects [start, end)
 * @property {(hunk: Hunk) => Array<[number, number]>} changedOld absolute changed old ranges of a hunk
 */

/**
 * @param {string} a old text
 * @param {string} b new text
 * @param {Hunk[]} [hunks] lineHunks(a, b) when already computed
 * @returns {PreciseMapper}
 */
export function preciseMapper(a, b, hunks) {
  const oldText = a ?? '';
  const newText = b ?? '';
  const hs = [...(hunks ?? lineHunks(oldText, newText))].sort((x, y) => x.oldStartOff - y.oldStartOff || x.oldStart - y.oldStart);
  /** @type {Map<string, WordOp[]>} */
  const opsCache = new Map();

  /** @param {Hunk} h @returns {WordOp[]} */
  const opsOf = (h) => {
    let ops = opsCache.get(h.id);
    if (!ops) {
      ops = hunkWordOps(oldText.slice(h.oldStartOff, h.oldEndOff), newText.slice(h.newStartOff, h.newEndOff));
      opsCache.set(h.id, ops);
    }
    return ops;
  };

  /**
   * @param {number} off
   * @param {'left' | 'right'} [bias]
   * @returns {number}
   */
  const map = (off, bias = 'right') => {
    const o = Math.max(0, Math.min(Math.floor(Number(off) || 0), oldText.length));
    let delta = 0;
    for (const h of hs) {
      if (o < h.oldStartOff) break;
      const pureInsert = h.oldEndOff === h.oldStartOff;
      if (pureInsert) {
        if (o === h.oldStartOff) return bias === 'left' ? h.newStartOff : h.newEndOff;
        delta = h.newEndOff - h.oldEndOff;
        continue;
      }
      if (o >= h.oldEndOff) {
        delta = h.newEndOff - h.oldEndOff;
        continue;
      }
      return h.newStartOff + mapInsideHunk(opsOf(h), o - h.oldStartOff, bias);
    }
    return o + delta;
  };

  /** @param {Hunk} h @returns {Array<[number, number]>} */
  const changedOld = (h) => {
    /** @type {Array<[number, number]>} */
    const out = [];
    for (const op of opsOf(h)) {
      if (op.op === 'del') out.push([h.oldStartOff + op.aStart, h.oldStartOff + op.aEnd]);
      else if (op.op === 'ins') out.push([h.oldStartOff + op.aStart, h.oldStartOff + op.aStart]);
    }
    return out;
  };

  /** @param {number} s @param {number} e @returns {Hunk[]} */
  const hunksTouching = (s, e) =>
    hs.filter((h) => {
      if (h.oldEndOff < s || h.oldStartOff > e) return false;
      return changedOld(h).some(([cs, ce]) => (ce > cs ? cs < e && s < ce : cs > s && cs < e));
    });

  return {
    hunks: hs,
    map,
    mapRange(start, end) {
      const s = map(start, 'right');
      const e = end > start ? Math.max(s, map(end, 'left')) : s;
      return { start: s, end: e };
    },
    touched: (s, e) => hunksTouching(s, e).length > 0,
    hunksTouching,
    changedOld,
  };
}

/**
 * Maps an offset relative to a hunk's old slice to its new slice through the hunk's word ops.
 * @param {WordOp[]} ops
 * @param {number} rel
 * @param {'left' | 'right'} bias
 * @returns {number}
 */
function mapInsideHunk(ops, rel, bias) {
  /** A pure insertion (not the replacement half of a del+ins pair) right at `rel`. */
  /** @type {WordOp | null} */
  let insertAt = null;
  /** @type {WordOp | null} */
  let prev = null;
  for (const op of ops) {
    if (op.op === 'ins') {
      const replacement = prev?.op === 'del' && prev.aEnd === op.aStart;
      if (op.aStart === rel && !replacement) insertAt = op;
      prev = op;
      continue;
    }
    if (rel >= op.aStart && rel < op.aEnd) {
      if (op.op === 'eq') {
        if (rel === op.aStart && insertAt && bias === 'left') return insertAt.bStart;
        return op.bStart + (rel - op.aStart);
      }
      // Inside deleted text: the deletion point (a replacement inserted there follows it).
      return op.bStart;
    }
    prev = op;
  }
  const last = ops[ops.length - 1];
  return last ? last.bEnd : 0;
}

/**
 * Lines spanned by a half-open range, using a line index ({ lineOf }).
 * @param {{ lineOf(off: number): number }} li
 * @param {number} start
 * @param {number} end
 * @returns {[number, number]}
 */
export function linesOf(li, start, end) {
  const a = li.lineOf(start);
  const b = end > start ? li.lineOf(end - 1) : a;
  return [a, Math.max(a, b)];
}
