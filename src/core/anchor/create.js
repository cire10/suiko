// @ts-check
// Capture -> Anchor resolution (design 7.2, BUILD_AMENDMENTS 3.3). Pure: works on one version's source + render.
//
//   createAnchor({ version, capture, source, render, format, docPath?, assets?, config? }) -> Anchor
//   anchorFromLines({ version, startLine, endLine, source, render, format, config? })        -> Anchor ('source')
//   anchorFromQuote({ version, quote, source, render, format, hint?, requireUnique?, config? }) -> Anchor | null
//   sectionRange(render, source, headingSrid) -> { start, end }
//
// Text captures: window = source range nodes[startSrid].s .. nodes[endSrid].e (the whole source when either srid
// is missing; the verbatim content range c when both ends are in the same code / math / front-matter element).
// findQuote cascades exact -> whitespace-normalised -> markup-tolerant inside the window (mappedBy 'textmap',
// markup-tolerant = 'narrowed'); else a unique occurrence anywhere in the source ('raw-source', generated: true,
// e.g. text a script builds from a string literal); else the deepest common element of the two srids ('block',
// generated: true); with no element at all (generated text outside every positioned element, e.g. a Markdown
// doc's "Footnotes" heading) a GENERAL 'doc' anchor that keeps the quote - never a range covering the whole file.
// Markdown fence content is literal, so markup tolerance is off inside it, but a fence nested in a blockquote is
// also searched with its '>' line prefixes removed. Trailing footnote back-reference arrows ('↩') of a selection
// are ignored. A text capture fully inside a code block yields kind 'code' with code: { fromLine, toLine, lang }
// (1-based within the block).
// Generated anchors keep `host` = { tag, s, e, label } of the element the reviewer selected in, so the DOM target
// stays on the rendered text (the source range is in the script) and can follow the element across versions.
//
// Element captures: src = the element's [s, e); element = fingerprint (tag, attrs, asset hash, text sample,
// ordinal, label); region/svg/cell/scope copied (validated). A mermaid node (svg on a mermaid element) narrows
// src to the fence line(s) defining the node (generated: true). Cells: kind 'cell', cell.tableSrid filled in.
// A pick of an element a script generated inside the stamped one (the guest's label names another tag, or text
// the stamped element's source does not have) becomes a generated text anchor: quote = the picked element's text
// sample, src = the unique string literal generating it (else the container), host = the container; a textless
// generated pick keeps the element anchor with the picked label appended ('<div id="cards"> > img "chart.png"').
// Section captures: heading.s .. next heading of the same or higher level (or, for a heading inside a container
// element such as <section> or a card <div> holding the section body, the container's end - not a wrapper that
// only holds the heading row; else EOF), trailing whitespace and (Markdown) trailing link / footnote definitions
// trimmed: those serve the whole document.
// Source captures: whole lines (mappedBy 'lines'); doc captures: an empty range at 0.
//
// Every anchor has the same key set: { v, kind, state, mappedBy, src, quote, srid, endSrid, section, generated,
// element, region, svg, cell, code, media } plus `scope` (cell/table element anchors) and `host` (generated
// text). Invalid captures throw UsageError (exit 1).

import { UsageError } from '../store/errors.js';
import { collapseWs, findQuote, lineIndex } from '../text/index.js';
import { anchorElement } from './fingerprint.js';
import { narrowMermaid } from './mermaid.js';
import { tableOf } from './table.js';
import {
  anchoringConfig, codeLangOf, commonAncestor, contentHostOf, deepestContaining, elementLabelOf, formatOf, lineRange,
  elementTextOf, makeSrc, nodeOf, plainQuote, sectionOf, sridSpan, trimRange,
} from './util.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Capture} Capture
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {import('../text/lines.js').LineIndex} LineIndex
 * @typedef {{ version: number, source: string, render: RenderResult|null, format: 'markdown'|'html', li: LineIndex,
 *             n: number, docPath?: string, assets?: Record<string, string>|null }} Ctx
 */

/**
 * Resolve a guest capture into an anchor on `version`.
 * @param {{ version: number, capture: Capture|any, source: string, render: RenderResult, format?: string,
 *           docPath?: string, assets?: Record<string, string>|null, config?: any }} p
 * @returns {Anchor}
 */
