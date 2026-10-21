// @ts-check
// Re-anchoring one anchor from version a to version b (design 7.4, BUILD_AMENDMENTS 4.2, which wins).
//
//   reanchor({ anchor, originalAnchor?, fromSource, toSource, hunks?, mapper?, toRender?, format?, link?,
//              override?, config?, version?, docPath?, assets? }) -> Anchor (with state)
//
// Order (amendments 4.2), for every anchor kind:
//   0. override ({lines:[a,b]} | {quote}) -> anchorFromLines / anchorFromQuote on b: state 'exact', mappedBy 'override'.
//   1. untouched first: the anchor's start is mapped through the hunks at character level (offsetMapper outside
//      hunks; inside a hunk through its word diff, so text on a changed line that was itself not changed still
//      maps) and the slice at the mapped position must equal src.text -> 'exact' (same lines) or 'moved'.
//      Not taken when a linked hunk's word diff changes characters inside the range (step 2 then applies).
//   2. linked & intersecting: when a hunk linked to the thread (link.hunkIds) changed characters inside the
//      anchored range: if both end characters of the range survived, the anchor spans the text between them
//      (only the inside was rewritten, e.g. an applied suggestion); else it goes to the best fuzzy match of
//      src.text inside those hunks' new ranges (quote similarity >= 0.7, so a heavy rewrite is not narrowed to a
//      fragment), else to their whole new lines -> 'edited'. When the linked hunks only deleted lines (an empty
//      new range), steps 3-4 run first so moved text is followed ('moved', or 'edited' when reworded, which must
//      lie mostly in text the version added: a similar sibling it kept is not the text) before the anchor falls
//      back to the empty deletion point. A link alone never moves an anchor whose text was untouched
//      (a hunk merely adjacent to the range, or changing other words of its lines, does not intersect it).
//      Element / region / cell anchors relocate only to a same-tag element in that range (preferring the same
//      src/alt); if there is none they keep the old position mapped through the mapper ('edited').
//   3. exact elsewhere (exactFind: prefix/suffix + proximity scoring) -> 'exact' when on the same lines, else 'moved'.
//      A text that occurred more than once in a must be confirmed by its context (no "unique survivor" shortcut),
//      and the unchanged image of ANOTHER old copy of the text is never a candidate (here and in steps 2, 4, 5):
//      when the anchored copy is deleted, an identical sentence elsewhere is not "the same text, moved".
//   4. fuzzy (fuzzyFind, approx-string-match) -> 'changed'.
//   5. steps 3-4 again with the thread's ORIGINAL anchor (an exact hit is 'moved', a fuzzy one 'changed').
//   6. else 'orphaned': src becomes an empty range at the mapped position, srid/endSrid null, and `lastKnown`
//      keeps the previous successful anchor (an orphan is retried from its lastKnown text on the next version).
// Kind specifics:
//   element: after locating the text, a same-tag element overlapping it is required (best fingerprint wins) and,
//     unless untouched, its fingerprint must still score >= 0.5 (similar text can belong to a sibling element);
//     otherwise fingerprint scoring over all same-tag elements (accept >= 0.5) -> 'changed'. A changed asset hash
//     (manifest `assets` of b vs element.assetSha256) sets assetChanged: true and turns exact/moved into
//     'changed' ('edited' when link.linked: amendments 4.5 counts the thread as linked to the asset change).
//     Mermaid nodes are re-narrowed to the fence lines of svg.nodeId (svg.label follows the new definition).
//   cell: (1) the cell / row / table element whose text is intact at its mapped position; else (2) a table holding
//     the exact rowKey and colHeader (nearest the old position); else (3) the table at the mapped position with
//     fuzzy keys (similarity >= 0.7; a column/row index only when the stored key is empty). Then the row by
//     rowKey and the column by colHeader; scope row / column / table anchor on the tr / table. Keys are refreshed.
//   section (and locks): heading text (exact, then fuzzy >= 0.6) at the same level, nearest to the mapped
//     position, else the exact heading text at another level (promoted / demoted heading); the extent is
//     recomputed with sectionRange: 'exact'/'moved' only when the whole section text is unchanged, else
//     'edited' (a linked hunk changed the old extent or lies in the new one) or 'changed'.
//   snip: located like text (its src is the covered blocks' whole lines; a changed range is grown back to the
//     blocks starting / ending inside it and to whole lines); quote stays null; the box's container
//     element is re-resolved (snip.js): the same tag at the precisely mapped start, else the only same-tag element
//     with the same label, and it must still overlap the snip's new lines; else the container (and the region
//     drawn in it) is dropped. Without a render the container's offsets are carried through the mapper.
// After success quote / srid / endSrid / section / lines / element / code are recomputed against b's render:
// quote = the previous quote while src.text is unchanged, else sourceToPlainText of the new slice. Without
// `toRender` the anchor is relocated in the source only (srid/endSrid null, element data kept).
// `hunks` may be omitted or be manifest hunks without offsets: lineHunks(fromSource, toSource) is used then
// (ids are deterministic, so link.hunkIds stay valid).

import { lineHunks, offsetMapper } from '../diff/index.js';
import { hunkWordOps } from '../diff/words.js';
import { UsageError } from '../store/errors.js';
import { collapseWs, lineIndex, similarity } from '../text/index.js';
import { anchorFromLines, anchorFromQuote, codeTargetOf, hostOf, sectionRange } from './create.js';
import {
  anchorElement, bestFingerprintMatch, elementFingerprint, FINGERPRINT_ACCEPT, fingerprintOfElement, fingerprintScore,
} from './fingerprint.js';
import { exactFind, fuzzyFind } from './fuzzy.js';
import { mermaidLabelIn, narrowMermaid } from './mermaid.js';
import { snipContainerOf, snipSpan } from './snip.js';
import { findCell, tableOf } from './table.js';
import {
  anchoringConfig, clone, contentHostOf, deepestContaining, elementLabelOf, elementsByTag, formatOf,
  makeSrc, nodeOf, plainQuote, sectionOf, sridSpan,
} from './util.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').AnchorState} AnchorState
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {import('../diff/offsets.js').OffsetMapper} OffsetMapper
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {import('../text/lines.js').LineIndex} LineIndex
 * @typedef {{ hunkIds?: string[], linked?: boolean } | null} Link
 * @typedef {{ lines?: number[], quote?: string, version?: number } | null} Override
 * @typedef {{ start: number, end: number, how: 'untouched'|'linked'|'exact'|'fuzzy', R?: [number, number] }} Loc
 * @typedef {{ mapped: boolean, original: boolean, hint: number }} Opt
 */

