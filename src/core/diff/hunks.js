// @ts-check
// Line hunks between two source texts (design 8.2, BUILD_AMENDMENTS 4.1 FROZEN).
//
// lineHunks(a, b) is equivalent to jsdiff structuredPatch with context 0, expressed as half-open, 1-based line
// ranges: old lines [oldStart, oldStart + oldLines), new lines [newStart, newStart + newLines). A pure insertion
// has oldLines = 0 and oldStart = the old line it is inserted before; a pure deletion has newLines = 0 and
// newStart = the new line now at the deletion point. Char offsets cover the same whole lines including their
// terminators: a[oldStartOff, oldEndOff) and b[newStartOff, newEndOff). Ids are h1..hN in file order and are
// deterministic for a pair of texts. Lines split on '\n' (a '\r' belongs to its line, as in jsdiff), so a last
// line that gains or loses its newline shows up as a changed line.

import { diffLines } from 'diff';

/**
 * @typedef {Object} Hunk
 * @property {string} id
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {number} oldStartOff
 * @property {number} oldEndOff
 * @property {number} newStartOff
 * @property {number} newEndOff
 */

/** Give up on an optimal line diff after this long and fall back to a prefix/suffix diff. */
const LINE_DIFF_TIMEOUT_MS = 10000;

/**
 * @param {string} a old text
 * @param {string} b new text
 * @returns {Hunk[]}
 */
export function lineHunks(a, b) {
  a = a ?? '';
  b = b ?? '';
  if (a === b) return [];
  const changes = diffLines(a, b, { timeout: LINE_DIFF_TIMEOUT_MS }) ?? coarseLineChanges(a, b);
  /** @type {Hunk[]} */
  const hunks = [];
  let oldLine = 1;
  let newLine = 1;
  let oldOff = 0;
  let newOff = 0;
  /** @type {Omit<Hunk, 'id'> | null} */
  let cur = null;
  const flush = () => {
    if (cur) hunks.push({ id: `h${hunks.length + 1}`, ...cur });
    cur = null;
  };
  for (const ch of changes) {
    const count = ch.count ?? countLines(ch.value);
    const len = ch.value.length;
    if (!ch.added && !ch.removed) {
      flush();
      oldLine += count;
      newLine += count;
      oldOff += len;
      newOff += len;
      continue;
    }
    cur ??= {
      oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0,
      oldStartOff: oldOff, oldEndOff: oldOff, newStartOff: newOff, newEndOff: newOff,
    };
    if (ch.removed) {
      cur.oldLines += count;
      oldLine += count;
      oldOff += len;
      cur.oldEndOff = oldOff;
    } else {
      cur.newLines += count;
      newLine += count;
      newOff += len;
      cur.newEndOff = newOff;
    }
  }
  flush();
  return hunks;
}

/**
 * Number of lines in a chunk of whole lines (a final line without '\n' counts).
 * @param {string} s
 */
export function countLines(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') ? n : n + 1;
}

/**
 * Split into lines keeping terminators ("a\nb" -> ["a\n", "b"]).
 * @param {string} s
 */
export function splitLinesKeep(s) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) {
    out.push(s.slice(start, i + 1));
    start = i + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Fallback when the optimal diff times out: common leading/trailing lines are equal, the middle is replaced.
 * @param {string} a @param {string} b
 * @returns {{ value: string, count: number, added?: boolean, removed?: boolean }[]}
 */
function coarseLineChanges(a, b) {
  const al = splitLinesKeep(a);
  const bl = splitLinesKeep(b);
  let p = 0;
  while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
  let s = 0;
  while (s < al.length - p && s < bl.length - p && al[al.length - 1 - s] === bl[bl.length - 1 - s]) s++;
  const out = [];
  if (p) out.push({ value: al.slice(0, p).join(''), count: p });
  if (al.length - p - s > 0) out.push({ value: al.slice(p, al.length - s).join(''), count: al.length - p - s, removed: true });
  if (bl.length - p - s > 0) out.push({ value: bl.slice(p, bl.length - s).join(''), count: bl.length - p - s, added: true });
  if (s) out.push({ value: al.slice(al.length - s).join(''), count: s });
  return out;
}
