// @ts-check
// Rendered change set between two versions (design 8.5, BUILD_AMENDMENTS 4.1 FROZEN), without thread links
// (WP3 adds threadLinks / attribution / assets):
//   changeSet({ fromSource, toSource, toRender, format, hunks, fromRender }) -> Changes
// Changes = { stats: { added, removed, hunks, blocksChanged },
//   hunks: [{ id, op: 'add'|'del'|'mod', old: {start, lines}, new: {start, lines},
//             srids,          deepest block elements of `toRender` intersecting the CHANGED new char ranges
//                             (word-level inserted text; for words deleted inside a line, the block holding the
//                             deletion point), document order;
//             words,          [{ srid, quote, prefix, suffix }]: inserted/replaced text as rendered text (for
//                             'sr-ins' highlights), one entry per (segment, leaf block); markup-only and
//                             whitespace-only segments are dropped; prefix/suffix are CONTEXT_CHARS of
//                             whitespace-collapsed rendered text around the quote;
//             deleted,        'del': { text: removed source lines, html: rendered fragment (markdown only), lines }
//                             'mod': { text: removed words joined by ' … ', html: null, lines } or null; 'add': null
//             insertBefore,   'del': { srid } of the first block starting at/after the deletion point, else null
//             insertAfter,    'del' with no following block: { srid } of the last block before it (addition)
//             section }] }    heading chain at the hunk's new start (pure deletions: just before the deletion point)
// It is synchronous (the Markdown fragment renderer is synchronous); awaiting it is harmless. `fromRender` is
// accepted for interface compatibility and currently unused.

import { CONTEXT_CHARS } from '../../shared/protocol.js';
import { renderFragmentSync } from '../render/fragment.js';
import { deepestBlockAt, elementsIntersecting, elementText, sectionAt } from '../render/query.js';
import { collapseWs, normalizeWs } from '../text/normalize.js';
import { toPlain } from '../text/plain.js';
import { findQuote } from '../text/quote.js';
import { lineHunks } from './hunks.js';
import { hunkWordOps } from './words.js';

/**
 * @typedef {import('./hunks.js').Hunk} Hunk
 * @typedef {import('../render/srcmap.js').SrcNode} SrcNode
 * @typedef {{ srid: number, quote: string, prefix: string, suffix: string }} WordTarget
 * @typedef {{ id: string, op: 'add'|'del'|'mod', old: { start: number, lines: number }, new: { start: number, lines: number },
 *             srids: number[], words: WordTarget[], deleted: { text: string, html: string|null, lines: number } | null,
 *             insertBefore: { srid: number } | null, insertAfter: { srid: number } | null, section: string[] }} ChangeHunk
 * @typedef {{ stats: { added: number, removed: number, hunks: number, blocksChanged: number }, hunks: ChangeHunk[] }} Changes
 */

/**
 * @param {{ fromSource: string, toSource: string, toRender: any, format?: string, hunks?: Hunk[], fromRender?: any }} p
 * @returns {Changes}
 */
export function changeSet({ fromSource, toSource, toRender, format, hunks }) {
  const a = fromSource ?? '';
  const b = toSource ?? '';
  const fmt = format === 'html' || (!format && toRender?.format === 'html') ? 'html' : 'markdown';
  const hs = hunks ?? lineHunks(a, b);
  const order = new Map((toRender?.srcmap?.order ?? []).map((srid, i) => [srid, i]));
  /** @type {ChangeHunk[]} */
  const out = [];
  /** @type {Set<number>} */
  const allBlocks = new Set();
  /** @type {Map<number, import('../text/plain.js').PlainText>} plain projection of each block's source, by srid */
  const plainCache = new Map();
  let added = 0;
  let removed = 0;

  for (const h of hs) {
    added += h.newLines;
    removed += h.oldLines;
    const op = h.oldLines === 0 ? 'add' : h.newLines === 0 ? 'del' : 'mod';
    const oldSlice = a.slice(h.oldStartOff, h.oldEndOff);
    const newSlice = b.slice(h.newStartOff, h.newEndOff);
    const ops = hunkWordOps(oldSlice, newSlice);

    /** @type {Set<number>} */
    const srids = new Set();
    /** @type {WordTarget[]} */
    const words = [];
    if (toRender?.srcmap) {
      for (const o of ops) {
        if (o.op === 'ins') {
          const [s, e] = trimRange(b, h.newStartOff + o.bStart, h.newStartOff + o.bEnd);
          if (e <= s) continue;
          const blocks = elementsIntersecting(toRender, s, e, { leafBlocks: true });
          for (const srid of blocks) {
            srids.add(srid);
            const w = wordTarget(toRender, b, fmt, srid, s, e, plainCache);
            if (w) words.push(w);
          }
        } else if (o.op === 'del' && op === 'mod' && o.text.trim()) {
          const p = h.newStartOff + o.bStart;
          const srid = deepestBlockAt(toRender, p > h.newStartOff ? p - 1 : p, p);
          if (srid != null) srids.add(srid);
        }
      }
    }
    const sridList = [...srids].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
    for (const s of sridList) allBlocks.add(s);

    /** @type {ChangeHunk['deleted']} */
    let deleted = null;
    if (op === 'del') {
      deleted = { text: oldSlice, html: fmt === 'markdown' ? safeFragment(oldSlice) : null, lines: h.oldLines };
    } else if (op === 'mod') {
      const texts = ops.filter((o) => o.op === 'del').map((o) => o.text.trim()).filter(Boolean);
      if (texts.length) deleted = { text: texts.join(' … '), html: null, lines: h.oldLines };
    }

    let insertBefore = null;
    let insertAfter = null;
    if (op === 'del' && toRender?.srcmap) {
      insertBefore = firstBlockFrom(toRender, h.newStartOff);
      if (!insertBefore) insertAfter = lastBlockBefore(toRender, h.newStartOff);
    }

    out.push({
      id: h.id,
      op,
      old: { start: h.oldStart, lines: h.oldLines },
      new: { start: h.newStart, lines: h.newLines },
      srids: sridList,
      words,
      deleted,
      insertBefore,
      insertAfter,
      // a pure deletion belongs to the section that held the removed lines: the one ending at the deletion point
      section: toRender?.outline ? sectionAt(toRender, op === 'del' ? Math.max(0, h.newStartOff - 1) : h.newStartOff) : [],
    });
  }

  return { stats: { added, removed, hunks: hs.length, blocksChanged: allBlocks.size }, hunks: out };
}