/**
 * @typedef {Object} ReCtx
 * @property {string} from
 * @property {string} to
 * @property {Hunk[]} hunks
 * @property {OffsetMapper} mapper
 * @property {RenderResult|null} render
 * @property {'markdown'|'html'} format
 * @property {LineIndex} li
 * @property {{ minScore: number, minQuoteSim: number, contextChars: number }} cfg
 * @property {Set<string>} linked
 * @property {boolean} anyLink
 * @property {number} version
 * @property {string|undefined} docPath
 * @property {Record<string, string>|null} assets
 */

/** Hunks whose old + new slices exceed this are not word-diffed (treated as changing everything they touch). */
const MAX_WORD_DIFF_CHARS = 200_000;
/** Inside linked hunks a rewritten text is narrowed to only when this similar; else the whole lines are taken. */
const LINKED_QUOTE_SIM = 0.7;
/** Minimum heading-text similarity for a fuzzy section match. */
const HEADING_SIM = 0.6;

/** @type {WeakMap<object, { from: string, to: string, ops: ReturnType<typeof hunkWordOps> | null }>} */
const OPS_CACHE = new WeakMap();

/**
 * @param {{ anchor: Anchor, originalAnchor?: Anchor|null, fromSource: string, toSource: string, hunks?: any[]|null,
 *           mapper?: OffsetMapper|null, toRender?: RenderResult|null, format?: string, link?: Link,
 *           override?: Override, config?: any, version?: number, docPath?: string,
 *           assets?: Record<string, string>|null }} p
 * @returns {Anchor}
 */
export function reanchor(p) {
  const A = p.anchor;
  if (!A || typeof A !== 'object' || !A.src) throw new UsageError('reanchor: anchor is required');
  if (typeof p.fromSource !== 'string' || typeof p.toSource !== 'string') {
    throw new UsageError('reanchor: fromSource and toSource must be strings');
  }
  const ctx = makeReCtx(p);
  if (p.override && (p.override.lines || typeof p.override.quote === 'string')) {
    const o = applyOverride(p.override, ctx, A, p.config);
    if (o) return o;
  }
  if (A.kind === 'doc') return { ...clone(A), v: ctx.version, state: 'exact' };
  const hint = ctx.mapper.mapOffset(A.src.start).off;
  /** @type {Anchor|null} */
  let out = null;
  if (A.state !== 'orphaned') {
    out = relocate(A, ctx, { mapped: true, original: false, hint });
  } else if (A.lastKnown) {
    out = relocate(A.lastKnown, ctx, { mapped: false, original: false, hint });
  }
  const orig = p.originalAnchor;
  if (!out && orig && orig.src && orig.kind === A.kind && orig.src.text !== (A.lastKnown ?? A).src.text) {
    out = relocate(orig, ctx, { mapped: false, original: true, hint });
  }
  return out ?? orphan(A, ctx);
}

// ------------------------------------------------------------------------------------------------------- context

/** @param {Parameters<typeof reanchor>[0]} p @returns {ReCtx} */
function makeReCtx(p) {
  const from = p.fromSource;
  const to = p.toSource;
  const hunks = Array.isArray(p.hunks) && p.hunks.every(isOffsetHunk) ? p.hunks : lineHunks(from, to);
  const mapper = p.mapper && typeof p.mapper.mapOffset === 'function' ? p.mapper : offsetMapper(from, to, hunks);
  const version = Number.isInteger(p.version) ? /** @type {number} */ (p.version) : (Number(p.anchor.v) || 0) + 1;
  const ids = Array.isArray(p.link?.hunkIds) ? p.link.hunkIds.map(String) : [];
  return {
    from,
    to,
    hunks,
    mapper,
    render: p.toRender ?? null,
    format: formatOf(p.format, p.toRender),
    li: lineIndex(to),
    cfg: anchoringConfig(p.config),
    linked: new Set(ids),
    anyLink: Boolean(p.link?.linked) || ids.length > 0,
    version,
    docPath: p.docPath,
    assets: p.assets ?? null,
  };
}

/** @param {any} h */
function isOffsetHunk(h) {
  return h && typeof h.oldStartOff === 'number' && typeof h.oldEndOff === 'number' &&
    typeof h.newStartOff === 'number' && typeof h.newEndOff === 'number';
}

// ------------------------------------------------------------------------------------------------------ dispatch

/**
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Anchor|null}
 */
function relocate(A, ctx, opt) {
  if (!ctx.render) return relocateText(A, ctx, opt);
  switch (A.kind) {
    case 'element': return relocateElement(A, ctx, opt);
    case 'cell': return relocateCell(A, ctx, opt);
    case 'section': return relocateSection(A, ctx, opt);
    default: return relocateText(A, ctx, opt);
  }
}

/**
 * @param {NonNullable<Override>} ov @param {ReCtx} ctx @param {Anchor} A @param {any} config
 * @returns {Anchor|null}
 */
