// @ts-check
// Offset / line mapping from an old text to a new text through line hunks (design 8.2, BUILD_AMENDMENTS 4.1).
//
// mapOffset(off): offsets in unchanged regions shift by the cumulative size delta of the hunks before them;
// offsets inside a hunk's old range map to the hunk's new start and report that hunk. An offset exactly at a
// pure insertion point maps past the inserted text (the old character there now follows the insertion).
// mapLine(line) does the same for 1-based lines.

import { lineHunks } from './hunks.js';

/**
 * @typedef {import('./hunks.js').Hunk} Hunk
 * @typedef {{ mapOffset(off: number): { off: number, hunk: Hunk|null }, mapLine(line: number): { line: number, hunk: Hunk|null } }} OffsetMapper
 */

/**
 * @param {string} a
 * @param {string} b
 * @param {Hunk[]} [hunks] lineHunks(a, b) (computed when omitted)
 * @returns {OffsetMapper}
 */
export function offsetMapper(a, b, hunks) {
  const hs = [...(hunks ?? lineHunks(a, b))].sort((x, y) => x.oldStartOff - y.oldStartOff || x.oldStart - y.oldStart);
  const byLine = [...hs].sort((x, y) => x.oldStart - y.oldStart);
  const aLen = (a ?? '').length;

  /**
   * Last index i with key(hs[i]) <= v, or -1.
   * @param {Hunk[]} list @param {(h: Hunk) => number} key @param {number} v
   */
  const lastAtOrBefore = (list, key, v) => {
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (key(list[mid]) <= v) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };

  return {
    mapOffset(off) {
      const o = Math.max(0, Math.min(Number(off) || 0, aLen));
      const i = lastAtOrBefore(hs, (h) => h.oldStartOff, o);
      if (i < 0) return { off: o, hunk: null };
      const h = hs[i];
      if (h.oldEndOff > h.oldStartOff && o < h.oldEndOff) return { off: h.newStartOff, hunk: h };
      return { off: o + (h.newEndOff - h.oldEndOff), hunk: null };
    },
    mapLine(line) {
      const l = Math.max(1, Math.floor(Number(line) || 1));
      const i = lastAtOrBefore(byLine, (h) => h.oldStart, l);
      if (i < 0) return { line: l, hunk: null };
      const h = byLine[i];
      if (h.oldLines > 0 && l < h.oldStart + h.oldLines) return { line: h.newStart, hunk: h };
      return { line: l + (h.newStart + h.newLines) - (h.oldStart + h.oldLines), hunk: null };
    },
  };
}