/**
 * Shrink [s, e) to exclude leading/trailing whitespace.
 * @param {string} text @param {number} s @param {number} e
 * @returns {[number, number]}
 */
function trimRange(text, s, e) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

/**
 * Rendered-text target for the part of source segment [s, e) inside block `srid`. The segment is projected to
 * plain text *in the context of its whole block* (so emphasis delimiters pair correctly and markup-only
 * segments project to nothing), then located in the block's rendered text to take the surrounding context.
 * @param {any} render @param {string} b @param {'markdown'|'html'} fmt @param {number} srid
 * @param {number} s @param {number} e @param {Map<number, import('../text/plain.js').PlainText>} cache
 * @returns {WordTarget|null}
 */
function wordTarget(render, b, fmt, srid, s, e, cache) {
  /** @type {SrcNode} */
  const n = render.srcmap.nodes[srid];
  if (!n || n.k === 'mermaid') return null;
  const ps = Math.max(s, n.s);
  const pe = Math.min(e, n.e);
  if (pe <= ps) return null;
  const verbatim = n.k === 'code' || n.k === 'math' || n.k === 'frontmatter';
  let plain = cache.get(srid);
  if (!plain) {
    const blockSrc = b.slice(n.s, n.e);
    plain = verbatim ? toPlain('text', blockSrc) : toPlain(fmt, blockSrc, { lineStart: n.s === 0 || b[n.s - 1] === '\n' });
    cache.set(srid, plain);
  }
  // plain chars produced by source chars inside [ps, pe)
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < plain.text.length; i++) {
    const src = n.s + plain.map[i];
    if (src >= ps && src < pe) {
      if (i0 < 0) i0 = i;
      i1 = i;
    } else if (i0 >= 0 && src >= pe) break;
  }
  if (i0 < 0) return null; // markup only
  const quote = normalizeWs(plain.text.slice(i0, i1 + 1)).text;
  if (!quote) return null;

  const span = render.text.spans[srid] ?? [0, 0];
  const elText = elementText(render, srid);
  const hint = Math.round((i0 / Math.max(1, plain.text.length)) * elText.length);
  const hits = findQuote(elText, quote, { format: 'text', hint });
  const k = CONTEXT_CHARS;
  if (hits.length) {
    const g0 = span[0] + hits[0].start;
    const g1 = span[0] + hits[0].end;
    const full = render.text.text;
    return {
      srid,
      quote,
      prefix: collapseWs(full.slice(Math.max(0, g0 - 4 * k), g0)).slice(-k),
      suffix: collapseWs(full.slice(g1, g1 + 4 * k)).slice(0, k),
    };
  }
  // Not found in the rendered element text (text that renders differently, e.g. math): context from the block's
  // own plain projection.
  return {
    srid,
    quote,
    prefix: collapseWs(plain.text.slice(Math.max(0, i0 - 4 * k), i0)).slice(-k),
    suffix: collapseWs(plain.text.slice(i1 + 1, i1 + 1 + 4 * k)).slice(0, k),
  };
}

/**
 * The first block element (outermost at that point) starting at or after `off`.
 * @param {any} render @param {number} off
 * @returns {{ srid: number } | null}
 */
function firstBlockFrom(render, off) {
  /** @type {number|null} */
  let best = null;
  let bestS = Infinity;
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (!n.b || n.s < off) continue;
    if (n.s < bestS) {
      best = srid;
      bestS = n.s;
    }
  }
  return best == null ? null : { srid: best };
}

/**
 * The outermost block that ends last at or before `off` (used when a deletion is at the end of the document).
 * @param {any} render @param {number} off
 * @returns {{ srid: number } | null}
 */
function lastBlockBefore(render, off) {
  /** @type {number|null} */
  let best = null;
  let bestE = -1;
  let bestS = Infinity;
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (!n.b || n.e > off) continue;
    if (n.e > bestE || (n.e === bestE && n.s < bestS)) {
      best = srid;
      bestE = n.e;
      bestS = n.s;
    }
  }
  return best == null ? null : { srid: best };
}

/** @param {string} source */
function safeFragment(source) {
  try {
    return renderFragmentSync({ format: 'markdown', source });
  } catch {
    return null;
  }
}
