// @ts-check
// Quote search over source (or rendered) text: the bridge between what the reviewer selected in the rendered
// document and the exact source slice the agent edits (BUILD_AMENDMENTS 3.2, FROZEN).
//
// findQuote(hay, needle, opts) cascades through three modes and returns the candidates of the first mode that
// matches, best first:
//   'exact'  - literal occurrences of `needle`;
//   'ws'     - whitespace-normalised occurrences (runs of whitespace compare equal, ends trimmed);
//   'markup' - (only with markupTolerant) occurrences in the markup-stripped projection of `hay` (toPlain) with
//              all whitespace ignored, so inline markup, entities, line breaks and indentation between or around
//              words are tolerated. Matches are widened to keep emphasis/code/link markup (Markdown) or tags
//              (HTML) balanced when the counterpart is adjacent.
// Each result is { start, end, score, mode } with [start, end) a half-open UTF-16 range into `hay`.
// score = (50 * quoteSim + 20 * prefixSim + 20 * suffixSim + 2 * proximity) / 92, where quoteSim is 1 for every
// mode, prefix/suffix similarity compares the rendered context against the plain-text projection of the
// source around the match (missing context counts as 1), and proximity = 1 - |start - hint| / hay.length
// (1 when no hint). Ties are broken by start offset, so results are deterministic.
//
// Extension (not in the frozen contract): opts.range = [from, to] restricts candidates to that window of `hay`
// while still scoring context outside it; opts.format may also be 'text' (hay is already plain text).

import { CONTEXT_CHARS } from '../../shared/protocol.js';
import { collapseWs, normalizeWs, squeezeWs } from './normalize.js';
import { footnoteOrder, toPlain } from './plain.js';

export { normalizeWs } from './normalize.js';

/**
 * @typedef {Object} QuoteMatch
 * @property {number} start
 * @property {number} end
 * @property {number} score
 * @property {'exact'|'ws'|'markup'} mode
 */

/**
 * @typedef {Object} FindQuoteOptions
 * @property {string} [prefix]          rendered text just before the quote
 * @property {string} [suffix]          rendered text just after the quote
 * @property {number|null} [hint]       expected start offset in `hay`
 * @property {boolean} [markupTolerant] enable the 'markup' mode
 * @property {'markdown'|'html'|'text'} [format]  markup flavour of `hay` (default 'markdown')
 * @property {[number, number]} [range] only report candidates starting and ending inside hay[from, to)
 * @property {number} [maxCandidates]   cap on scored candidates per mode (default 1000)
 */

/**
 * @param {string} hay
 * @param {string} needle
 * @param {FindQuoteOptions} [opts]
 * @returns {QuoteMatch[]}
 */
export function findQuote(hay, needle, opts = {}) {
  const { prefix = '', suffix = '', hint = null, markupTolerant = false, format = 'markdown' } = opts;
  const maxCandidates = opts.maxCandidates ?? 1000;
  if (typeof hay !== 'string' || typeof needle !== 'string' || needle.trim() === '') return [];
  const from = Math.max(0, opts.range?.[0] ?? 0);
  const to = Math.min(hay.length, opts.range?.[1] ?? hay.length);
  if (to <= from) return [];
  // Markdown footnote refs render as numbers ordered over the whole document (hay is the whole source).
  const footnotes = format === 'markdown' && markupTolerant ? footnotesOf(hay) : null;
  const ctx = { hay, prefix, suffix, hint, format, len: hay.length, footnotes };

  /** @type {[number, number][]} */
  let spans = exactSpans(hay, needle, from, to, maxCandidates);
  /** @type {'exact'|'ws'|'markup'} */
  let mode = 'exact';
  if (!spans.length) {
    spans = wsSpans(hay, needle, from, to, maxCandidates);
    mode = 'ws';
  }
  if (!spans.length && markupTolerant && format !== 'text') {
    spans = markupSpans(hay, needle, from, to, format, maxCandidates, footnotes);
    mode = 'markup';
  }
  const results = spans.map(([start, end]) => ({ start, end, score: scoreAt(ctx, start, end), mode }));
  results.sort((a, b) => b.score - a.score || a.start - b.start || a.end - b.end);
  return results;
}