function applyOverride(ov, ctx, A, config) {
  const base = { version: ctx.version, source: ctx.to, render: ctx.render, format: ctx.format, config };
  /** @type {Anchor|null} */
  let anchor = null;
  if (Array.isArray(ov.lines) && ov.lines.length) {
    anchor = anchorFromLines({ ...base, startLine: Number(ov.lines[0]), endLine: Number(ov.lines[1] ?? ov.lines[0]) });
  } else if (typeof ov.quote === 'string') {
    anchor = anchorFromQuote({ ...base, quote: ov.quote, hint: ctx.mapper.mapOffset(A.src.start).off });
  }
  if (!anchor) return null;
  anchor.state = 'exact';
  anchor.mappedBy = 'override';
  return anchor;
}

// -------------------------------------------------------------------------------------------- locating source text

/**
 * Steps 1-4 on the anchor's source text (steps 1-2 only for anchors whose offsets are valid in `from`).
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Loc|null}
 */
function locate(A, ctx, opt) {
  const { start: s, end: e, text } = A.src;
  if (opt.mapped) {
    const ns = preciseMap(ctx, s);
    // A linked hunk whose word diff changes characters of the range wins over a verbatim survival of the text
    // (e.g. "dog" -> "dogs" at the end of the anchor): the thread is reported 'edited', not 'exact'.
    const linked = ctx.linked.size ? changingHunks(ctx, s, e).filter((h) => ctx.linked.has(h.id)) : [];
    if (!linked.length && ns != null && ctx.to.startsWith(text, ns)) return { start: ns, end: ns + text.length, how: 'untouched' };
    if (linked.length) {
      const R0 = Math.min(...linked.map((h) => h.newStartOff));
      const R1 = Math.max(...linked.map((h) => h.newEndOff));
      /** @type {[number, number]} */
      const R = [R0, R1];
      // Both ends of the range survived and only its inside was rewritten (e.g. an applied suggestion that
      // replaced a few words): the anchor spans exactly the edited text between them.
      const ne = e > s ? preciseMap(ctx, e - 1) : null;
      if (ns != null && ne != null && ne + 1 > ns) return { start: ns, end: ne + 1, how: 'linked', R };
      const exclude = text.trim() ? otherCopies(ctx, text, s) : [];
      if (text.trim() && R1 > R0) {
        const m = fuzzyFind(ctx.to, text, {
          prefix: A.src.prefix, suffix: A.src.suffix, hint: R0, range: R, minScore: 0,
          minQuoteSim: Math.max(ctx.cfg.minQuoteSim, LINKED_QUOTE_SIM), contextChars: ctx.cfg.contextChars, exclude,
        });
        if (m) return { start: m.start, end: m.end, how: 'linked', R };
      }
      // The rewritten text may sit in ANOTHER hunk linked to the thread: a line diff can pair the old line with an
      // unrelated inserted line (text added above it) and put the edited line into the next hunk.
      const others = ctx.hunks.filter((h) => ctx.linked.has(h.id) && h.newEndOff > h.newStartOff && !linked.includes(h));
      if (text.trim() && others.length) {
        /** @type {{ start: number, end: number, score: number, R: [number, number] } | null} */
        let best = null;
        for (const h of others) {
          /** @type {[number, number]} */
          const HR = [h.newStartOff, h.newEndOff];
          const m = fuzzyFind(ctx.to, text, {
            prefix: A.src.prefix, suffix: A.src.suffix, hint: R0, range: HR, minScore: 0,
            minQuoteSim: Math.max(ctx.cfg.minQuoteSim, LINKED_QUOTE_SIM), contextChars: ctx.cfg.contextChars, exclude,
          });
          if (m && (!best || m.score > best.score)) best = { start: m.start, end: m.end, score: m.score, R: HR };
        }
        if (best) return { start: best.start, end: best.end, how: 'linked', R: best.R };
      }
      if (R1 <= R0 && text.trim()) {
        // The linked hunk only deleted lines: the text may have moved (steps 3-4) before it falls back to the
        // empty deletion point. A verbatim copy elsewhere is 'moved'; a reworded one is 'edited' (it is linked),
        // but only in text this version added: a similar line it left untouched (the next bullet of a list) was
        // already there, and the thread asked for this one to go.
        const elsewhere = findElsewhere(A, ctx, opt);
        if (elsewhere?.how === 'exact') return elsewhere;
        if (elsewhere && mostlyNew(ctx, elsewhere.start, elsewhere.end)) {
          return { start: elsewhere.start, end: elsewhere.end, how: 'linked', R: [elsewhere.start, elsewhere.end] };
        }
      }
      return { ...wholeLines(ctx, R0, R1), how: 'linked', R };
    }
    if (!text.trim()) {
      const m = ctx.mapper.mapOffset(s).off;
      return { start: m, end: m, how: 'untouched' };
    }
  }
  if (!text.trim()) return null;
  return findElsewhere(A, ctx, opt);
}

/**
 * Steps 3-4: the anchor's text exactly elsewhere (prefix/suffix + proximity), else fuzzily.
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Loc|null}
 */
function findElsewhere(A, ctx, opt) {
  const { text } = A.src;
  const opts = {
    prefix: A.src.prefix, suffix: A.src.suffix, hint: opt.hint, minScore: ctx.cfg.minScore,
    minQuoteSim: ctx.cfg.minQuoteSim, contextChars: ctx.cfg.contextChars,
    // A text that occurred several times in `from` may survive only as another copy: context must decide.
    allowUnique: !opt.mapped || !occursTwice(ctx.from, text),
    // ... and a copy that already existed in `from` and is still there, unchanged, is never this anchor's text:
    // it is the image of ANOTHER old copy (after the anchored copy was deleted, the survivor even inherits the
    // deleted copy's context). Only for mapped anchors is one old occurrence (the anchor's own) not "another".
    exclude: otherCopies(ctx, text, opt.mapped ? A.src.start : -1),
  };
  const ex = exactFind(ctx.to, text, opts);
  if (ex) return { start: ex.start, end: ex.end, how: 'exact' };
  const fz = fuzzyFind(ctx.to, text, opts);
  if (fz) return { start: fz.start, end: fz.end, how: 'fuzzy' };
  return null;
}