export function createAnchor({ version, capture, source, render, format, docPath, assets, config }) {
  if (!capture || typeof capture !== 'object') throw new UsageError('createAnchor: capture is required');
  if (typeof source !== 'string') throw new UsageError('createAnchor: source must be a string');
  const ctx = makeCtx({ version, source, render, format, docPath, assets, config });
  switch (capture.kind) {
    case 'text': return fromText(capture, ctx);
    case 'element': return fromElement(capture, ctx);
    case 'section': return fromSection(capture, ctx);
    case 'source': return anchorFromLines({ version, startLine: capture.startLine, endLine: capture.endLine, source, render, format: ctx.format, config });
    case 'doc': return docAnchor(ctx);
    default: throw new UsageError(`createAnchor: unknown capture kind ${JSON.stringify(capture.kind)}`);
  }
}

/**
 * Anchor on whole source lines (agent `--lines`, overrides, Source-view captures).
 * @param {{ version: number, startLine: number, endLine?: number, source: string, render?: RenderResult|null,
 *           format?: string, config?: any }} p
 * @returns {Anchor}
 */
export function anchorFromLines({ version, startLine, endLine, source, render = null, format, config }) {
  if (!Number.isFinite(Number(startLine))) throw new UsageError('anchorFromLines: startLine must be a number');
  const ctx = makeCtx({ version, source, render, format, config });
  const r = lineRange(ctx.li, Number(startLine), Number(endLine ?? startLine));
  const { srid, endSrid } = sridSpan(render, source, r.start, r.end);
  return baseAnchor(ctx, {
    kind: 'source',
    mappedBy: 'lines',
    start: r.start,
    end: r.end,
    quote: plainQuote(ctx.format, source, r.start, r.end, ctx.n),
    srid,
    endSrid,
  });
}

/**
 * Anchor on a quote (rendered text or source text) found in the source (agent `--quote`, overrides).
 * Returns null when the quote is not found, or when `requireUnique` and it occurs more than once.
 * @param {{ version: number, quote: string, source: string, render?: RenderResult|null, format?: string,
 *           hint?: number|null, requireUnique?: boolean, config?: any }} p
 * @returns {Anchor|null}
 */
export function anchorFromQuote({ version, quote, source, render = null, format, hint = null, requireUnique = false, config }) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  const ctx = makeCtx({ version, source, render, format, config });
  const matches = findQuote(source, quote, { markupTolerant: true, format: ctx.format, hint });
  if (!matches.length || (requireUnique && matches.length > 1)) return null;
  const m = matches[0];
  return textLikeAnchor(ctx, {
    start: m.start,
    end: m.end,
    mappedBy: m.mode === 'markup' ? 'narrowed' : 'textmap',
    quote: plainQuote(ctx.format, source, m.start, m.end, ctx.n) ?? { exact: collapseWs(quote).trim(), prefix: '', suffix: '' },
  });
}

/**
 * Extent of the section a heading opens.
 * @param {RenderResult} render @param {string} source @param {number} headingSrid
 * @returns {{ start: number, end: number }}
 */
export function sectionRange(render, source, headingSrid) {
  const h = nodeOf(render, headingSrid);
  if (!h) throw new UsageError(`sectionRange: no element ${headingSrid}`);
  const level = h.h?.level ?? (Number(/^h([1-6])$/i.exec(h.t)?.[1]) || 6);
  let end = source.length;
  for (const o of render.outline ?? []) {
    const n = nodeOf(render, o.srid);
    if (!n || o.srid === headingSrid || n.s <= h.s || o.level > level) continue;
    if (n.s < end) end = n.s;
  }
  // A heading inside a container element (<section>, <details>, a card <div> holding the section body...) ends with
  // its container; a wrapper that only holds the heading row (<div class="flex"><h2/><span class="badge"/></div>,
  // <header><h1/></header>, a README's <div align="center">) is not the section's container.
  const container = sectionContainer(render, h);
  if (container && container.e > h.e && container.e < end) end = container.e;
  // Markdown link reference / footnote definitions trailing the section serve the whole document (they render
  // nothing here, or into the generated footnotes list): the section ends before them.
  if (formatOf(null, render) === 'markdown') end = Math.max(h.e, beforeTrailingDefinitions(source, h.s, end));
  const [, e] = trimRange(source, h.s, end);
  return { start: h.s, end: Math.max(e, h.e) };
}