/**
 * Approximate the rendered text of a source slice (markup stripped, entities decoded). Whitespace is kept as
 * in the source except where markup was removed; callers normalise.
 * @param {'markdown'|'html'|string} format
 * @param {string} sourceSlice
 * @param {{ lineStart?: boolean }} [opts]  lineStart=false when the slice starts mid-line
 * @returns {string}
 */
export function sourceToPlainText(format, sourceSlice, opts) {
  if (!sourceSlice) return '';
  return toPlain(format, sourceSlice, opts).text;
}

/**
 * Normalised similarity: 1 - levenshtein(a', b') / max(|a'|, |b'|), where a', b' are the first 64 chars.
 * Two empty strings are identical (1).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const x = (a || '').slice(0, 64);
  const y = (b || '').slice(0, 64);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1;
  return 1 - levenshtein(x, y) / max;
}

/**
 * Classic two-row Levenshtein distance.
 * @param {string} a
 * @param {string} b
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {string} hay @param {string} needle @param {number} from @param {number} to @param {number} max
 * @returns {[number, number][]}
 */
function exactSpans(hay, needle, from, to, max) {
  /** @type {[number, number][]} */
  const out = [];
  for (let i = hay.indexOf(needle, from); i !== -1 && i + needle.length <= to; i = hay.indexOf(needle, i + 1)) {
    out.push([i, i + needle.length]);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {string} hay @param {string} needle @param {number} from @param {number} to @param {number} max
 * @returns {[number, number][]}
 */
function wsSpans(hay, needle, from, to, max) {
  const n = normalizeWs(needle).text;
  if (!n) return [];
  const h = normalizeWs(hay.slice(from, to));
  /** @type {[number, number][]} */
  const out = [];
  for (let i = h.text.indexOf(n); i !== -1; i = h.text.indexOf(n, i + 1)) {
    out.push([from + h.map[i], from + h.map[i + n.length - 1] + 1]);
    if (out.length >= max) break;
  }
  return out;
}

/** @type {{ hay: string, order: Map<string, number> } | null} */
let lastFootnotes = null;

/**
 * footnoteOrder of a Markdown source, memoised for the last source (findQuote is called repeatedly on one doc).
 * @param {string} hay
 * @returns {Map<string, number> | null}
 */
function footnotesOf(hay) {
  if (!hay.includes('[^')) return null;
  if (lastFootnotes?.hay !== hay) lastFootnotes = { hay, order: footnoteOrder(hay) };
  return lastFootnotes.order.size ? lastFootnotes.order : null;
}

/**
 * @param {string} hay @param {string} needle @param {number} from @param {number} to
 * @param {string} format @param {number} max @param {Map<string, number> | null} [footnotes]
 * @returns {[number, number][]}
 */
function markupSpans(hay, needle, from, to, format, max, footnotes = null) {
  const window = hay.slice(from, to);
  const plain = toPlain(format, window, { lineStart: from === 0 || hay[from - 1] === '\n', footnotes });
  const sq = squeezeWs(plain.text);
  /** @type {Set<string>} */
  const needles = new Set();
  const n1 = squeezeWs(needle).text;
  if (n1) needles.add(n1);
  const n2 = squeezeWs(toPlain(format, needle).text).text;
  if (n2) needles.add(n2);
  // A '|' in a GFM table cell is written '\|' (the backslash is removed even inside code spans); a window that is
  // only part of the row cannot tell it is in a table, so also look for the escaped spelling.
  if (format === 'markdown' && n1.includes('|')) needles.add(n1.replace(/\\?\|/g, '\\|'));
  /** @type {Map<string, [number, number]>} */
  const found = new Map();
  for (const n of needles) {
    for (let i = sq.text.indexOf(n); i !== -1; i = sq.text.indexOf(n, i + 1)) {
      const pi = sq.map[i];
      const pj = sq.map[i + n.length - 1];
      let start = from + plain.map[pi];
      let end = from + plain.mapEnd[pj];
      if (format === 'markdown') [start, end] = balanceMarkdown(hay, start, end, from, to);
      else if (format === 'html') [start, end] = balanceHtml(hay, start, end, from, to);
      found.set(`${start}:${end}`, [start, end]);
      if (found.size >= max) break;
    }
  }
  // The raw needle and its markup-stripped form can both match one occurrence (e.g. a code line "# check ..."
  // whose '#' the stripped needle drops as a heading marker): a span nested in another is the same occurrence.
  const spans = [...found.values()];
  return spans.filter(([s0, e0], k) => !spans.some(([s1, e1], j) => j !== k && s1 <= s0 && e0 <= e1 && (s1 < s0 || e0 < e1)));
}

/**
 * Widen a Markdown match so the slice keeps inline markup balanced: an odd number of '**', '__', '~~', '`',
 * '*' or '_' delimiters is completed by an adjacent delimiter just outside the range, and a partial link
 * ("text](url)" or "[text") is extended to the whole link.
 * @param {string} hay @param {number} start @param {number} end @param {number} lo @param {number} hi
 * @returns {[number, number]}
 */
export function balanceMarkdown(hay, start, end, lo = 0, hi = hay.length) {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const d of ['**', '__', '~~', '`', '*', '_']) {
      const slice = hay.slice(start, end);
      if (countDelim(slice, d) % 2 === 0) continue;
      if (start - d.length >= lo && hay.slice(start - d.length, start) === d && !isSameCharBefore(hay, start - d.length, d)) {
        start -= d.length;
        changed = true;
      } else if (end + d.length <= hi && hay.slice(end, end + d.length) === d && hay[end + d.length] !== d[0]) {
        end += d.length;
        changed = true;
      }
    }
    // links: "text](url)" missing its '[' / "[text" missing its "](url)". Bracket ORDER matters, not only the
    // counts: "RFC][rfc-keys] and the [gateway README" has as many '[' as ']' but cuts into two links.
    const slice = hay.slice(start, end);
    const { unmatchedClose, open } = bracketBalance(slice);
    let linkDone = false;
    if (unmatchedClose) {
      const lb = hay.lastIndexOf('[', start - 1);
      const nl = hay.lastIndexOf('\n\n', start - 1);
      if (lb >= lo && lb > nl && start - lb < 512) {
        start = hay[lb - 1] === '!' && lb - 1 >= lo ? lb - 1 : lb;
        changed = true;
        linkDone = true;
      }
    }
    if (open > 0) {
      const m = /^[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?/.exec(hay.slice(end, Math.min(hi, end + 1024)));
      if (m) {
        end += m[0].length;
        changed = true;
        linkDone = true;
      }
    }
    if (!linkDone && /\]$/.test(slice) && (hay[end] === '(' || hay[end] === '[')) {
      const closer = hay[end] === '(' ? ')' : ']';
      const close = hay.indexOf(closer, end);
      if (close >= 0 && close < hi && close - end < 1024 && !hay.slice(end, close).includes('\n')) {
        end = close + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [start, end];
}

/**
 * Unescaped square brackets of a slice in order: whether a ']' closes a '[' that is outside the slice, and how many
 * '[' are left open at its end.
 * @param {string} slice
 * @returns {{ unmatchedClose: boolean, open: number }}
 */
function bracketBalance(slice) {
  let depth = 0;
  let unmatchedClose = false;
  for (let k = 0; k < slice.length; k++) {
    const c = slice[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth > 0) depth--;
      else unmatchedClose = true;
    }
  }
  return { unmatchedClose, open: depth };
}

/**
 * Widen an HTML match so tags cut by the range are completed when their counterpart is immediately adjacent
 * outside it (only markup in between): "checkout</strong>" whose "<strong>" directly precedes the range becomes
 * "<strong>checkout</strong>".
 * @param {string} hay @param {number} start @param {number} end @param {number} lo @param {number} hi
 * @returns {[number, number]}
 */
export function balanceHtml(hay, start, end, lo = 0, hi = hay.length) {
  const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>/g;
  /** @type {string[]} */
  const unmatchedClose = [];
  /** @type {string[]} */
  const open = [];
  const slice = hay.slice(start, end);
  for (let m = TAG.exec(slice); m; m = TAG.exec(slice)) {
    const name = m[2].toLowerCase();
    if (m[3] || VOID_HTML.has(name)) continue;
    if (!m[1]) open.push(name);
    else if (open.length && open[open.length - 1] === name) open.pop();
    else unmatchedClose.push(name);
  }
  for (const name of unmatchedClose) {
    // walk back over adjacent tags looking for the opener
    let p = start;
    for (let guard = 0; guard < 8 && p > lo && hay[p - 1] === '>'; guard++) {
      const lt = hay.lastIndexOf('<', p - 1);
      if (lt < lo) break;
      const tag = /^<([A-Za-z][A-Za-z0-9-]*)\b/.exec(hay.slice(lt, p));
      p = lt;
      if (tag && tag[1].toLowerCase() === name) {
        start = lt;
        break;
      }
    }
  }
  for (const name of open.reverse()) {
    const re = new RegExp(`^(?:\\s*<[^>]+>)*?\\s*</${name}\\s*>`, 'i');
    const m = re.exec(hay.slice(end, Math.min(hi, end + 512)));
    if (m) end += m[0].length;
  }
  return [start, end];
}

const VOID_HTML = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source',
  'track', 'wbr']);