/** @param {string} hay @param {string} needle */
function occursTwice(hay, needle) {
  const i = hay.indexOf(needle);
  return i >= 0 && hay.indexOf(needle, i + 1) >= 0;
}

/**
 * Whether at least half of to[start, end) lies in the new ranges of the hunks: text this version wrote, rather than
 * text it kept.
 * @param {ReCtx} ctx @param {number} start @param {number} end
 */
function mostlyNew(ctx, start, end) {
  let fresh = 0;
  for (const h of ctx.hunks) fresh += Math.max(0, Math.min(end, h.newEndOff) - Math.max(start, h.newStartOff));
  return end > start && fresh * 2 >= end - start;
}

/** At most this many old occurrences of an anchored text are followed into the new version. */
const MAX_COPIES = 200;

/**
 * Ranges of `to` that are the verbatim, unchanged images of occurrences of `text` in `from` other than the one at
 * `own` (the anchor's own old copy; -1 when the anchor's offsets are not from `from`). Re-anchoring never lands
 * on them: that text was there before and belongs to something else.
 * @param {ReCtx} ctx @param {string} text @param {number} own
 * @returns {Array<[number, number]>}
 */
function otherCopies(ctx, text, own) {
  /** @type {Array<[number, number]>} */
  const out = [];
  if (!text.trim()) return out;
  let n = 0;
  for (let i = ctx.from.indexOf(text); i >= 0 && n < MAX_COPIES; i = ctx.from.indexOf(text, i + 1), n++) {
    if (i === own) continue;
    const ns = preciseMap(ctx, i);
    const ne = text.length > 1 ? preciseMap(ctx, i + text.length - 1) : ns;
    if (ns == null || ne == null || ne - ns !== text.length - 1 || !ctx.to.startsWith(text, ns)) continue;
    out.push([ns, ns + text.length]);
  }
  return out;
}

/**
 * The whole lines covering to[R0, R1) without the final line terminator.
 * @param {ReCtx} ctx @param {number} R0 @param {number} R1
 */
function wholeLines(ctx, R0, R1) {
  if (R1 <= R0) return { start: R0, end: R0 };
  const a = ctx.li.lineOf(R0);
  const b = ctx.li.lineOf(R1 - 1);
  return { start: ctx.li.startOf(a), end: Math.max(ctx.li.startOf(a), ctx.li.endOf(b)) };
}

/**
 * Map an old offset to the new text at character level, or null when the character was changed.
 * @param {ReCtx} ctx @param {number} off
 * @returns {number|null}
 */
function preciseMap(ctx, off) {
  const m = ctx.mapper.mapOffset(off);
  if (!m.hunk) return m.off;
  const h = m.hunk;
  const ops = hunkOps(ctx, h);
  if (!ops) return null;
  const rel = off - h.oldStartOff;
  for (const op of ops) {
    if (op.op === 'eq' && rel >= op.aStart && rel < op.aEnd) return h.newStartOff + op.bStart + (rel - op.aStart);
  }
  return null;
}

/**
 * Hunks whose word-level changes touch old[s, e): a deletion overlapping it, or an insertion strictly inside it.
 * @param {ReCtx} ctx @param {number} s @param {number} e
 * @returns {Hunk[]}
 */
function changingHunks(ctx, s, e) {
  /** @type {Hunk[]} */
  const out = [];
  for (const h of ctx.hunks) {
    if (!touchesLines(h, s, e)) continue;
    const ops = hunkOps(ctx, h);
    if (!ops) {
      out.push(h);
      continue;
    }
    for (const op of ops) {
      const a0 = h.oldStartOff + op.aStart;
      const a1 = h.oldStartOff + op.aEnd;
      const hit = op.op === 'del'
        ? (e > s ? a0 < e && s < a1 : a0 <= s && s < a1)
        : op.op === 'ins' && s < a0 && a0 < e;
      if (hit) {
        out.push(h);
        break;
      }
    }
  }
  return out;
}

/**
 * Line-level intersection of a hunk's old range with [s, e) (an insertion counts only strictly inside).
 * @param {Hunk} h @param {number} s @param {number} e
 */
function touchesLines(h, s, e) {
  if (h.oldEndOff === h.oldStartOff) return s < h.oldStartOff && h.oldStartOff < e;
  const end = e > s ? e : s + 1;
  return h.oldStartOff < end && s < h.oldEndOff;
}

/** @param {ReCtx} ctx @param {Hunk} h */
function hunkOps(ctx, h) {
  const hit = OPS_CACHE.get(h);
  if (hit && hit.from === ctx.from && hit.to === ctx.to) return hit.ops;
  const a = ctx.from.slice(h.oldStartOff, h.oldEndOff);
  const b = ctx.to.slice(h.newStartOff, h.newEndOff);
  const ops = a.length + b.length > MAX_WORD_DIFF_CHARS ? null : hunkWordOps(a, b);
  OPS_CACHE.set(h, { from: ctx.from, to: ctx.to, ops });
  return ops;
}

/**
 * State of a relocated anchor from how it was found and whether its text is unchanged.
 * @param {Anchor} A @param {Anchor['src']} src @param {Loc['how']|'fingerprint'|'heading'} how @param {Opt} opt
 * @param {boolean} same
 * @returns {AnchorState}
 */
function stateOf(A, src, how, opt, same) {
  if (how === 'linked') return 'edited';
  if (!same) return 'changed';
  if (!opt.mapped) return 'moved';
  return src.startLine === A.src.startLine && src.endLine === A.src.endLine ? 'exact' : 'moved';
}

// ---------------------------------------------------------------------------------------------- text-like kinds

/**
 * text / code / source anchors (and every kind when there is no render).
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Anchor|null}
 */
