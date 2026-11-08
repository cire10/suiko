// @ts-check
// Hunk -> thread attribution for a revision (design 8.3, BUILD_AMENDMENTS 4.3). For each line hunk of
// head -> working copy, in order of strength:
//   1. tagged:  a pending `apply` / `edit` (pending/<doc>.jsonl) whose new lines overlap the hunk's new lines;
//   2. hint:    a reply's `at` lines ("L90-91", "L12,L90-91"; lines of the NEW file) overlap the hunk's new lines;
//   3. overlap: the hunk's changed OLD characters intersect an actionable thread's head anchor range, widened to
//               whole lines where those lines are short (an insertion counts when it lands inside or right at the
//               edge of that range);
//   4. otherwise the hunk is unlinked, unless an `other[]` entry covers it (`at: "L12"` overlaps its new lines;
//      `at: "del:h6"` or `"h6"` names it). An `other` entry is recorded on linked hunks too.
// Tagged and hint links (both explicit) are merged; overlap is used only when neither matched. External or human
// edits cannot be told apart from agent edits: they come out unlinked and are explained with `other`.
// Pending-edit line numbers are adjusted for later tagged edits (each records oldLines/newLines), so a sequence of
// `apply`/`edit` calls attributes correctly. A tagged edit whose inserted text is no longer in the working copy
// (undone, reverted or rewritten since) is dropped: its recorded lines would tag whatever now sits there.
// A hint or overlap link explains only part of a hunk: what lies inside its threads' SCOPES (the thread's head
// anchor range plus the paragraph-level block or the section holding it; a GENERAL thread's scope is the whole doc),
// and, for a hint, what lands on the lines the `at` names (`atExplained`: text now on those lines, removed text whose
// removal point or replacement is on them; the whole hunk when all its new lines are named). `outside` reports what
// the hunk removes beyond that, which the deletion guard checks like an unlinked hunk (a "tighten this sentence"
// comment does not explain deleting the four sections around it). Anchors and scopes are widened to whole lines
// only on lines of up to WIDEN_MAX_LINE (1,000) characters: one line of a minified or generated file is no unit of
// meaning, so there they keep their exact character ranges (else any thread would explain a whole one-line report).

import { countWords } from '../diff/index.js';
import { parseLinesArg } from '../util/lines-arg.js';
import { lineIndex } from '../text/index.js';
import { preciseMapper } from './workmap.js';

/**
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {import('../../shared/types.js').PendingEdit} PendingEdit
 * @typedef {import('../../shared/types.js').LinkedBy} LinkedBy
 * @typedef {object} HunkStats
 * @property {number} removedWords words deleted or replaced
 * @property {number} insertedWords
 * @property {number} removedChars
 * @property {number} insertedChars
 * @property {number} wholeLinesRemoved old lines none of whose non-blank text survives
 * @typedef {{ removedWords: number, wholeLinesRemoved: number }} OutsideStats removal outside the linked
 *   threads' scopes and the lines their `at` names (hint / overlap links only; null when tagged, unlinked or fully
 *   inside)
 * @typedef {Hunk & { threads: string[], linkedBy: LinkedBy | null, via: string | null, other: string | null,
 *   stats: HunkStats, outside: OutsideStats | null, atExplained: Array<[number, number]> }} AttributedHunk
 *   atExplained: head ranges of the hunk that land on lines an `at` hint linking it names (explained by that link;
 *   [] for other hunks)
 * @typedef {object} Attribution
 * @property {AttributedHunk[]} hunks
 * @property {Record<string, string[]>} threadLinks thread id -> hunk ids
 * @property {Array<{ at: string, why: string, reason: string }>} unusedOther `other` entries that matched no hunk
 * @property {Array<{ thread: string, at: string, reason: string }>} badHints unparsable `at` hints
 */

/**
 * @param {object} p
 * @param {Hunk[]} p.hunks lineHunks(headSource, workingSource)
 * @param {string} p.headSource
 * @param {string} p.workingSource
 * @param {PendingEdit[]} [p.pending]
 * @param {Array<{ thread: string, at: string }>} [p.hints]
 * @param {Array<{ id: string, start: number, end: number }>} [p.threads] actionable threads with head src ranges
 * @param {Array<{ at: string, why: string }>} [p.other]
 * @param {import('./workmap.js').PreciseMapper} [p.mapper]
 * @param {Record<string, Array<[number, number]> | 'all'>} [p.scopes] head source ranges a hint / overlap link to
 *   a thread explains ('all' = the whole doc); a linked thread without a scope explains nothing beyond tagging.
 *   Omitted: every link explains its whole hunk (no `outside`).
 * @returns {Attribution}
 */