/**
 * Count delimiter occurrences, not counting single '*'/'_' that are part of a doubled run.
 * @param {string} s @param {string} d
 */
function countDelim(s, d) {
  if (d.length === 2) return s.split(d).length - 1;
  const doubled = d + d;
  return s.split(doubled).join('').split(d).length - 1;
}

/** @param {string} hay @param {number} at @param {string} d */
function isSameCharBefore(hay, at, d) {
  return d.length === 1 && hay[at - 1] === d;
}

/**
 * Score a candidate by prefix/suffix similarity and proximity to the hint.
 * @param {{ hay: string, prefix: string, suffix: string, hint: number|null, format: string, len: number,
 *   footnotes?: Map<string, number> | null }} ctx
 * @param {number} start @param {number} end
 */
function scoreAt(ctx, start, end) {
  const k = CONTEXT_CHARS;
  let prefixSim = 1;
  let suffixSim = 1;
  const p = collapseWs(ctx.prefix).trim().slice(-k);
  const s = collapseWs(ctx.suffix).trim().slice(0, k);
  if (p) {
    const a = Math.max(0, start - 4 * k);
    const before = plainContext(ctx, a, start, a === 0 || ctx.hay[a - 1] === '\n').trim();
    prefixSim = similarity(before.slice(-p.length), p);
  }
  if (s) {
    const after = plainContext(ctx, end, Math.min(ctx.len, end + 4 * k), false).trim();
    suffixSim = similarity(after.slice(0, s.length), s);
  }
  const proximity = ctx.hint == null ? 1 : Math.max(0, 1 - Math.abs(start - ctx.hint) / Math.max(ctx.len, 1));
  return (50 + 20 * prefixSim + 20 * suffixSim + 2 * proximity) / 92;
}

