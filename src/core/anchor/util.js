// @ts-check
// Shared helpers for the anchoring engine (design 7, BUILD_AMENDMENTS 3.3/3.4/4.2): source ranges and their
// context, render (srcmap) queries that the render module does not provide, rendered-quote approximations and
// element labels. Everything here is pure and deterministic.
//
// Conventions (same as the rest of the core): offsets are UTF-16 code units into the decoded source string,
// ranges are half-open [start, end), lines are 1-based and inclusive in AnchorSrc.

import { CONTEXT_CHARS } from '../../shared/protocol.js';
import { classifyRef, sectionAt } from '../render/index.js';
import { collapseWs, isWsCode, lineIndex, sourceToPlainText } from '../text/index.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').AnchorSrc} AnchorSrc
 * @typedef {import('../../shared/types.js').AnchorQuote} AnchorQuote
 * @typedef {import('../render/srcmap.js').SrcNode} SrcNode
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {import('../text/lines.js').LineIndex} LineIndex
 */

/** Kinds whose element content is verbatim (code-like) and mapped by SrcNode.c. */
export const CONTENT_KINDS = Object.freeze(['code', 'mermaid', 'math', 'frontmatter']);

/** Anchor kinds painted as whole elements (outline / region / mermaid box) rather than text ranges. */
export const ELEMENT_ANCHOR_KINDS = Object.freeze(['element', 'cell']);

/** Default anchoring thresholds (design 5.3 config.anchoring). */
export const DEFAULT_ANCHORING = Object.freeze({ minScore: 0.65, minQuoteSim: 0.6, contextChars: CONTEXT_CHARS });

/**
 * Anchoring settings from a full Config, its `anchoring` section, or nothing.
 * @param {any} config
 * @returns {{ minScore: number, minQuoteSim: number, contextChars: number }}
 */
export function anchoringConfig(config) {
  const a = config && typeof config === 'object' ? (config.anchoring ?? config) : {};
  const num = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    minScore: num(a.minScore, DEFAULT_ANCHORING.minScore),
    minQuoteSim: num(a.minQuoteSim, DEFAULT_ANCHORING.minQuoteSim),
    contextChars: Math.max(0, Math.floor(num(a.contextChars, DEFAULT_ANCHORING.contextChars))),
  };
}

/**
 * 'markdown' | 'html' | 'text' from an explicit format or the render. 'text' (code docs) is identity: its quotes are
 * never stripped of markup.
 * @param {string|undefined|null} format
 * @param {{ format?: string }|null|undefined} [render]
 * @returns {'markdown'|'html'|'text'}
 */
export function formatOf(format, render) {
  const f = String(format ?? render?.format ?? '').toLowerCase();
  if (f === 'text') return 'text';
  return f === 'html' || f === 'htm' ? 'html' : 'markdown';
}

/**
 * Build an AnchorSrc for source[start, end).
 * @param {string} source
 * @param {LineIndex} li
 * @param {number} start
 * @param {number} end
 * @param {number} [n] context chars on each side
 * @returns {AnchorSrc}
 */