export function attribute({ hunks, headSource, workingSource, pending = [], hints = [], threads = [], other = [], mapper, scopes }) {
  const pm = mapper ?? preciseMapper(headSource, workingSource, hunks);
  const li = lineIndex(headSource);
  const tagged = relocateTagged(effectivePendingLines(pending), workingSource);

  /** @type {Array<{ thread: string, ranges: Array<[number, number]> }>} */
  const hintRanges = [];
  /** @type {Attribution['badHints']} */
  const badHints = [];
  for (const h of hints) {
    if (!h?.at) continue;
    try {
      hintRanges.push({ thread: h.thread, ranges: parseLinesArg(h.at) });
    } catch (err) {
      badHints.push({ thread: h.thread, at: h.at, reason: /** @type {Error} */ (err).message });
    }
  }

  const otherSpecs = (other ?? []).map((o) => ({ ...o, spec: parseOtherAt(o?.at), used: false }));
  const threadRanges = threads.map((t) => ({ id: t.id, ...widenToLines(li, headSource, t.start, t.end) }));
  /** @type {ReturnType<typeof lineIndex> | null} */
  let wli = null;

  /** @type {AttributedHunk[]} */
  const out = [];
  /** @type {Record<string, string[]>} */
  const threadLinks = {};
  for (const h of hunks) {
    const newRange = newLineRange(h);
    /** @type {Set<string>} */
    const explicit = new Set();
    /** @type {LinkedBy | null} */
    let linkedBy = null;
    /** @type {string | null} */
    let via = null;
    for (const e of tagged) {
      if (!e.threads?.length || !e.newLines || !overlaps(e.newLines, newRange)) continue;
      for (const t of e.threads) explicit.add(t);
      linkedBy = 'tagged';
      via ??= e.via;
    }
    /** @type {Array<[number, number]>} the `at` line ranges that link this hunk */
    const atLines = [];
    for (const hr of hintRanges) {
      const hit = hr.ranges.filter((r) => overlaps(r, newRange));
      if (hit.length) {
        explicit.add(hr.thread);
        atLines.push(...hit);
      }
    }
    if (!linkedBy && atLines.length) linkedBy = 'hint';
    /** @type {Array<[number, number]>} */
    let atExplained = [];
    if (linkedBy === 'hint' && h.oldLines > 0) atExplained = atRangesOf(pm, h, (wli ??= lineIndex(workingSource)), atLines);

    let linked = [...explicit];
    if (!linked.length) {
      const changed = pm.changedOld(h);
      linked = threadRanges.filter((t) => changed.some(([cs, ce]) => touches(cs, ce, t.start, t.end))).map((t) => t.id);
      if (linked.length) linkedBy = 'overlap';
    }

    /** @type {string | null} */
    let otherWhy = null;
    for (const o of otherSpecs) {
      if (!o.spec) continue;
      const hit = o.spec.hunk ? o.spec.hunk === h.id : o.spec.ranges.some((r) => overlaps(r, newRange));
      if (hit) {
        o.used = true;
        otherWhy ??= String(o.why ?? '');
      }
    }

    const threadsSorted = linked.sort(compareIds);
    for (const t of threadsSorted) (threadLinks[t] ??= []).push(h.id);
    /** @type {OutsideStats | null} */
    let outside = null;
    if (scopes && threadsSorted.length && linkedBy !== 'tagged' && h.oldLines > 0) {
      const sc = threadsSorted.map((t) => scopes[t] ?? []);
      if (!sc.includes('all')) {
        const explained = mergeRanges([...scopeRanges(li, headSource, /** @type {Array<[number, number]>} */ (sc.flat())), ...atExplained]);
        const r = removalStats(pm, headSource, h, li, explained);
        if (r.removedWords || r.wholeLinesRemoved) outside = { removedWords: r.removedWords, wholeLinesRemoved: r.wholeLinesRemoved };
      }
    }
    out.push({ ...h, threads: threadsSorted, linkedBy, via: linkedBy === 'tagged' ? via : null, other: otherWhy, stats: statsOf(pm, headSource, workingSource, h, li), outside, atExplained });
  }

  return {
    hunks: out,
    threadLinks,
    unusedOther: otherSpecs
      .filter((o) => !o.used)
      .map((o) => ({ at: String(o.at ?? ''), why: String(o.why ?? ''), reason: o.spec ? 'matches no hunk' : 'not a line range or hunk id' })),
    badHints,
  };
}