/**
 * Plain-text projection of hay[a, b) with collapsed whitespace.
 * @param {{ hay: string, format: string, footnotes?: Map<string, number> | null }} ctx @param {number} a
 * @param {number} b @param {boolean} lineStart
 */
function plainContext(ctx, a, b, lineStart) {
  const raw = ctx.hay.slice(a, b);
  const text = ctx.format === 'text' ? raw : toPlain(ctx.format, raw, { lineStart, footnotes: ctx.footnotes ?? null }).text;
  return collapseWs(text);
}

const WORD_TAIL = /[\p{L}\p{N}_]+$/u;
const WORD_HEAD = /^[\p{L}\p{N}_]+/u;
const WORD_START = /^[\p{L}\p{N}_]/u;
const WORD_END = /[\p{L}\p{N}_]$/u;

/**
 * For display only (`on:` and decisions.md context): extends a selection that starts or ends inside a word to the
 * whole word, using the text just before (`prefix`) and after (`suffix`) it. 'eploy to stagin' with prefix
 * '1. D' and suffix 'g; route' reads 'Deploy to staging'. Anchors keep the exact selection.
 * @param {string} text
 * @param {string | null | undefined} prefix
 * @param {string | null | undefined} suffix
 * @returns {string}
 */
export function toWordBounds(text, prefix, suffix) {
  let out = String(text ?? '');
  if (!out) return out;
  if (WORD_START.test(out)) out = (String(prefix ?? '').match(WORD_TAIL)?.[0] ?? '') + out;
  if (WORD_END.test(out)) out += String(suffix ?? '').match(WORD_HEAD)?.[0] ?? '';
  return out;
}

/**
 * True when `a` ends with a word character and `b` starts with one: text cut between them splits a word. Only
 * meaningful on source text: rendered text runs blocks together ('Footnotes' + 'Measured').
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function splitsWord(a, b) {
  return WORD_END.test(String(a ?? '')) && WORD_START.test(String(b ?? ''));
}
