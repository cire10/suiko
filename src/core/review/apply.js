// @ts-check
// Deterministic splices for `apply`, `edit`, `revert` and the reviewer's "Apply suggestion" (design 9.4):
// - locateSuggestion: the suggestion's `old` text at its mapped position in the working copy; else the occurrence
//   nearest that position INSIDE the thread's own anchored lines (`within`: the anchor's current range mapped to the
//   working copy and widened to whole lines); else a conflict. A suggestion is never written into another copy of
//   its text elsewhere in the doc: when the anchored sentence was edited (by hand, by the agent, or by an earlier
//   apply), the identical phrase in an unrelated section is not "the same text moved" (this overrides design 9.4's
//   "only occurrence anywhere / nearest within 2000 chars" fallback, which silently edited the wrong sentence).
// - findOccurrences: Edit-tool semantics for `edit` (old must be unique unless replaceAll).
// - spliceText: one replacement plus the line bookkeeping recorded in pending edits (oldLines = lines replaced in
//   the text before, newLines = lines of the replacement in the text after; an empty side covers the line at the
//   splice point), which attribution uses to tag hunks and to shift earlier tagged edits.
// - eolOf / matchEol: inserted text (suggestions from a <textarea>, `edit` strings) takes a CRLF file's line
//   endings, so a CRLF file stays CRLF.

import { lineIndex } from '../text/index.js';

/**
 * @typedef {{ start: number, end: number, how: 'exact' | 'nearest' }} Located
 * @typedef {{ text: string, start: number, end: number, oldLines: [number, number], newLines: [number, number] }} Spliced
 */

/**
 * @param {string} working
 * @param {string} old
 * @param {number} expectedAt mapped offset of the anchored text in `working`
 * @param {{ start: number, end: number } | null} [within] where a displaced occurrence may be accepted (the
 *   anchor's lines in `working`, see lineWindow); without it only the exact position is accepted
 * @returns {Located | null}
 */
export function locateSuggestion(working, old, expectedAt, within = null) {
  if (!old) return { start: expectedAt, end: expectedAt, how: 'exact' };
  if (working.startsWith(old, expectedAt)) return { start: expectedAt, end: expectedAt + old.length, how: 'exact' };
  if (!within) return null;
  const lo = Math.max(0, Math.min(within.start, working.length));
  const hi = Math.max(lo, Math.min(within.end, working.length));
  let best = -1;
  let bestDist = Infinity;
  for (let p = working.indexOf(old, lo); p >= 0 && p + old.length <= hi; p = working.indexOf(old, p + 1)) {
    const d = Math.abs(p - expectedAt);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best >= 0 ? { start: best, end: best + old.length, how: 'nearest' } : null;
}

/**
 * Where a suggestion's `old` text is expected in the head source, from the thread's head anchor: `expected` (the
 * offset of `old` inside the anchored text, else the suggestion's own offset when it was made on head, else the
 * anchor start) and `window`, the anchor's range (joined with the suggestion's own range when made on head, which
 * covers whole-line 'source' suggestions). Callers map both to the working copy and widen the window to lines.
 * @param {{ src: { start: number, end: number, text: string } }} a anchor at head
 * @param {{ old: string, version: number, start: number, end: number }} s suggestion
 * @param {number} headV
 * @returns {{ expected: number, window: { start: number, end: number } }}
 */
export function suggestionTarget(a, s, headV) {
  const inAnchor = a.src.text.indexOf(s.old);
  const own = s.version === headV;
  const expected = inAnchor >= 0 ? a.src.start + inAnchor : own ? s.start : a.src.start;
  const window = own ? { start: Math.min(a.src.start, s.start), end: Math.max(a.src.end, s.end) } : { start: a.src.start, end: a.src.end };
  return { expected, window };
}

/**
 * [start, end) widened to whole lines of `text` (the end includes the last line's terminator).
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number }}
 */
export function lineWindow(text, start, end) {
  const li = lineIndex(text);
  const a = li.lineOf(start);
  const b = end > start ? li.lineOf(end - 1) : a;
  return { start: li.startOf(a), end: li.nextStartOf(Math.max(a, b)) };
}

/**
 * The dominant line ending of a text: '\r\n' when most of its line breaks are CRLF, else '\n'.
 * @param {string} text
 * @returns {'\r\n' | '\n'}
 */
export function eolOf(text) {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * `insert` for a file whose line ending is `eol`: on a CRLF file every bare '\n' becomes '\r\n' (a <textarea> and
 * most agent strings use '\n'); anything else is returned unchanged.
 * @param {string} insert
 * @param {'\r\n' | '\n'} eol
 * @returns {string}
 */
export function matchEol(insert, eol) {
  if (eol !== '\r\n' || !insert.includes('\n')) return insert;
  return insert.replace(/\r?\n/g, '\r\n');
}

/**
 * Start offsets of every (non-overlapping) occurrence of `needle`.
 * @param {string} hay
 * @param {string} needle
 * @param {number} [max]
 * @returns {number[]}
 */
export function findOccurrences(hay, needle, max = Infinity) {
  /** @type {number[]} */
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0 && out.length < max; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * Replaces text[start, end) with `insert`.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} insert
 * @returns {Spliced}
 */
export function spliceText(text, start, end, insert) {
  const before = lineIndex(text);
  const out = text.slice(0, start) + insert + text.slice(end);
  const after = lineIndex(out);
  const oa = before.lineOf(start);
  const ob = end > start ? before.lineOf(end - 1) : oa;
  const na = after.lineOf(start);
  const nb = insert.length ? after.lineOf(start + insert.length - 1) : na;
  return { text: out, start, end: start + insert.length, oldLines: [oa, ob], newLines: [na, nb] };
}

/**
 * Applies `edit` semantics: replace the unique occurrence of `oldString` (every occurrence with replaceAll).
 * @param {string} text
 * @param {string} oldString
 * @param {string} newString
 * @param {boolean} [replaceAll]
 * @returns {{ ok: true, text: string, splices: Spliced[] } | { ok: false, count: number }}
 */
export function replaceExact(text, oldString, newString, replaceAll = false) {
  const positions = findOccurrences(text, oldString);
  if (positions.length === 0 || (positions.length > 1 && !replaceAll)) return { ok: false, count: positions.length };
  /** @type {Spliced[]} */
  const splices = [];
  let cur = text;
  // Bottom-up keeps earlier offsets valid; the recorded lines are then re-based top-down below.
  for (const p of [...positions].reverse()) {
    const s = spliceText(cur, p, p + oldString.length, newString);
    cur = s.text;
    splices.unshift(s);
  }
  // Line numbers of each splice in the final text: shift by the line delta of the splices above it.
  let shift = 0;
  for (const s of splices) {
    const delta = s.newLines[1] - s.newLines[0] - (s.oldLines[1] - s.oldLines[0]);
    s.oldLines = [s.oldLines[0] + shift, s.oldLines[1] + shift];
    s.newLines = [s.newLines[0] + shift, s.newLines[1] + shift];
    shift += delta;
  }
  return { ok: true, text: cur, splices };
}