/** A Markdown link reference definition ('[id]: url') or footnote definition ('[^id]: text') line. */
const DEFINITION_RE = /^ {0,3}\[(?:\^[^\]\s]+|[^\]\n]+)\]:(?:\s|$)/;

/**
 * The offset where the trailing run of definition lines of source[start, end) begins (`end` when there is none).
 * Blank lines and indented lines (footnote continuations) inside the run are part of it; the first line (the
 * heading) never is.
 * @param {string} source @param {number} start @param {number} end
 * @returns {number}
 */
export function beforeTrailingDefinitions(source, start, end) {
  const lines = source.slice(start, end).split('\n');
  let cut = lines.length;
  for (let i = lines.length - 1; i > 0; i--) {
    const l = lines[i].replace(/\r$/, '');
    if (!l.trim()) continue;
    if (DEFINITION_RE.test(l)) {
      cut = i;
      continue;
    }
    if (/^(?: {4}|\t)/.test(l)) continue;
    break;
  }
  if (cut === lines.length) return end;
  let off = start;
  for (let i = 0; i < cut; i++) off += lines[i].length + 1;
  return Math.min(end, off);
}

/** Elements that bound the section of a heading inside them (sectioning content and its kin). */
const SECTIONING = new Set(['section', 'article', 'aside', 'main', 'nav', 'details', 'blockquote', 'li', 'td', 'th', 'dd', 'dialog', 'fieldset', 'figure', 'form', 'body']);

/**
 * The element whose end bounds a heading's section: the nearest sectioning ancestor; in HTML also the nearest
 * other ancestor that holds block content after the heading's row (a card), except introductory wrappers
 * (<header>, <hgroup>, <summary>). Wrappers that hold only the heading row are skipped; in Markdown, raw-HTML
 * wrappers (<div align="center">) never bound a section.
 * @param {RenderResult} render
 * @param {import('../render/srcmap.js').SrcNode} h
 * @returns {import('../render/srcmap.js').SrcNode | null}
 */
function sectionContainer(render, h) {
  const html = formatOf(null, render) === 'html';
  let row = h;
  for (let c = nodeOf(render, h.p); c; row = c, c = nodeOf(render, c.p)) {
    const tag = String(c.t).toLowerCase();
    if (SECTIONING.has(tag)) return c;
    if (html && !INTRO.has(tag) && blockAfter(render, c, row)) return c;
  }
  return null;
}

/** Introductory wrappers: a heading in one (with a subtitle, badges...) heads the content AFTER the wrapper. */
const INTRO = new Set(['header', 'hgroup', 'summary']);

/**
 * Whether `container` holds a block element after `row` (one of its descendants).
 * @param {RenderResult} render
 * @param {import('../render/srcmap.js').SrcNode} container
 * @param {import('../render/srcmap.js').SrcNode} row
 */
