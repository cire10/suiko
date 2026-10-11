// @ts-check
// Text relocation primitives for re-anchoring (design 7.4 steps 3-4, BUILD_AMENDMENTS 4.2):
//
//   exactFind(hay, needle, opts) -> { start, end, score, quoteSim: 1, errors: 0, count } | null
//     every literal occurrence of `needle`, scored by
//       score = (50 * 1 + 20 * prefixSim + 20 * suffixSim + 2 * proximity) / 92
//     The best candidate is accepted when score >= minScore. Extension: a single occurrence of a distinctive
//     needle (>= UNIQUE_MIN_CHARS non-whitespace chars) is accepted regardless of context, so a long paragraph
//     moved under a new heading is still found (its 32-char source context is entirely new) - unless the caller
//     says the needle was not unique before (allowUnique: false: the survivor may be another copy).
//
//   fuzzyFind(hay, needle, opts) -> { start, end, score, quoteSim, errors } | null
//     approx-string-match (Myers) with maxErrors = min(256, floor(0.4 * len)), first in the window
//     [hint - (2*len + 2000), hint + len + (2*len + 2000)], then in the whole range. Needles longer than 256 chars
//     search their first and last 64 chars and join head/tail matches whose span is 0.5x-1.5x the needle length;
//     the joined span is then aligned against the full needle to get its error count.
//       quoteSim = 1 - errors / len
//       score    = (50 * quoteSim + 20 * prefixSim + 20 * suffixSim + 2 * proximity) / 92
//     accepted when score >= minScore and quoteSim >= minQuoteSim. A match edge that cuts a word in half is
//     widened to the word boundary (approximate matches otherwise often start or end mid-word).
//
// sim() is 1 - levenshtein / maxLen on at most 32 chars (the chars adjacent to the match); an empty expected
// context counts as 1 (unknown, not a mismatch). proximity = max(0, 1 - |pos - hint| / max(len(hay), 1)), 1 when
// no hint is given. Both functions accept `range: [from, to]` to restrict candidates while scoring context
// outside the range. Results are deterministic: ties go to the candidate nearest the hint, then the earliest.

import search from 'approx-string-match';
import { CONTEXT_CHARS } from '../../shared/protocol.js';
import { levenshtein } from '../text/index.js';

/** A single exact occurrence of a needle at least this long (non-whitespace chars) is accepted on its own. */
export const UNIQUE_MIN_CHARS = 24;
const MAX_ERRORS_CAP = 256;
const LONG_NEEDLE = 256;
const HEAD_TAIL = 64;
const MAX_CANDIDATES = 400;

/**
 * @typedef {Object} FindOptions
 * @property {string} [prefix]       expected text just before the match (source context)
 * @property {string} [suffix]       expected text just after the match
 * @property {number|null} [hint]    expected start offset
 * @property {number} [minScore]     default 0.65
 * @property {number} [minQuoteSim]  default 0.6 (fuzzyFind only)
 * @property {[number, number]} [range]  only candidates inside hay[from, to)
 * @property {number} [contextChars] chars compared on each side (default 32)
 * @property {boolean} [allowUnique]  exactFind: accept a single distinctive occurrence regardless of context
 *                                    (default true; pass false when the needle was not unique before the edit)
 * @property {Array<[number, number]>} [exclude] ranges of hay that are never returned: a candidate covering at
 *                                    least half of one (or half of itself inside one) is dropped, and is not
 *                                    counted as an occurrence for allowUnique
 */

/**
 * @typedef {Object} FindResult
 * @property {number} start
 * @property {number} end
 * @property {number} score
 * @property {number} quoteSim
 * @property {number} errors
 * @property {number} [count]  exactFind: number of occurrences
 */

/**
 * Normalised similarity of two context strings on at most `n` chars: 1 - levenshtein / maxLen.
 * @param {string} a @param {string} b @param {number} [n]
 */
export function contextSim(a, b, n = CONTEXT_CHARS) {
  const x = a.slice(-n);
  const y = b.slice(-n);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1;
  return 1 - levenshtein(x, y) / max;
}

/**
 * Score a candidate span by its context and position (design 7.4).
 * @param {string} hay @param {number} start @param {number} end @param {number} quoteSim
 * @param {FindOptions} opts
 */