function relocateText(A, ctx, opt) {
  const loc = locate(A, ctx, opt);
  if (!loc) return null;
  if (/** @type {any} */ (A).snip && ctx.to.slice(loc.start, loc.end) !== A.src.text) Object.assign(loc, snipBlocks(ctx, loc.start, loc.end));
  const src = makeSrc(ctx.to, ctx.li, loc.start, loc.end, ctx.cfg.contextChars);
  const same = src.text === A.src.text;
  const out = carry(A, ctx, src, stateOf(A, src, loc.how, opt, same));
  out.quote = nextQuote(A, ctx, src, same);
  if (A.generated && A.host) {
    const hostSrid = remapHost(A.host, ctx, opt);
    out.host = hostSrid != null ? hostOf(ctx.render, hostSrid) : A.host;
    out.srid = hostSrid;
    out.endSrid = null;
    out.section = hostSrid != null ? sectionOf(ctx.render, /** @type {any} */ (out.host).s) : A.section;
  } else if (ctx.render) {
    const span = sridSpan(ctx.render, ctx.to, src.start, src.end);
    out.srid = span.srid;
    out.endSrid = span.endSrid;
  }
  if (ctx.render && (A.kind === 'text' || A.kind === 'code') && !A.generated) {
    const code = codeTargetOf(ctx.render, ctx.li, src.start, src.end);
    out.kind = code ? 'code' : 'text';
    out.code = code;
  }
  if (/** @type {any} */ (A).snip) {
    const snip = nextSnip(/** @type {any} */ (A).snip, ctx, opt, src);
    /** @type {any} */ (out).snip = snip;
    out.quote = null;
    out.region = snip.container && snip.region ? clone(snip.region) : null;
    if (ctx.render && A.kind === /** @type {any} */ ('snip')) Object.assign(out, snipSpan(ctx.render, ctx.to, src.start, src.end));
  }
  return out;
}

/**
 * A changed snip range grown back to whole blocks and whole lines: a fuzzy match can stop short of the covered
 * blocks' edges (e.g. before a closing `</pre>` after the last line was reworded). Elements that start inside the
 * range extend its end, elements that end inside it extend its start; ancestors around it do not count.
 * @param {ReCtx} ctx @param {number} start @param {number} end
 * @returns {{ start: number, end: number }}
 */
function snipBlocks(ctx, start, end) {
  if (end <= start) return { start, end };
  let s = start;
  let e = end;
  if (ctx.render) {
    for (const srid of ctx.render.srcmap.order) {
      const n = ctx.render.srcmap.nodes[srid];
      if (n.s >= start && n.s < end && n.e > e) e = n.e;
      if (n.e > start && n.e <= end && n.s < s) s = n.s;
    }
  }
  return wholeLines(ctx, s, e);
}

/**
 * A snip's info at the new version: its container element re-resolved (null once lost).
 * @param {import('./snip.js').SnipInfo} snip @param {ReCtx} ctx @param {Opt} opt @param {Anchor['src']} src new range
 * @returns {import('./snip.js').SnipInfo}
 */
function nextSnip(snip, ctx, opt, src) {
  const out = clone(snip);
  const c = snip.container;
  if (!c) return out;
  if (!ctx.render) {
    // relocated in the source only: carry the container's offsets, so a later step with a render can find it
    out.container = { ...c, srid: null, s: ctx.mapper.mapOffset(c.s).off, e: ctx.mapper.mapOffset(c.e).off };
    return out;
  }
  const srid = remapHost(c, ctx, opt);
  const n = nodeOf(ctx.render, srid);
  // the box was drawn over the covered blocks: a container that no longer overlaps them is another element
  const overlaps = n != null && (src.end > src.start ? n.s < src.end && src.start < n.e : n.s <= src.start && src.start <= n.e);
  out.container = overlaps ? snipContainerOf(ctx.render, srid) : null;
  return out;
}

/**
 * The quote after re-anchoring (amendments 3.4): unchanged text keeps the previous quote (context refreshed);
 * changed text gets the rendered-text approximation of the new slice.
 * @param {Anchor} A @param {ReCtx} ctx @param {Anchor['src']} src @param {boolean} same
 * @returns {Anchor['quote']}
 */
function nextQuote(A, ctx, src, same) {
  const pq = plainQuote(ctx.format, ctx.to, src.start, src.end, ctx.cfg.contextChars);
  if (A.generated) {
    // The source is script / container markup: its context is not rendered text, so keep the captured context.
    if (same || !pq || !A.quote) return clone(A.quote ?? pq);
    return { exact: pq.exact, prefix: A.quote.prefix, suffix: A.quote.suffix };
  }
  if (same && A.quote) {
    if (!pq || (src.prefix === A.src.prefix && src.suffix === A.src.suffix)) return clone(A.quote);
    return { exact: A.quote.exact, prefix: pq.prefix, suffix: pq.suffix };
  }
  return pq;
}

/**
 * Element a generated anchor is painted in, followed to the new render.
 * @param {{ tag: string, s: number, e: number, label: string }} host @param {ReCtx} ctx @param {Opt} opt
 * @returns {number|null}
 */
function remapHost(host, ctx, opt) {
  const render = ctx.render;
  if (!render) return null;
  const cands = elementsByTag(render, host.tag);
  if (opt.mapped) {
    const ms = preciseMap(ctx, host.s) ?? ctx.mapper.mapOffset(host.s).off;
    const at = cands.find((srid) => render.srcmap.nodes[srid].s === ms);
    if (at != null) return at;
  }
  const byLabel = cands.filter((srid) => elementLabelOf(render, srid) === host.label);
  if (byLabel.length === 1) return byLabel[0];
  return null;
}

/**
 * A new anchor carrying A's identity and kind data with a new src/state (derived fields filled by callers).
 * @param {Anchor} A @param {ReCtx} ctx @param {Anchor['src']} src @param {AnchorState} state
 * @returns {Anchor}
 */