function blockAfter(render, container, row) {
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (n.s >= container.e) break;
    if (n.b && n !== container && n.s >= row.e && n.e <= container.e) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------- capture kinds

/**
 * @param {any} cap @param {Ctx} ctx
 * @returns {Anchor}
 */
function fromText(cap, ctx) {
  const captured = typeof cap.exact === 'string' ? cap.exact : '';
  if (!captured.trim()) throw new UsageError('text capture: empty selection');
  // A footnote's generated back-reference arrow(s) ('↩', '↩2') selected with its text are not in the source.
  const exact = captured.replace(BACKREF_TAIL, '').trim() ? captured.replace(BACKREF_TAIL, '') : captured;
  const { source, render, format } = ctx;
  const startSrid = validSrid(render, cap.startSrid);
  const endSrid = validSrid(render, cap.endSrid);
  /** @type {[number, number]} */
  let window = [0, source.length];
  const a = nodeOf(render, startSrid);
  const b = nodeOf(render, endSrid);
  if (a && b) window = [Math.min(a.s, b.s), Math.max(a.e, b.e)];
  const host = contentHostOf(render, startSrid);
  const inContent = host != null && host === (endSrid == null ? host : contentHostOf(render, endSrid));
  if (inContent) {
    const c = /** @type {NonNullable<import('../render/srcmap.js').SrcNode['c']>} */ (nodeOf(render, host)?.c);
    window = [c.contentStart, c.contentEnd];
  }
  const quote = { exact, prefix: String(cap.prefix ?? ''), suffix: String(cap.suffix ?? '') };
  const search = { prefix: quote.prefix, suffix: quote.suffix, format, markupTolerant: !(inContent && format === 'markdown') };
  const local = findQuote(source, exact, { ...search, hint: window[0], range: window });
  if (local.length) {
    const m = local[0];
    return textLikeAnchor(ctx, { start: m.start, end: m.end, mappedBy: m.mode === 'markup' ? 'narrowed' : 'textmap', quote });
  }
  if (inContent && format === 'markdown') {
    // Fence content inside a blockquote: every source line carries the container's '> ' prefix.
    const m = findInStrippedFence(source, window[0], window[1], exact, quote);
    if (m) return textLikeAnchor(ctx, { start: m.start, end: m.end, mappedBy: 'textmap', quote });
  }
  const hostSrid = commonAncestor(render, startSrid, endSrid);
  const global = findQuote(source, exact, { ...search, markupTolerant: true });
  if (global.length === 1) {
    const m = global[0];
    return generatedAnchor(ctx, { start: m.start, end: m.end, mappedBy: 'raw-source', quote, hostSrid });
  }
  const hostNode = nodeOf(render, hostSrid);
  if (!hostNode) {
    // Two top-level elements without a common ancestor: the range they span.
    if (a && b) return generatedAnchor(ctx, { start: window[0], end: window[1], mappedBy: 'block', quote, hostSrid: startSrid });
    // Generated text outside every positioned element (e.g. a Markdown doc's "Footnotes" heading, text a script
    // appends to <body>): a GENERAL anchor that keeps the quote, never a range covering the whole file.
    return { ...docAnchor(ctx), quote, generated: true };
  }
  return generatedAnchor(ctx, { start: hostNode.s, end: hostNode.e, mappedBy: 'block', quote, hostSrid });
}

/** Trailing footnote back-reference arrows of a selection ('… notebook. ↩', '↩ ↩2'). */
const BACKREF_TAIL = /(?:\s*\u21a9\ufe0e?\d*)+\s*$/u;

/**
 * Find `needle` in the verbatim content source[from, to) of a fence nested in blockquotes, ignoring the
 * container's '>' markers at the start of each line (as many as the first content line has).
 * @param {string} source @param {number} from @param {number} to @param {string} needle
 * @param {{ prefix: string, suffix: string }} context rendered context of the selection
 * @returns {{ start: number, end: number } | null}
 */
function findInStrippedFence(source, from, to, needle, context) {
  const depth = (/^(?:[ \t]{0,3}>[ \t]?)*/.exec(source.slice(from, to))?.[0].match(/>/g) ?? []).length;
  if (!depth) return null;
  /** @type {string[]} */
  const chars = [];
  /** @type {number[]} */
  const map = [];
  for (let ls = from; ls < to;) {
    const nl = source.indexOf('\n', ls);
    const le = nl < 0 || nl >= to ? to : nl;
    let p = ls;
    for (let d = 0; d < depth; d++) {
      const m = /^[ \t]{0,3}>[ \t]?/.exec(source.slice(p, le));
      if (!m) break;
      p += m[0].length;
    }
    for (let k = p; k < le; k++) {
      chars.push(source[k]);
      map.push(k);
    }
    if (le < to) {
      chars.push('\n');
      map.push(le);
    }
    ls = le + 1;
  }
  const proj = chars.join('');
  const hit = findQuote(proj, needle, { format: 'text', prefix: context.prefix, suffix: context.suffix });
  if (!hit.length) return null;
  const m = hit[0];
  return { start: map[m.start], end: map[m.end - 1] + 1 };
}

/**
 * @param {any} cap @param {Ctx} ctx
 * @returns {Anchor}
 */
function fromElement(cap, ctx) {
  const { render, source } = ctx;
  const srid = validSrid(render, cap.srid);
  const n = nodeOf(render, srid);
  if (srid == null || !n) throw new UsageError(`element capture: unknown srid ${JSON.stringify(cap.srid)}`);
  let start = n.s;
  let end = n.e;
  let generated = false;
  const svg = cleanSvg(cap.svg);
  const host = contentHostOf(render, srid);
  const hostNode = nodeOf(render, host);
  if (svg && hostNode?.k === 'mermaid' && hostNode.c) {
    generated = true;
    const narrowed = narrowMermaid(source, ctx.li, hostNode.c, svg);
    if (narrowed) ({ start, end } = narrowed);
  }
  const rawCell = cap.cell && typeof cap.cell === 'object' ? cap.cell : null;
  const cell = rawCell ? cleanCell(rawCell, tableOf(render, srid)) : null;
  const scope = ['cell', 'row', 'column', 'table'].includes(cap.scope) ? cap.scope : (cell ? 'cell' : undefined);
  // The reviewer picked an element a script generated inside the stamped one (the guest sends the nearest stamped
  // ancestor's srid with the PICKED element's label): anchor what was picked, not the bare container.
  const picked = !svg && !cell && !cap.region && !scope ? pickedInside(cap, render, srid) : null;
  if (picked?.text) return pickedTextAnchor(ctx, picked, srid);
  const anchor = baseAnchor(ctx, {
    kind: cell ? 'cell' : 'element',
    mappedBy: 'element',
    start,
    end,
    quote: null,
    srid,
    endSrid: null,
    generated,
  });
  anchor.element = anchorElement(render, srid, ctx);
  if (picked) anchor.element.label = `${anchor.element.label} > ${picked.label}`;
  anchor.region = cleanRegion(cap.region);
  anchor.svg = svg;
  anchor.cell = cell;
  if (scope) anchor.scope = scope;
  return anchor;
}

/** Guest label kinds that are not `tag "text"` (images, cells, diagrams, media, code...). */
const SPECIAL_PICKS = new Set(['img', 'td', 'th', 'mermaid', 'math', 'svg', 'canvas', 'video', 'audio', 'iframe', 'pre', 'code', 'table']);

/**
 * The element picked inside a stamped one, from the guest's label (`h3 "Option C: CDN edge cache"`, its text
 * clipped to 48 chars with '…'): when its tag differs from the stamped element's, or its text is not the stamped
 * element's own (source-rendered) text. Null when the stamped element itself was picked.
 * @param {any} cap @param {RenderResult} render @param {number} srid
 * @returns {{ tag: string, text: string, label: string } | null}
 */
function pickedInside(cap, render, srid) {
  const label = collapseWs(String(cap.label ?? '')).trim();
  const m = /^([a-z][a-z0-9-]*)(?: "(.*)")?$/i.exec(label);
  const n = nodeOf(render, srid);
  if (!m || !n) return null;
  const tag = m[1].toLowerCase();
  const own = String(n.t).toLowerCase();
  if (SPECIAL_PICKS.has(tag)) return tag !== own ? { tag, text: '', label } : null;
  const text = (m[2] ?? '').replace(/…$/, '').trim();
  if (tag === own) {
    // Same tag: a script-filled container picked whole, or a same-tag child (a card <div> in a grid <div>). Only
    // a container whose source has no text of its own is taken as "generated"; otherwise keep the element.
    const squeeze = (/** @type {string} */ t) => t.replace(/\s+/g, '');
    const mine = squeeze(elementTextOf(render, srid, Infinity));
    if (!text || mine.startsWith(squeeze(text).slice(0, 24))) return null;
    if (mine) return { tag, text: '', label };
  }
  return { tag, text, label };
}

/**
 * A generated-text anchor for a picked script-built element: its text sample is the quote (so two picks in one
 * container stay distinct), the source range is the string literal that generates it when that is unique (else
 * the container), and the container is the host.
 * @param {Ctx} ctx @param {{ tag: string, text: string, label: string }} picked @param {number} srid
 * @returns {Anchor}
 */
function pickedTextAnchor(ctx, picked, srid) {
  const n = /** @type {import('../render/srcmap.js').SrcNode} */ (nodeOf(ctx.render, srid));
  const quote = { exact: picked.text, prefix: '', suffix: '' };
  const lit = uniqueLiteral(ctx.source, picked.text, ctx.format);
  if (lit) return generatedAnchor(ctx, { start: lit.start, end: lit.end, mappedBy: 'raw-source', quote, hostSrid: srid });
  return generatedAnchor(ctx, { start: n.s, end: n.e, mappedBy: 'block', quote, hostSrid: srid });
}

/**
 * The unique source occurrence of a text, else of its longest leading run of words (at least 3 words / 12 chars)
 * that is unique: a generated card's text is usually assembled from several literals, the first being its title.
 * @param {string} source @param {string} text @param {'markdown'|'html'} format
 * @returns {{ start: number, end: number } | null}
 */
function uniqueLiteral(source, text, format) {
  const words = collapseWs(text).trim().split(' ');
  for (let k = words.length; k >= 3; k--) {
    const t = words.slice(0, k).join(' ');
    if (t.length < 12) break;
    const hits = findQuote(source, t, { markupTolerant: true, format });
    if (hits.length === 1) return { start: hits[0].start, end: hits[0].end };
    if (hits.length > 1) return null;
  }
  return null;
}

/**
 * @param {any} cap @param {Ctx} ctx
 * @returns {Anchor}
 */
function fromSection(cap, ctx) {
  const { render, source } = ctx;
  const srid = validSrid(render, cap.headingSrid);
  const n = nodeOf(render, srid);
  if (srid == null || !n || !n.h) throw new UsageError(`section capture: ${JSON.stringify(cap.headingSrid)} is not a heading`);
  const { start, end } = sectionRange(render, source, srid);
  const span = sridSpan(render, source, start, end);
  const anchor = baseAnchor(ctx, {
    kind: 'section',
    mappedBy: 'element',
    start,
    end,
    quote: null,
    srid,
    endSrid: span.endSrid ?? (span.srid !== srid ? span.srid : null),
  });
  anchor.element = anchorElement(render, srid, ctx);
  return anchor;
}

/**
 * @param {Ctx} ctx
 * @returns {Anchor}
 */
function docAnchor(ctx) {
  return baseAnchor(ctx, { kind: 'doc', mappedBy: 'block', start: 0, end: 0, quote: null, srid: null, endSrid: null, section: [] });
}

// ------------------------------------------------------------------------------------------------------ builders

/**
 * @param {{ version: number, source: string, render?: RenderResult|null, format?: string, docPath?: string,
 *           assets?: Record<string, string>|null, config?: any }} p
 * @returns {Ctx}
 */
export function makeCtx({ version, source, render, format, docPath, assets, config }) {
  const v = Number(version);
  if (!Number.isInteger(v) || v < 0) throw new UsageError(`anchor: bad version ${JSON.stringify(version)}`);
  return {
    version: v,
    source,
    render: render ?? null,
    format: formatOf(format, render),
    li: lineIndex(source),
    n: anchoringConfig(config).contextChars,
    docPath,
    assets: assets ?? null,
  };
}

/**
 * A complete anchor with every key present (deterministic key order).
 * @param {Ctx} ctx
 * @param {{ kind: Anchor['kind'], mappedBy: Anchor['mappedBy'], start: number, end: number,
 *           quote: Anchor['quote'], srid: number|null, endSrid: number|null, generated?: boolean, section?: string[] }} f
 * @returns {Anchor}
 */
export function baseAnchor(ctx, f) {
  const src = makeSrc(ctx.source, ctx.li, f.start, f.end, ctx.n);
  return {
    v: ctx.version,
    kind: f.kind,
    state: 'exact',
    mappedBy: f.mappedBy,
    src,
    quote: f.quote,
    srid: f.srid,
    endSrid: f.endSrid != null && f.endSrid !== f.srid ? f.endSrid : null,
    section: f.section ?? sectionOf(ctx.render, src.start),
    generated: f.generated ?? false,
    element: null,
    region: null,
    svg: null,
    cell: null,
    code: null,
    media: null,
  };
}

/**
 * A text anchor on a verified source range; a range inside a code block becomes kind 'code'.
 * @param {Ctx} ctx
 * @param {{ start: number, end: number, mappedBy: Anchor['mappedBy'], quote: Anchor['quote'] }} f
 * @returns {Anchor}
 */
export function textLikeAnchor(ctx, f) {
  const { srid, endSrid } = sridSpan(ctx.render, ctx.source, f.start, f.end);
  const anchor = baseAnchor(ctx, { kind: 'text', mappedBy: f.mappedBy, start: f.start, end: f.end, quote: f.quote, srid, endSrid });
  const code = codeTargetOf(ctx.render, ctx.li, f.start, f.end);
  if (code) {
    anchor.kind = 'code';
    anchor.code = code;
  }
  return anchor;
}

/**
 * Code-block line target of a range fully inside one code element's verbatim content, else null.
 * @param {RenderResult|null} render @param {LineIndex} li @param {number} start @param {number} end
 * @returns {import('../../shared/types.js').CodeTarget|null}
 */
export function codeTargetOf(render, li, start, end) {
  if (!render) return null;
  const inner = deepestContaining(render, start, Math.max(start, end));
  const host = contentHostOf(render, inner);
  const n = nodeOf(render, host);
  if (host == null || !n?.c || n.k !== 'code') return null;
  if (start < n.c.contentStart || end > n.c.contentEnd) return null;
  const first = n.c.firstLine;
  /** @type {import('../../shared/types.js').CodeTarget} */
  const code = {
    fromLine: li.lineOf(start) - first + 1,
    toLine: li.lineOf(end > start ? end - 1 : start) - first + 1,
  };
  const lang = codeLangOf(render, host);
  if (lang) code.lang = lang;
  return code;
}

/**
 * A text anchor whose quote is not verbatim in its rendered location (script-built text or a block fallback).
 * @param {Ctx} ctx
 * @param {{ start: number, end: number, mappedBy: Anchor['mappedBy'], quote: Anchor['quote'], hostSrid: number|null }} f
 * @returns {Anchor}
 */
function generatedAnchor(ctx, f) {
  const host = hostOf(ctx.render, f.hostSrid);
  const anchor = baseAnchor(ctx, {
    kind: 'text', mappedBy: f.mappedBy, start: f.start, end: f.end, quote: f.quote, srid: f.hostSrid, endSrid: null,
    generated: true, section: host ? sectionOf(ctx.render, host.s) : undefined,
  });
  anchor.host = host;
  return anchor;
}

/**
 * The element a generated text anchor is painted in: { tag, s, e, label } (source range at the anchor's version).
 * @param {RenderResult|null} render @param {number|null} srid
 * @returns {{ tag: string, s: number, e: number, label: string } | null}
 */
export function hostOf(render, srid) {
  const n = nodeOf(render, srid);
  if (!render || srid == null || !n) return null;
  return { tag: n.t.toLowerCase(), s: n.s, e: n.e, label: elementLabelOf(render, srid) };
}

// ------------------------------------------------------------------------------------------------------ cleaning

/** @param {RenderResult|null} render @param {any} srid */
function validSrid(render, srid) {
  if (srid == null || srid === '') return null;
  const n = Number(srid);
  return Number.isInteger(n) && nodeOf(render, n) ? n : null;
}

/** @param {any} r */
function cleanRegion(r) {
  if (!r || typeof r !== 'object') return null;
  const vals = [r.x, r.y, r.w, r.h].map(Number);
  if (vals.some((v) => !Number.isFinite(v))) return null;
  const c01 = (/** @type {number} */ v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const [x, y] = [c01(vals[0]), c01(vals[1])];
  return { x, y, w: c01(Math.min(vals[2], 1 - x)), h: c01(Math.min(vals[3], 1 - y)) };
}

/** @param {any} svg */
function cleanSvg(svg) {
  if (!svg || typeof svg !== 'object') return null;
  const nodeId = String(svg.nodeId ?? '').trim();
  const label = collapseWs(String(svg.label ?? '')).trim();
  return nodeId || label ? { nodeId, label } : null;
}

/** @param {any} c @param {number|null} tableSrid */
function cleanCell(c, tableSrid) {
  const int = (/** @type {any} */ v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const txt = (/** @type {any} */ v) => collapseWs(String(v ?? '')).trim();
  /** @type {import('../../shared/types.js').CellTarget} */
  const cell = { row: int(c.row), col: int(c.col), rowKey: txt(c.rowKey), colHeader: txt(c.colHeader), text: txt(c.text) };
  return tableSrid != null ? { tableSrid, ...cell } : cell;
}