export function scoreCandidate(hay, start, end, quoteSim, opts) {
  const n = opts.contextChars ?? CONTEXT_CHARS;
  const prefix = (opts.prefix ?? '').slice(-n);
  const suffix = (opts.suffix ?? '').slice(0, n);
  const prefixSim = prefix ? contextSim(hay.slice(Math.max(0, start - prefix.length), start), prefix, n) : 1;
  const suffixSim = suffix ? contextSim(reverse(hay.slice(end, end + suffix.length)), reverse(suffix), n) : 1;
  const hint = opts.hint;
  const proximity = hint == null ? 1 : Math.max(0, 1 - Math.abs(start - hint) / Math.max(hay.length, 1));
  return (50 * quoteSim + 20 * prefixSim + 20 * suffixSim + 2 * proximity) / 92;
}

/**
 * Best literal occurrence of `needle` (design 7.4 step 3).
 * @param {string} hay @param {string} needle @param {FindOptions} [opts]
 * @returns {FindResult|null}
 */
export function exactFind(hay, needle, opts = {}) {
  if (!needle || typeof hay !== 'string') return null;
  const [from, to] = rangeOf(hay, opts.range);
  const minScore = opts.minScore ?? 0.65;
  /** @type {FindResult[]} */
  const cands = [];
  let count = 0;
  for (let i = hay.indexOf(needle, from); i !== -1 && i + needle.length <= to; i = hay.indexOf(needle, i + 1)) {
    if (excluded(opts.exclude, i, i + needle.length)) continue;
    count++;
    if (cands.length < MAX_CANDIDATES * 4) {
      const end = i + needle.length;
      cands.push({ start: i, end, score: scoreCandidate(hay, i, end, 1, opts), quoteSim: 1, errors: 0 });
    }
  }
  if (!cands.length) return null;
  const best = pickBest(cands, opts.hint);
  const distinctive = opts.allowUnique !== false && count === 1 && needle.replace(/\s+/g, '').length >= UNIQUE_MIN_CHARS;
  if (best.score < minScore && !distinctive) return null;
  return { ...best, count };
}

/**
 * Best approximate occurrence of `needle` (design 7.4 step 4).
 * @param {string} hay @param {string} needle @param {FindOptions} [opts]
 * @returns {FindResult|null}
 */