export function makeSrc(source, li, start, end, n = CONTEXT_CHARS) {
  const s = clamp(start, 0, source.length);
  const e = clamp(end, s, source.length);
  return {
    start: s,
    end: e,
    startLine: li.lineOf(s),
    endLine: e > s ? li.lineOf(e - 1) : li.lineOf(s),
    text: source.slice(s, e),
    prefix: source.slice(Math.max(0, s - n), s),
    suffix: source.slice(e, Math.min(source.length, e + n)),
  };
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  const x = Number.isFinite(v) ? v : lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Shrink a range so it neither starts nor ends with whitespace (an all-whitespace range collapses to its start).
 * @param {string} source @param {number} start @param {number} end
 * @returns {[number, number]}
 */
export function trimRange(source, start, end) {
  let s = start;
  let e = end;
  while (s < e && isWsCode(source.charCodeAt(s))) s++;
  while (e > s && isWsCode(source.charCodeAt(e - 1))) e--;
  return s < e ? [s, e] : [start, start];
}

/**
 * Rendered-text approximation of source[start, end) plus rendered context on both sides (amendments 3.4: the
 * quote after re-anchoring to different text is sourceToPlainText(format, newSlice)). Context strings follow the
 * guest's convention: whitespace collapsed, at most `n` chars, the side touching the quote keeps its space.
 * Returns null when the slice renders no text (e.g. head markup, an image).
 * @param {'markdown'|'html'} format
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @param {number} [n]
 * @returns {AnchorQuote|null}
 */
export function plainQuote(format, source, start, end, n = CONTEXT_CHARS) {
  const atLineStart = (/** @type {number} */ off) => off === 0 || source[off - 1] === '\n';
  const exact = collapseWs(sourceToPlainText(format, source.slice(start, end), { lineStart: atLineStart(start) })).trim();
  if (!exact) return null;
  // Start the "before" slice at a line start so block markup ("- ", "# ", tags) is recognised.
  const li = lineIndex(source);
  const beforeFrom = li.startOf(li.lineOf(Math.max(0, start - 4 * n)));
  const before = collapseWs(sourceToPlainText(format, source.slice(beforeFrom, start), { lineStart: true }));
  const after = collapseWs(sourceToPlainText(format, source.slice(end, Math.min(source.length, end + 4 * n)), {
    lineStart: atLineStart(end),
  }));
  return {
    exact,
    prefix: before.slice(-n).replace(/^\s+/, ''),
    suffix: after.slice(0, n).replace(/\s+$/, ''),
  };
}

/**
 * Normalised single-line text: whitespace collapsed and trimmed, at most `max` chars (ellipsis when cut).
 * @param {string|null|undefined} s @param {number} [max]
 */
export function oneLine(s, max = Infinity) {
  const t = collapseWs(String(s ?? '')).trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

// ------------------------------------------------------------------------------------------------ render queries

/**
 * @param {RenderResult|null|undefined} render
 * @param {number|null|undefined} srid
 * @returns {SrcNode|null}
 */
export function nodeOf(render, srid) {
  if (srid == null || !render?.srcmap?.nodes) return null;
  return render.srcmap.nodes[srid] ?? null;
}

/**
 * Srids from `srid` up to the root (inclusive of srid).
 * @param {RenderResult} render @param {number} srid
 * @returns {number[]}
 */
export function ancestorsOf(render, srid) {
  /** @type {number[]} */
  const out = [];
  const seen = new Set();
  for (let cur = srid; cur && !seen.has(cur); cur = render.srcmap.nodes[cur]?.p ?? 0) {
    if (!render.srcmap.nodes[cur]) break;
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

/**
 * Deepest common ancestor-or-self of two srids (null when they share none).
 * @param {RenderResult} render @param {number|null} a @param {number|null} b
 * @returns {number|null}
 */
export function commonAncestor(render, a, b) {
  if (a == null && b == null) return null;
  if (a == null || !nodeOf(render, a)) return nodeOf(render, b) ? b : null;
  if (b == null || !nodeOf(render, b)) return a;
  const set = new Set(ancestorsOf(render, b));
  for (const x of ancestorsOf(render, a)) if (set.has(x)) return x;
  return null;
}

/**
 * Deepest element (any kind, inline included) whose range contains [start, end). For an empty range, the element
 * must contain the point (s <= p < e).
 * @param {RenderResult|null|undefined} render @param {number} start @param {number} end
 * @param {(srid: number, n: SrcNode) => boolean} [filter]
 * @returns {number|null}
 */
export function deepestContaining(render, start, end, filter) {
  if (!render?.srcmap) return null;
  let best = null;
  let bestDepth = -1;
  // Containing ranges nest, so the deepest container is the one with the most containing ancestors. (Tree order
  // is not always source order in Markdown: footnote definitions move to the end of the tree.)
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (n.s > start) continue;
    const ok = end > start ? n.e >= end : start < n.e;
    if (!ok || (filter && !filter(srid, n))) continue;
    const depth = ancestorsOf(render, srid).length;
    if (depth >= bestDepth) {
      best = srid;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The stamped elements a source range should be painted against (amendments 3.4 DomTarget.srid/endSrid):
 * the deepest element containing the whole (whitespace-trimmed) range; otherwise the deepest element containing
 * its first character and the deepest containing its last one (falling back to the first / last element that
 * starts / ends inside the range). endSrid is null when it equals srid.
 * @param {RenderResult|null|undefined} render @param {string} source @param {number} start @param {number} end
 * @returns {{ srid: number|null, endSrid: number|null }}
 */
export function sridSpan(render, source, start, end) {
  if (!render?.srcmap) return { srid: null, endSrid: null };
  const [s, e] = trimRange(source, start, end);
  if (e <= s) return { srid: deepestContaining(render, s, s), endSrid: null };
  const container = deepestContaining(render, s, e);
  if (container != null) return { srid: container, endSrid: null };
  let first = deepestContaining(render, s, s);
  let last = deepestContaining(render, e - 1, e - 1);
  if (first == null || last == null) {
    // Range edges in inter-element whitespace / markup: use the outermost elements starting inside the range
    // (the first one, and the one reaching furthest).
    const needFirst = first == null;
    const needLast = last == null;
    let maxEnd = -1;
    for (const srid of render.srcmap.order) {
      const n = render.srcmap.nodes[srid];
      if (n.s < s || n.s >= e) continue;
      if (needFirst && first == null) first = srid;
      if (needLast && n.e > maxEnd) {
        maxEnd = n.e;
        last = srid;
      }
    }
  }
  if (first == null) first = last;
  return { srid: first, endSrid: last != null && last !== first ? last : null };
}

/**
 * The self-or-ancestor element whose content is verbatim (code / mermaid / math / front matter with a `c`
 * content mapping), or null.
 * @param {RenderResult|null|undefined} render @param {number|null|undefined} srid
 * @returns {number|null}
 */
export function contentHostOf(render, srid) {
  if (srid == null || !render?.srcmap) return null;
  for (const x of ancestorsOf(render, srid)) {
    const n = render.srcmap.nodes[x];
    if (n.c && n.k && CONTENT_KINDS.includes(n.k)) return x;
  }
  return null;
}

/**
 * Code language of a code element (its own or a child's `language-xxx` class; front matter is yaml).
 * @param {RenderResult} render @param {number} srid
 * @returns {string|undefined}
 */
export function codeLangOf(render, srid) {
  const n = nodeOf(render, srid);
  if (!n) return undefined;
  if (n.k === 'frontmatter') return 'yaml';
  const fromClass = (/** @type {string|undefined} */ cls) => /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls ?? '')?.[1];
  const own = fromClass(n.a?.class);
  if (own) return own;
  for (const child of render.srcmap.order) {
    const c = render.srcmap.nodes[child];
    if (c.p !== srid) continue;
    const l = fromClass(c.a?.class);
    if (l) return l;
  }
  return undefined;
}

/**
 * @typedef {Object} RenderIndex
 * @property {Map<string, number[]>} byTag   lower-case tag -> srids in document order
 * @property {Map<number, string[]>} section srid -> heading chain at the element's start
 * @property {Map<number, number>} ordinal   srid -> index among same-tag elements with the same heading chain
 */

/** @type {WeakMap<object, RenderIndex>} */
const RENDER_INDEX = new WeakMap();

/**
 * Per-render lookup tables (computed once per render object and cached weakly), so fingerprinting every
 * same-tag element of a large document stays linear.
 * @param {RenderResult} render
 * @returns {RenderIndex}
 */
export function renderIndex(render) {
  const hit = RENDER_INDEX.get(render);
  if (hit) return hit;
  /** @type {RenderIndex} */
  const idx = { byTag: new Map(), section: new Map(), ordinal: new Map() };
  /** @type {Map<string, number>} */
  const counters = new Map();
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    const tag = n.t.toLowerCase();
    const chain = sectionAt(render, n.s);
    idx.section.set(srid, chain);
    const key = `${tag}\u0000${chain.join('\u0000')}`;
    const i = counters.get(key) ?? 0;
    counters.set(key, i + 1);
    idx.ordinal.set(srid, i);
    const list = idx.byTag.get(tag);
    if (list) list.push(srid);
    else idx.byTag.set(tag, [srid]);
  }
  RENDER_INDEX.set(render, idx);
  return idx;
}

/**
 * Same-tag elements in document order.
 * @param {RenderResult} render @param {string} tag
 * @returns {number[]}
 */
export function elementsByTag(render, tag) {
  return renderIndex(render).byTag.get(String(tag).toLowerCase()) ?? [];
}

/**
 * Heading chain at a source offset ([] without a render).
 * @param {RenderResult|null|undefined} render @param {number} off
 * @returns {string[]}
 */
export function sectionOf(render, off) {
  return render?.srcmap ? sectionAt(render, off) : [];
}

/**
 * Normalised rendered text of an element (whitespace collapsed), at most `max` chars.
 * @param {RenderResult} render @param {number} srid @param {number} [max]
 */
export function elementTextOf(render, srid, max = 80) {
  const span = render?.text?.spans?.[srid];
  if (!span) return '';
  return oneLine(render.text.text.slice(span[0], span[1]), max);
}

/**
 * Workspace-relative path of the local asset an element references (src / poster / data), or null.
 * @param {SrcNode|null|undefined} node @param {string|undefined} docPath
 * @returns {string|null}
 */
export function assetPathOf(node, docPath) {
  const a = node?.a;
  if (!a) return null;
  for (const key of /** @type {const} */ (['src', 'poster', 'data'])) {
    const v = a[key];
    if (!v || v.includes('…[')) continue; // compacted data: URI
    const r = classifyRef(v, { docPath });
    if (r?.kind === 'asset') return r.path;
  }
  return null;
}

/**
 * Hex sha256 of an element's local asset from a version manifest's `assets` map ({path: 'sha256:<hex>'|'live'}),
 * or null when unknown.
 * @param {SrcNode|null|undefined} node @param {{ docPath?: string, assets?: Record<string, string>|null }} opts
 * @returns {string|null}
 */
export function assetShaOf(node, { docPath, assets } = {}) {
  if (!assets) return null;
  const p = assetPathOf(node, docPath);
  if (!p) return null;
  const ref = assets[p];
  if (typeof ref !== 'string' || !ref.startsWith('sha256:')) return null;
  return ref.slice('sha256:'.length);
}

/**
 * A short, source-flavoured label for an element, e.g. `<img alt="System overview">`, `<g id="node-gateway">`,
 * `<td>`. Math and mermaid elements are named by kind.
 * @param {RenderResult} render @param {number} srid
 */
export function elementLabelOf(render, srid) {
  const n = nodeOf(render, srid);
  if (!n) return 'element';
  if (n.k === 'math') return 'math';
  if (n.k === 'mermaid') return 'mermaid diagram';
  if (n.k === 'code' && n.t.toLowerCase() === 'pre') return 'code block';
  const tag = n.t.toLowerCase();
  const a = n.a ?? {};
  for (const key of /** @type {const} */ (['id', 'alt', 'src', 'href', 'class'])) {
    const v = a[key];
    if (!v) continue;
    const shown = v.startsWith('data:') ? `${v.slice(0, v.indexOf(',') > 0 ? Math.min(v.indexOf(','), 40) : 20)},…` : oneLine(v, 60);
    return `<${tag} ${key}="${shown}">`;
  }
  return `<${tag}>`;
}

/**
 * Offsets of whole lines [startLine, endLine] (end excludes the last line's terminator), clamped.
 * @param {LineIndex} li @param {number} startLine @param {number} endLine
 * @returns {{ start: number, end: number, startLine: number, endLine: number }}
 */
export function lineRange(li, startLine, endLine) {
  let a = Math.floor(Number(startLine));
  let b = Math.floor(Number(endLine ?? startLine));
  if (!Number.isFinite(a)) a = 1;
  if (!Number.isFinite(b)) b = a;
  if (b < a) [a, b] = [b, a];
  a = clamp(a, 1, li.count);
  b = clamp(b, a, li.count);
  return { start: li.startOf(a), end: li.endOf(b), startLine: a, endLine: b };
}

/**
 * Clone a plain JSON-ish value (anchors are plain data).
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function clone(v) {
  return v == null ? v : structuredClone(v);
}