/**
 * Parses an `other[].at`: 'L12', 'L12-14', 'L12,L14' (new lines), 'del:h6' or 'h6' (hunk id).
 * @param {unknown} at
 * @returns {{ hunk: string | null, ranges: Array<[number, number]> } | null}
 */
export function parseOtherAt(at) {
  const s = String(at ?? '').trim();
  const m = /^(?:del:)?(h\d+)$/i.exec(s);
  if (m) return { hunk: m[1].toLowerCase(), ranges: [] };
  try {
    return { hunk: null, ranges: parseLinesArg(s) };
  } catch {
    return null;
  }
}

/**
 * Inclusive new-file line range of a hunk; a pure deletion covers the two lines around its deletion point.
 * @param {Hunk} h
 * @returns {[number, number]}
 */
export function newLineRange(h) {
  return h.newLines > 0 ? [h.newStart, h.newStart + h.newLines - 1] : [Math.max(1, h.newStart - 1), h.newStart];
}

/**
 * Inclusive old-file line range of a hunk; a pure insertion covers the two lines around its insertion point.
 * @param {Hunk} h
 * @returns {[number, number]}
 */
export function oldLineRange(h) {
  return h.oldLines > 0 ? [h.oldStart, h.oldStart + h.oldLines - 1] : [Math.max(1, h.oldStart - 1), h.oldStart];
}

/**
 * Pending tagged edits with their newLines adjusted for the tagged edits recorded after them.
 * @param {PendingEdit[]} pending
 * @returns {PendingEdit[]}
 */
export function effectivePendingLines(pending) {
  const edits = (pending ?? []).map((e) => ({ ...e, newLines: e.newLines ? /** @type {[number, number]} */ ([...e.newLines]) : undefined }));
  for (let j = 0; j < edits.length; j++) {
    const later = /** @type {any} */ (edits[j]);
    if (!later.oldLines || !later.newLines) continue;
    const [oa, ob] = later.oldLines;
    const [na, nb] = later.newLines;
    const delta = nb - na - (ob - oa);
    for (let i = 0; i < j; i++) {
      const lines = edits[i].newLines;
      if (!lines) continue;
      if (ob < lines[0]) {
        lines[0] += delta;
        lines[1] += delta;
      } else if (oa <= lines[1]) {
        lines[0] = Math.min(lines[0], na);
        lines[1] = Math.max(lines[1] + delta, nb);
      }
    }
  }
  return edits;
}

/**
 * Tagged edits whose recorded lines no longer hold their inserted text (an untracked edit above them shifted the
 * file) are re-located to the occurrence of that text nearest the recorded lines. A tagged edit whose inserted text
 * is nowhere in the working copy any more (undone by hand, `revert --hunk`, or rewritten since) is dropped: its
 * stale lines must not tag a later, unrelated change to its thread.
 * @param {PendingEdit[]} edits
 * @param {string} workingSource
 * @returns {PendingEdit[]}
 */
export function relocateTagged(edits, workingSource) {
  const wli = lineIndex(workingSource);
  /** @type {PendingEdit[]} */
  const out = [];
  for (const e of edits) {
    const text = /** @type {any} */ (e).newText;
    if (!e.newLines || typeof text !== 'string' || !text.trim()) {
      out.push(e);
      continue;
    }
    const [a, b] = e.newLines;
    const at = workingSource.slice(wli.startOf(a), wli.nextStartOf(Math.max(a, b)));
    if (at.includes(text)) {
      out.push(e);
      continue;
    }
    let best = -1;
    const near = wli.startOf(a);
    for (let i = workingSource.indexOf(text); i >= 0; i = workingSource.indexOf(text, i + 1)) {
      if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    }
    if (best < 0) continue;
    const na = wli.lineOf(best);
    out.push({ ...e, newLines: [na, wli.lineOf(best + text.length - 1)] });
  }
  return out;
}

/**
 * @param {import('./workmap.js').PreciseMapper} pm
 * @param {string} a
 * @param {string} b
 * @param {Hunk} h
 * @param {ReturnType<typeof lineIndex>} li line index of `a`
 * @returns {HunkStats}
 */