function carry(A, ctx, src, state) {
  /** @type {Anchor} */
  const out = {
    v: ctx.version,
    kind: A.kind,
    state,
    mappedBy: A.mappedBy,
    src,
    quote: clone(A.quote ?? null),
    srid: null,
    endSrid: null,
    section: ctx.render ? sectionOf(ctx.render, src.start) : [...(A.section ?? [])],
    generated: Boolean(A.generated),
    element: clone(A.element ?? null),
    region: clone(A.region ?? null),
    svg: clone(A.svg ?? null),
    cell: clone(A.cell ?? null),
    code: clone(A.code ?? null),
    media: clone(A.media ?? null),
  };
  if (A.scope) out.scope = A.scope;
  if (A.host) out.host = clone(A.host);
  if (/** @type {any} */ (A).snip) /** @type {any} */ (out).snip = clone(/** @type {any} */ (A).snip);
  if (out.element) out.element.srid = /** @type {any} */ (null);
  return out;
}

// ------------------------------------------------------------------------------------------------------ elements

/**
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Anchor|null}
 */
function relocateElement(A, ctx, opt) {
  const render = /** @type {RenderResult} */ (ctx.render);
  const tag = String(A.element?.tag ?? '').toLowerCase();
  if (!tag) return relocateText(A, ctx, opt);
  const fp = fingerprintOfElement(A.element, A.section);
  const loc = locate(A, ctx, opt);
  /** @type {number|null} */
  let srid = null;
  /** @type {Loc['how']|'fingerprint'} */
  let how = loc?.how ?? 'fingerprint';
  if (loc?.how === 'linked') {
    srid = linkedElement(render, /** @type {[number, number]} */ (loc.R), tag, A, fp, ctx);
    if (srid == null) {
      // No same-tag element in the linked range: keep the old element position mapped through the mapper.
      const ms = ctx.mapper.mapOffset(A.src.start).off;
      const me = Math.max(ms, ctx.mapper.mapOffset(A.src.end).off);
      const src = makeSrc(ctx.to, ctx.li, ms, me, ctx.cfg.contextChars);
      const out = carry(A, ctx, src, 'edited');
      const span = sridSpan(render, ctx.to, src.start, src.end);
      out.srid = span.srid;
      out.endSrid = span.endSrid;
      return out;
    }
  } else if (loc) {
    srid = sameTagAt(render, loc.start, loc.end, tag, fp, ctx);
    // Text found elsewhere must still be the same element (similar source text can belong to a sibling,
    // e.g. ![d6](d6.png) vs ![d61](d61.png)).
    if (srid != null && loc.how !== 'untouched' && fingerprintAt(render, srid, ctx, fp) < FINGERPRINT_ACCEPT) srid = null;
  }
  if (srid == null) {
    const best = bestFingerprintMatch(render, fp, { docPath: ctx.docPath, assets: ctx.assets, hint: opt.hint });
    if (!best) return null;
    srid = best.srid;
    how = 'fingerprint';
  }
  const n = /** @type {import('../render/srcmap.js').SrcNode} */ (nodeOf(render, srid));
  let start = n.s;
  let end = n.e;
  let svg = clone(A.svg ?? null);
  if (svg && A.generated) {
    const host = contentHostOf(render, srid);
    const c = nodeOf(render, host)?.c;
    if (c) {
      const narrowed = narrowMermaid(ctx.to, ctx.li, c, svg);
      if (narrowed) {
        ({ start, end } = narrowed);
        const label = mermaidLabelIn(ctx.to.slice(start, end), svg.nodeId);
        if (label) svg = { ...svg, label };
      } else if (loc && loc.start >= c.contentStart && loc.end <= c.contentEnd) {
        ({ start, end } = loc);
      }
    }
  }
  const src = makeSrc(ctx.to, ctx.li, start, end, ctx.cfg.contextChars);
  let state = stateOf(A, src, how, opt, src.text === A.src.text);
  const out = carry(A, ctx, src, state);
  out.srid = srid;
  out.svg = svg;
  out.quote = null;
  out.element = nextElement(A, ctx, srid);
  const oldSha = A.element?.assetSha256 ?? null;
  const newSha = out.element?.assetSha256 ?? null;
  if (oldSha && newSha && oldSha !== newSha) {
    out.assetChanged = true;
    if (state === 'exact' || state === 'moved') state = ctx.anyLink ? 'edited' : 'changed';
    out.state = state;
  }
  return out;
}

/**
 * The element data at b; without a manifest `assets` map the previous asset hash is kept.
 * @param {Anchor} A @param {ReCtx} ctx @param {number} srid
 */
function nextElement(A, ctx, srid) {
  const render = /** @type {RenderResult} */ (ctx.render);
  const el = anchorElement(render, srid, { docPath: ctx.docPath, assets: ctx.assets });
  if (!ctx.assets) el.assetSha256 = A.element?.assetSha256 ?? null;
  return el;
}

/**
 * Same-tag element overlapping [start, end): an exact range match first, then the best fingerprint / overlap.
 * @param {RenderResult} render @param {number} start @param {number} end @param {string} tag
 * @param {import('./fingerprint.js').Fingerprint} fp @param {ReCtx} ctx
 * @returns {number|null}
 */
function sameTagAt(render, start, end, tag, fp, ctx) {
  const cands = elementsByTag(render, tag).filter((srid) => {
    const n = render.srcmap.nodes[srid];
    return end > start ? n.s < end && start < n.e : n.s <= start && start < n.e;
  });
  if (!cands.length) return null;
  const exact = cands.find((srid) => render.srcmap.nodes[srid].s === start && render.srcmap.nodes[srid].e === end);
  if (exact != null) return exact;
  return rankByFingerprint(render, cands, fp, ctx, start)[0];
}

