// @ts-check
// Word-level diffs and per-hunk statistics (BUILD_AMENDMENTS 4.1, FROZEN):
//   wordDiff(a, b)          -> [{ op: 'eq'|'ins'|'del', text, aStart, aEnd, bStart, bEnd }]  (jsdiff diffWordsWithSpace)
//   hunkStats(a, b, hunk)   -> { removedChars, insertedChars, removedWords, insertedWords,
//                                changedOldRanges: [[s,e]], changedNewRanges: [[s,e]] }   (absolute offsets)
//   rewriteRatio(a, b, hunks) -> removed-or-replaced OLD chars / max(1, a.length); insertions excluded
// Offsets in wordDiff ops are relative to the strings passed in; an 'ins' op has aStart === aEnd (the insertion
// point in a) and a 'del' op has bStart === bEnd. Very large rewrites (more than MAX_EDITS token edits) fall back
// to a prefix/suffix diff so callers never stall.

import { diffWordsWithSpace } from 'diff';

/**
 * @typedef {{ op: 'eq'|'ins'|'del', text: string, aStart: number, aEnd: number, bStart: number, bEnd: number }} WordOp
 * @typedef {import('./hunks.js').Hunk} Hunk
 */

const MAX_EDITS = 2000;
const TIMEOUT_MS = 1000;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

/**
 * @param {string} a
 * @param {string} b
 * @returns {WordOp[]}
 */
export function wordDiff(a, b) {
  a = a ?? '';
  b = b ?? '';
  if (a === b) return a ? [{ op: 'eq', text: a, aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }] : [];
  const parts = diffWordsWithSpace(a, b, { maxEditLength: MAX_EDITS, timeout: TIMEOUT_MS }) ?? coarse(a, b);
  /** @type {WordOp[]} */
  const ops = [];
  let ia = 0;
  let ib = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (!len) continue;
    if (p.added) {
      ops.push({ op: 'ins', text: p.value, aStart: ia, aEnd: ia, bStart: ib, bEnd: ib + len });
      ib += len;
    } else if (p.removed) {
      ops.push({ op: 'del', text: p.value, aStart: ia, aEnd: ia + len, bStart: ib, bEnd: ib });
      ia += len;
    } else {
      ops.push({ op: 'eq', text: p.value, aStart: ia, aEnd: ia + len, bStart: ib, bEnd: ib + len });
      ia += len;
      ib += len;
    }
  }
  return ops;
}

/**
 * Number of words (runs of letters, digits and '_') in a string.
 * @param {string} s
 */
export function countWords(s) {
  return (String(s ?? '').match(WORD_RE) ?? []).length;
}

/**
 * @param {string} a full old text
 * @param {string} b full new text
 * @param {Hunk} hunk
 */
export function hunkStats(a, b, hunk) {
  const oldSlice = (a ?? '').slice(hunk.oldStartOff, hunk.oldEndOff);
  const newSlice = (b ?? '').slice(hunk.newStartOff, hunk.newEndOff);
  const ops = hunkWordOps(oldSlice, newSlice);
  let removedChars = 0;
  let insertedChars = 0;
  let removedWords = 0;
  let insertedWords = 0;
  /** @type {[number, number][]} */
  const changedOldRanges = [];
  /** @type {[number, number][]} */
  const changedNewRanges = [];
  for (const o of ops) {
    if (o.op === 'del') {
      removedChars += o.text.length;
      removedWords += countWords(o.text);
      changedOldRanges.push([hunk.oldStartOff + o.aStart, hunk.oldStartOff + o.aEnd]);
    } else if (o.op === 'ins') {
      insertedChars += o.text.length;
      insertedWords += countWords(o.text);
      changedNewRanges.push([hunk.newStartOff + o.bStart, hunk.newStartOff + o.bEnd]);
    }
  }
  return { removedChars, insertedChars, removedWords, insertedWords, changedOldRanges, changedNewRanges };
}

/**
 * Word ops for a hunk's old/new slices; pure insertions/deletions skip the diff.
 * @param {string} oldSlice @param {string} newSlice
 * @returns {WordOp[]}
 */
export function hunkWordOps(oldSlice, newSlice) {
  if (!oldSlice) return newSlice ? [{ op: 'ins', text: newSlice, aStart: 0, aEnd: 0, bStart: 0, bEnd: newSlice.length }] : [];
  if (!newSlice) return [{ op: 'del', text: oldSlice, aStart: 0, aEnd: oldSlice.length, bStart: 0, bEnd: 0 }];
  return wordDiff(oldSlice, newSlice);
}

/**
 * @param {string} a
 * @param {string} b
 * @param {Hunk[]} hunks
 */
export function rewriteRatio(a, b, hunks) {
  let removed = 0;
  for (const h of hunks ?? []) removed += hunkStats(a, b, h).removedChars;
  return removed / Math.max(1, (a ?? '').length);
}

/**
 * Prefix/suffix fallback diff (snapped to whitespace so words are not split).
 * @param {string} a @param {string} b
 */
function coarse(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (p > 0 && !/\s/.test(a[p - 1])) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (s > 0 && !/\s/.test(a[a.length - s])) s--;
  const out = [];
  if (p) out.push({ value: a.slice(0, p) });
  if (a.length - p - s > 0) out.push({ value: a.slice(p, a.length - s), removed: true });
  if (b.length - p - s > 0) out.push({ value: b.slice(p, b.length - s), added: true });
  if (s) out.push({ value: a.slice(a.length - s) });
  return out;
}