function statsOf(pm, a, b, h, li) {
  const { removedChars, removedWords, wholeLinesRemoved } = removalStats(pm, a, h, li);
  const oldLen = h.oldEndOff - h.oldStartOff;
  const newLen = h.newEndOff - h.newStartOff;
  const insertedChars = Math.max(0, newLen - (oldLen - removedChars));
  const newSlice = b.slice(h.newStartOff, h.newEndOff);
  const keptWords = countWords(a.slice(h.oldStartOff, h.oldEndOff)) - removedWords;
  return { removedWords, insertedWords: Math.max(0, countWords(newSlice) - keptWords), removedChars, insertedChars, wholeLinesRemoved };
}

/**
 * Old text a hunk removes or replaces (words, chars, whole non-blank lines none of whose text survives), leaving out
 * the `explained` old ranges (whole-line ranges; a line fully inside one is not counted).
 * @param {import('./workmap.js').PreciseMapper} pm
 * @param {string} a old text
 * @param {Hunk} h
 * @param {ReturnType<typeof lineIndex>} li line index of `a`
 * @param {Array<[number, number]>} [explained]
 * @returns {{ removedChars: number, removedWords: number, wholeLinesRemoved: number }}
 */
function removalStats(pm, a, h, li, explained = []) {
  const changed = pm.changedOld(h).filter(([s, e]) => e > s);
  let removedChars = 0;
  let removedWords = 0;
  for (const [s, e] of changed) {
    for (const [ps, pe] of subtractRanges(s, e, explained)) {
      removedChars += pe - ps;
      removedWords += countWords(a.slice(ps, pe));
    }
  }
  const kept = keptRanges(h, changed);
  let wholeLinesRemoved = 0;
  for (let l = h.oldStart; l < h.oldStart + h.oldLines; l++) {
    const ls = li.startOf(l);
    const le = li.endOf(l);
    if (!/\S/.test(a.slice(ls, le))) continue;
    if (explained.some(([es, ee]) => es <= ls && le <= ee)) continue;
    const survives = kept.some(([ks, ke]) => ks < le && ls < ke && /\S/.test(a.slice(Math.max(ks, ls), Math.min(ke, le))));
    if (!survives) wholeLinesRemoved++;
  }
  return { removedChars, removedWords, wholeLinesRemoved };
}

/**
 * [s, e) minus a set of ranges.
 * @param {number} s
 * @param {number} e
 * @param {Array<[number, number]>} cut
 * @returns {Array<[number, number]>}
 */