/**
 * Linked step for elements: a same-tag element intersecting the linked range, preferring the same src/alt.
 * @param {RenderResult} render @param {[number, number]} R @param {string} tag @param {Anchor} A
 * @param {import('./fingerprint.js').Fingerprint} fp @param {ReCtx} ctx
 * @returns {number|null}
 */
function linkedElement(render, R, tag, A, fp, ctx) {
  const cands = elementsByTag(render, tag).filter((srid) => {
    const n = render.srcmap.nodes[srid];
    return R[1] > R[0] ? n.s < R[1] && R[0] < n.e : n.s <= R[0] && R[0] < n.e;
  });
  if (!cands.length) return null;
  const attrs = A.element?.attrs ?? {};
  const same = cands.filter((srid) => {
    const a = render.srcmap.nodes[srid].a ?? {};
    return (attrs.src && a.src === attrs.src) || (attrs.alt && a.alt === attrs.alt) || (attrs.id && a.id === attrs.id);
  });
  return rankByFingerprint(render, same.length ? same : cands, fp, ctx, R[0])[0];
}

/**
 * Fingerprint score of an element of b against the anchor's fingerprint.
 * @param {RenderResult} render @param {number} srid @param {ReCtx} ctx @param {import('./fingerprint.js').Fingerprint} fp
 */
function fingerprintAt(render, srid, ctx, fp) {
  const other = elementFingerprint(render, srid, { docPath: ctx.docPath, assets: ctx.assets });
  return other ? fingerprintScore(fp, other) : 0;
}

/**
 * @param {RenderResult} render @param {number[]} cands @param {import('./fingerprint.js').Fingerprint} fp
 * @param {ReCtx} ctx @param {number} near
 * @returns {number[]}
 */
function rankByFingerprint(render, cands, fp, ctx, near) {
  const scored = cands.map((srid) => {
    const other = elementFingerprint(render, srid, { docPath: ctx.docPath, assets: ctx.assets });
    return { srid, score: other ? fingerprintScore(fp, other) : 0, dist: Math.abs(render.srcmap.nodes[srid].s - near) };
  });
  scored.sort((a, b) => b.score - a.score || a.dist - b.dist || a.srid - b.srid);
  return scored.map((x) => x.srid);
}

// --------------------------------------------------------------------------------------------------------- cells

/**
 * Table cells / rows / columns. Order: (1) the anchored element's text intact at its mapped position -> that
 * element; (2) a table holding the exact rowKey and colHeader (nearest the old position); (3) the table at the
 * mapped position, matching keys fuzzily (index only for an empty key). Keys are refreshed from b.
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Anchor|null}
 */
function relocateCell(A, ctx, opt) {
  const render = /** @type {RenderResult} */ (ctx.render);
  if (!A.cell) return relocateElement(A, ctx, opt);
  const scope = A.scope ?? 'cell';
  const targetTag = String(A.element?.tag ?? (scope === 'row' ? 'tr' : scope === 'cell' ? 'td' : 'table')).toLowerCase();
  const optional = { rowOptional: scope === 'column' || scope === 'table', colOptional: scope === 'row' || scope === 'table' };
  /** @type {number|null} */
  let srid = null;
  /** @type {number|null} */
  let tableSrid = null;
  /** @type {ReturnType<typeof findCell>} */
  let found = null;
  if (opt.mapped) {
    const ns = preciseMap(ctx, A.src.start);
    if (ns != null && ctx.to.startsWith(A.src.text, ns)) {
      const ne = ns + A.src.text.length;
      srid = elementsByTag(render, targetTag).find((x) => render.srcmap.nodes[x].s === ns && render.srcmap.nodes[x].e === ne) ?? null;
      tableSrid = tableOf(render, srid);
      if (srid != null && tableSrid != null) found = findCell(render, tableSrid, A.cell, { ...optional, allowIndex: true });
    }
  }
  if (srid == null) {
    tableSrid = tableByKeys(render, A, opt.hint);
    if (tableSrid != null) found = findCell(render, tableSrid, A.cell, { ...optional, allowIndex: false });
    if (!found && opt.mapped) {
      const p = ctx.mapper.mapOffset(A.src.start).off;
      tableSrid = tableOf(render, deepestContaining(render, p, p));
      found = tableSrid != null ? findCell(render, tableSrid, A.cell, { ...optional, allowIndex: 'empty' }) : null;
    }
    if (!found || tableSrid == null) return null;
    srid = scope === 'row' ? found.rowSrid : scope === 'column' || scope === 'table' ? tableSrid : found.cellSrid;
    if (srid == null) return null;
  }
  const n = /** @type {import('../render/srcmap.js').SrcNode} */ (nodeOf(render, srid));
  const src = makeSrc(ctx.to, ctx.li, n.s, n.e, ctx.cfg.contextChars);
  const same = src.text === A.src.text;
  const linkedTouch = opt.mapped && changingHunks(ctx, A.src.start, A.src.end).some((h) => ctx.linked.has(h.id));
  const out = carry(A, ctx, src, stateOf(A, src, !same && linkedTouch ? 'linked' : 'exact', opt, same));
  out.srid = srid;
  out.quote = null;
  out.element = nextElement(A, ctx, srid);
  out.cell = found
    ? { tableSrid: /** @type {number} */ (tableSrid), row: found.row, col: found.col, rowKey: found.rowKey, colHeader: found.colHeader, text: found.text }
    : { ...A.cell, ...(tableSrid != null ? { tableSrid } : {}) };
  return out;
}

/**
 * A table containing the anchor's rowKey and colHeader exactly (the keys its scope needs), nearest the hint.
 * @param {RenderResult} render @param {Anchor} A @param {number} hint
 * @returns {number|null}
 */