export function fuzzyFind(hay, needle, opts = {}) {
  if (!needle || typeof hay !== 'string') return null;
  const [from, to] = rangeOf(hay, opts.range);
  if (to <= from) return null;
  const minScore = opts.minScore ?? 0.65;
  const minQuoteSim = opts.minQuoteSim ?? 0.6;
  const len = needle.length;
  /** @type {[number, number][]} */
  const windows = [];
  if (opts.hint != null && Number.isFinite(opts.hint)) {
    const pad = 2 * len + 2000;
    const w0 = Math.max(from, Math.floor(opts.hint) - pad);
    const w1 = Math.min(to, Math.floor(opts.hint) + len + pad);
    if (w1 > w0 && (w0 > from || w1 < to)) windows.push([w0, w1]);
  }
  windows.push([from, to]);
  for (const [w0, w1] of windows) {
    const cands = len > LONG_NEEDLE ? longCandidates(hay, needle, w0, w1) : shortCandidates(hay, needle, w0, w1);
    /** @type {FindResult[]} */
    const scored = [];
    for (const c of cands) {
      if (excluded(opts.exclude, c.start, c.end)) continue;
      const quoteSim = Math.max(0, 1 - c.errors / len);
      if (quoteSim < minQuoteSim) continue;
      const score = scoreCandidate(hay, c.start, c.end, quoteSim, opts);
      if (score >= minScore) scored.push({ start: c.start, end: c.end, score, quoteSim, errors: c.errors });
    }
    if (scored.length) return snapToWords(hay, needle, pickBest(scored, opts.hint), opts, w0, w1);
  }
  return null;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Approximate matches can start or end inside a word ("y second use of a rotated refr", "Date.n"). A match edge
 * that cuts a word is moved out to the word boundary (at most 32 chars, never outside the window), unless the
 * needle's own context continues that word (the original anchor itself started / ended mid-word).
 * @param {string} hay @param {string} needle @param {FindResult} m @param {FindOptions} opts
 * @param {number} lo @param {number} hi
 * @returns {FindResult}
 */
function snapToWords(hay, needle, m, opts, lo, hi) {
  let { start, end } = m;
  const isWord = (/** @type {string|undefined} */ ch) => ch != null && WORD_CHAR.test(ch);
  const prefix = opts.prefix ?? '';
  const suffix = opts.suffix ?? '';
  const cutsStart = isWord(hay[start]) && isWord(hay[start - 1]);
  if (cutsStart && isWord(needle[0]) && !isWord(prefix[prefix.length - 1])) {
    for (let k = 0; k < 32 && start > lo && isWord(hay[start - 1]); k++) start--;
  }
  const cutsEnd = isWord(hay[end - 1]) && isWord(hay[end]);
  if (cutsEnd && !isWord(suffix[0])) {
    for (let k = 0; k < 32 && end < hi && isWord(hay[end]); k++) end++;
  }
  return start === m.start && end === m.end ? m : { ...m, start, end };
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {string} hay @param {[number, number]|undefined} range
 * @returns {[number, number]}
 */
function rangeOf(hay, range) {
  const from = Math.max(0, Math.min(hay.length, Math.floor(range?.[0] ?? 0)));
  const to = Math.max(from, Math.min(hay.length, Math.floor(range?.[1] ?? hay.length)));
  return [from, to];
}

/**
 * @param {FindResult[]} cands @param {number|null|undefined} hint
 * @returns {FindResult}
 */
function pickBest(cands, hint) {
  const dist = (/** @type {FindResult} */ c) => (hint == null ? 0 : Math.abs(c.start - hint));
  return [...cands].sort((a, b) => b.score - a.score || dist(a) - dist(b) || a.start - b.start || a.end - b.end)[0];
}

/**
 * Min-error approximate matches of a needle of at most LONG_NEEDLE chars inside hay[w0, w1).
 * @param {string} hay @param {string} needle @param {number} w0 @param {number} w1
 * @returns {{ start: number, end: number, errors: number }[]}
 */
function shortCandidates(hay, needle, w0, w1) {
  const k = Math.min(MAX_ERRORS_CAP, Math.floor(0.4 * needle.length));
  const matches = search(hay.slice(w0, w1), needle, k).map((m) => ({ start: w0 + m.start, end: w0 + m.end, errors: m.errors }));
  return dedupe(matches, needle.length);
}

/**
 * Candidates for a long needle: direct matches (error cap 256) plus head/tail joins, each aligned to the needle.
 * @param {string} hay @param {string} needle @param {number} w0 @param {number} w1
 * @returns {{ start: number, end: number, errors: number }[]}
 */
function longCandidates(hay, needle, w0, w1) {
  const len = needle.length;
  const text = hay.slice(w0, w1);
  /** @type {{ start: number, end: number, errors: number }[]} */
  const out = [];
  const direct = search(text, needle, Math.min(MAX_ERRORS_CAP, Math.floor(0.4 * len)));
  for (const m of dedupe(direct, len)) out.push({ start: w0 + m.start, end: w0 + m.end, errors: m.errors });
  const head = needle.slice(0, HEAD_TAIL);
  const tail = needle.slice(-HEAD_TAIL);
  const kk = Math.floor(0.4 * HEAD_TAIL);
  const heads = dedupe(search(text, head, kk), HEAD_TAIL).slice(0, 20);
  const tails = dedupe(search(text, tail, kk), HEAD_TAIL).slice(0, 20);
  /** @type {Set<string>} */
  const seen = new Set(out.map((c) => `${c.start}:${c.end}`));
  for (const h of heads) {
    for (const t of tails) {
      const span = t.end - h.start;
      if (span < 0.5 * len || span > 1.5 * len) continue;
      // Align the whole needle inside the joined span (plus a little slack) to count its errors.
      const s0 = Math.max(0, h.start - 8);
      const s1 = Math.min(text.length, t.end + 8);
      const aligned = search(text.slice(s0, s1), needle, len);
      for (const m of dedupe(aligned, len).slice(0, 2)) {
        const c = { start: w0 + s0 + m.start, end: w0 + s0 + m.end, errors: m.errors };
        const key = `${c.start}:${c.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * Collapse clusters of overlapping min-error matches (adjacent end positions) to the one whose length is
 * closest to the needle's; cap the number of candidates.
 * @template {{ start: number, end: number, errors: number }} M
 * @param {M[]} matches @param {number} len
 * @returns {M[]}
 */
function dedupe(matches, len) {
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  /** @type {M[]} */
  const out = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      const better = m.errors < last.errors ||
        (m.errors === last.errors && Math.abs(m.end - m.start - len) < Math.abs(last.end - last.start - len));
      if (better) out[out.length - 1] = m;
      continue;
    }
    out.push(m);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Whether [s, e) is (mostly) one of the excluded ranges.
 * @param {Array<[number, number]> | undefined} ranges @param {number} s @param {number} e
 */
function excluded(ranges, s, e) {
  if (!ranges?.length) return false;
  for (const [x, y] of ranges) {
    const overlap = Math.min(e, y) - Math.max(s, x);
    if (overlap > 0 && (2 * overlap >= y - x || 2 * overlap >= e - s)) return true;
  }
  return false;
}

/** @param {string} s */
function reverse(s) {
  return s.split('').reverse().join('');
}