function subtractRanges(s, e, cut) {
  /** @type {Array<[number, number]>} */
  let out = [[s, e]];
  for (const [cs, ce] of cut) {
    /** @type {Array<[number, number]>} */
    const next = [];
    for (const [ps, pe] of out) {
      if (ce <= ps || cs >= pe) next.push([ps, pe]);
      else {
        if (cs > ps) next.push([ps, cs]);
        if (ce < pe) next.push([ce, pe]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * Old-text ranges of a hunk that survive (the complement of its changed ranges).
 * @param {Hunk} h
 * @param {Array<[number, number]>} changed
 * @returns {Array<[number, number]>}
 */
function keptRanges(h, changed) {
  /** @type {Array<[number, number]>} */
  const out = [];
  let p = h.oldStartOff;
  for (const [s, e] of [...changed].sort((x, y) => x[0] - y[0])) {
    if (s > p) out.push([p, s]);
    p = Math.max(p, e);
  }
  if (p < h.oldEndOff) out.push([p, h.oldEndOff]);
  return out;
}

/** Lines up to this long (characters, terminator aside) are units of meaning: anchors and scopes widen to them. */
export const WIDEN_MAX_LINE = 1000;

/**
 * Range [start, end) widened to whole lines where those lines are short: its start to the start of its line and its
 * end to the end of its line (terminator included) when that line has at most WIDEN_MAX_LINE characters; an edge on
 * a longer line (a minified or generated file) stays where it is.
 * @param {ReturnType<typeof lineIndex>} li
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number }}
 */
export function widenToLines(li, source, start, end) {
  const a = li.lineOf(start);
  const b = end > start ? li.lineOf(end - 1) : a;
  const s = li.endOf(a) - li.startOf(a) <= WIDEN_MAX_LINE ? li.startOf(a) : start;
  const e = li.endOf(b) - li.startOf(b) <= WIDEN_MAX_LINE ? Math.min(source.length, li.nextStartOf(b)) : end;
  return { start: s, end: Math.max(s, e) };
}

/**
 * Thread scopes as the head ranges they explain (widenToLines each).
 * @param {ReturnType<typeof lineIndex>} li
 * @param {string} source
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
export function scopeRanges(li, source, ranges) {
  return ranges.map(([a, b]) => {
    const w = widenToLines(li, source, a, b);
    return /** @type {[number, number]} */ ([w.start, w.end]);
  });
}

/**
 * Sorted, merged copy of a set of ranges (touching ones joined), so a line inside their union is inside one of them.
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
export function mergeRanges(ranges) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Head ranges of a hunk whose text lands on the given lines of the new file (the lines an `at` hint names): the old
 * text whose new place is on them (unchanged text where it now stands, removed text at the point it was removed
 * from; a removal point right at the end of the named lines counts), and a replaced range whose replacement reaches
 * onto them from above. The whole hunk when all its new lines are named, or, for a pure deletion, when the lines
 * around it are (the lines a hint names for it).
 * @param {import('./workmap.js').PreciseMapper} pm
 * @param {Hunk} h
 * @param {ReturnType<typeof lineIndex>} wli line index of the new text
 * @param {Array<[number, number]>} lines inclusive new-file line ranges that overlap the hunk's new lines
 * @returns {Array<[number, number]>} sorted
 */
export function atRangesOf(pm, h, wli, lines) {
  if (!lines.length || h.oldLines === 0) return [];
  /** @type {Array<[number, number]>} */
  const whole = [[h.oldStartOff, h.oldEndOff]];
  if (h.newLines === 0) return whole;
  const first = h.newStart;
  const last = h.newStart + h.newLines - 1;
  const named = lines.map(([a, b]) => /** @type {[number, number]} */ ([Math.max(a, first), Math.min(b, last)])).filter(([a, b]) => a <= b);
  if (coveredLines(named, first, last)) return whole;
  const changed = pm.changedOld(h).filter(([s, e]) => e > s);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const [a, b] of named) {
    const ts = wli.startOf(a);
    const te = wli.nextStartOf(b);
    // the new place of old offsets only grows with them: binary search for the old offsets placed in [ts, te]
    let lo = firstOld(h, (o) => pm.map(o, 'right') >= ts);
    const hi = firstOld(h, (o) => pm.map(o, 'right') > te);
    const before = lo > h.oldStartOff ? changed.find(([s, e]) => s < lo && lo <= e) : undefined;
    if (before && pm.mapRange(before[0], before[1]).end > ts) lo = before[0];
    if (hi > lo) out.push([lo, hi]);
  }
  return mergeRanges(out);
}

/**
 * The first old offset o of a hunk's old range [oldStartOff, oldEndOff] for which `pred` holds (pred is false, then
 * true); oldEndOff when it never holds before.
 * @param {Hunk} h
 * @param {(o: number) => boolean} pred
 * @returns {number}
 */
function firstOld(h, pred) {
  let lo = h.oldStartOff;
  let hi = h.oldEndOff;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Whether the line ranges together cover every line of [first, last].
 * @param {Array<[number, number]>} ranges
 * @param {number} first
 * @param {number} last
 */
function coveredLines(ranges, first, last) {
  let next = first;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > next) return false;
    next = Math.max(next, b + 1);
    if (next > last) return true;
  }
  return next > last;
}

/**
 * Whether a changed old range [cs, ce) (an insertion point when cs === ce) touches the range [s, e).
 * @param {number} cs @param {number} ce @param {number} s @param {number} e
 */
function touches(cs, ce, s, e) {
  if (ce > cs) return cs < e && s < ce;
  return cs >= s && cs <= e;
}

/**
 * @param {[number, number] | number[]} a
 * @param {[number, number] | number[]} b
 */
function overlaps(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** @param {string} a @param {string} b */
function compareIds(a, b) {
  const na = Number(/\d+$/.exec(a)?.[0] ?? NaN);
  const nb = Number(/\d+$/.exec(b)?.[0] ?? NaN);
  if (Number.isFinite(na) && Number.isFinite(nb) && a.replace(/\d+$/, '') === b.replace(/\d+$/, '')) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