function tableByKeys(render, A, hint) {
  const cell = /** @type {NonNullable<Anchor['cell']>} */ (A.cell);
  const scope = A.scope ?? 'cell';
  const needRow = scope !== 'column' && scope !== 'table';
  const needCol = scope !== 'row' && scope !== 'table';
  if ((needRow && !cell.rowKey) || (needCol && !cell.colHeader)) return null;
  /** @type {{ srid: number, dist: number }[]} */
  const hits = [];
  for (const srid of elementsByTag(render, 'table')) {
    const f = findCell(render, srid, cell, { allowIndex: false, fuzzy: false, rowOptional: !needRow, colOptional: !needCol });
    if (!f) continue;
    if ((needRow && f.rowBy !== 'key') || (needCol && f.colBy !== 'key')) continue;
    hits.push({ srid, dist: Math.abs(render.srcmap.nodes[srid].s - hint) });
  }
  hits.sort((a, b) => a.dist - b.dist || a.srid - b.srid);
  return hits[0]?.srid ?? null;
}

// ------------------------------------------------------------------------------------------------------ sections

/**
 * @param {Anchor} A @param {ReCtx} ctx @param {Opt} opt
 * @returns {Anchor|null}
 */
function relocateSection(A, ctx, opt) {
  const render = /** @type {RenderResult} */ (ctx.render);
  const norm = (/** @type {string} */ t) => collapseWs(String(t ?? '')).trim();
  // The heading text: the section chain's tail is the full outline text (element.text is cut at 80 chars).
  const names = [norm(A.section?.[A.section.length - 1] ?? ''), norm(A.element?.text ?? '')].filter(Boolean);
  const headingText = names[0] ?? '';
  const level = Number(/^h([1-6])$/i.exec(String(A.element?.tag ?? ''))?.[1]) || 0;
  const outline = render.outline ?? [];
  const dist = (/** @type {{ srid: number }} */ o) => Math.abs((nodeOf(render, o.srid)?.s ?? 0) - opt.hint);
  const cands = outline.filter((o) => !level || o.level === level);
  let pick = cands.filter((o) => names.includes(norm(o.text))).sort((a, b) => dist(a) - dist(b))[0];
  if (!pick && headingText) {
    const scored = cands
      .map((o) => ({ o, sim: similarity(norm(o.text), headingText) }))
      .filter((x) => x.sim >= HEADING_SIM)
      .sort((a, b) => b.sim - a.sim || dist(a.o) - dist(b.o));
    pick = scored[0]?.o;
  }
  if (!pick && names.length && level) {
    // The heading was promoted / demoted: the same text at another level (never 'exact': the markup changed).
    pick = outline.filter((o) => o.level !== level && names.includes(norm(o.text))).sort((a, b) => dist(a) - dist(b))[0];
  }
  if (!pick) return null;
  const range = sectionRange(render, ctx.to, pick.srid);
  const src = makeSrc(ctx.to, ctx.li, range.start, range.end, ctx.cfg.contextChars);
  const same = src.text === A.src.text;
  const how = !same && sectionLinked(A, ctx, src, opt) ? 'linked' : 'exact';
  return finishSection(A, ctx, pick.srid, src, stateOf(A, src, how, opt, same));
}

/**
 * A section whose content changed counts as edited by a linked hunk when that hunk changed characters of the
 * old extent or lies inside the new one (e.g. a row appended at the end of the section).
 * @param {Anchor} A @param {ReCtx} ctx @param {Anchor['src']} src @param {Opt} opt
 */
function sectionLinked(A, ctx, src, opt) {
  if (!ctx.linked.size) return false;
  if (opt.mapped && changingHunks(ctx, A.src.start, A.src.end).some((h) => ctx.linked.has(h.id))) return true;
  return ctx.hunks.some((h) => ctx.linked.has(h.id) && h.newStartOff < src.end && src.start < Math.max(h.newEndOff, h.newStartOff + 1));
}

/**
 * @param {Anchor} A @param {ReCtx} ctx @param {number} headingSrid @param {Anchor['src']} src @param {AnchorState} state
 * @returns {Anchor}
 */
function finishSection(A, ctx, headingSrid, src, state) {
  const render = /** @type {RenderResult} */ (ctx.render);
  const out = carry(A, ctx, src, state);
  const span = sridSpan(render, ctx.to, src.start, src.end);
  out.srid = headingSrid;
  out.endSrid = span.endSrid ?? (span.srid !== headingSrid ? span.srid : null);
  if (out.endSrid === headingSrid) out.endSrid = null;
  out.quote = null;
  out.element = nextElement(A, ctx, headingSrid);
  return out;
}

// ------------------------------------------------------------------------------------------------------- orphans

/**
 * @param {Anchor} A @param {ReCtx} ctx
 * @returns {Anchor}
 */
function orphan(A, ctx) {
  const p = ctx.mapper.mapOffset(A.src.start).off;
  const src = makeSrc(ctx.to, ctx.li, p, p, ctx.cfg.contextChars);
  const last = A.state === 'orphaned' ? (A.lastKnown ?? null) : stripLastKnown(A);
  /** @type {Anchor} */
  const out = {
    v: ctx.version,
    kind: A.kind,
    state: 'orphaned',
    mappedBy: A.mappedBy,
    src,
    quote: clone(A.quote ?? null),
    srid: null,
    endSrid: null,
    section: [...(A.section ?? [])],
    generated: Boolean(A.generated),
    element: clone(A.element ?? null),
    region: clone(A.region ?? null),
    svg: clone(A.svg ?? null),
    cell: clone(A.cell ?? null),
    code: clone(A.code ?? null),
    media: clone(A.media ?? null),
  };
  if (A.scope) out.scope = A.scope;
  if (A.host) out.host = clone(A.host);
  if (/** @type {any} */ (A).snip) /** @type {any} */ (out).snip = clone(/** @type {any} */ (A).snip);
  out.lastKnown = clone(last);
  return out;
}

/** @param {Anchor} A @returns {Anchor} */
function stripLastKnown(A) {
  const { lastKnown: _drop, ...rest } = A;
  return /** @type {Anchor} */ (rest);
}
