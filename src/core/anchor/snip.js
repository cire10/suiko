// @ts-check
// Snip anchors: the reviewer pressed `b` and dragged a box over ANY area of the rendered doc (text, images,
// diagrams, a mix). The guest sends a SnipCapture (src/shared/protocol.js, above SNIP); create.js turns it into:
//
//   kind 'snip'   src     WHOLE source lines from the first to the last covered block (nodes[srid].s .. .e over
//                         the capture's srids, start/endSrid included; the container's range when the box covers no
//                         stamped block). It re-anchors like a text / source range (reanchor.js relocateText), so a
//                         snip follows the covered source across versions (exact / moved / edited / changed /
//                         orphaned), and src> in the packet is an exact Edit old_string of those lines.
//                 srid / endSrid  the first and the last covered BLOCK (snipSpan: the deepest block elements
//                         holding the range's first / last non-blank characters), not their common ancestor, so an
//                         outline of the snip never grows to a whole section; quote is always null.
//                 region  the box as fractions of the container's border box; null when there is no container.
//                 snip    SnipInfo (below).
//   kind 'doc'    when the box covers no stamped element at all (a GENERAL comment that still carries `snip`).
//
//   SnipInfo = { label,      the guest's label ('area over "2. Request flow" (figure + 2 paragraphs)'), for the UI
//                covers,     what the box covers, computed from the render at creation: 'figure + 2 paragraphs'
//                text,       visible text inside the box, whitespace-collapsed (<= SNIP.maxText chars)
//                region,     the box as captured (fractions of the container, or of the document without one)
//                container } { srid, tag, s, e, label } of the deepest stamped element containing the whole box, at
//                            the anchor's version. Re-resolved on every version (reanchor.js nextSnip: the same tag
//                            at the mapped start, else the one element with the same label, and it must still overlap
//                            the snip's lines); null once lost (the box is then no longer drawn, only the blocks).
// Painting (targets.js): container found -> DomTarget {kind:'element', srid: container, region}; otherwise the
// covered blocks are outlined ({kind:'source', srid, endSrid}, no quote).
// Label (packet, preview, DomTarget): 'snip (figure + 2 paragraphs)' (see snipLabel).

import { SNIP } from '../../shared/protocol.js';
import { collapseWs } from '../text/index.js';
import { tableOf } from './table.js';
import { ancestorsOf, deepestContaining, elementLabelOf, nodeOf, oneLine, sridSpan, trimRange } from './util.js';

/**
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {{ srid: number | null, tag: string, s: number, e: number, label: string }} SnipContainer
 * @typedef {{ label: string, covers: string, text: string, region: { x: number, y: number, w: number, h: number } | null,
 *   container: SnipContainer | null }} SnipInfo
 */

/** At most this many srids of a capture are looked at (the guest sends at most SNIP.maxSrids). */
const MAX_INPUT_SRIDS = SNIP.maxSrids * 4;
/** At most this many kinds of content are named in `covers`. */
const MAX_COVER_KINDS = 4;

const PLURAL = /** @type {Record<string, string>} */ ({
  paragraph: 'paragraphs', heading: 'headings', list: 'lists', table: 'tables', figure: 'figures', image: 'images',
  diagram: 'diagrams', formula: 'formulas', 'code block': 'code blocks', quote: 'quotes', media: 'media',
  embed: 'embeds', block: 'blocks', rule: 'rules', 'front matter': 'front matter', details: 'details', form: 'forms',
});

/**
 * Valid srids of a capture (its srids plus startSrid / endSrid), deduplicated, in source order.
 * @param {RenderResult | null} render
 * @param {any} cap SnipCapture
 * @returns {number[]}
 */
export function snipSrids(render, cap) {
  const raw = [...(Array.isArray(cap?.srids) ? cap.srids.slice(0, MAX_INPUT_SRIDS) : []), cap?.startSrid, cap?.endSrid];
  /** @type {Set<number>} */
  const seen = new Set();
  for (const v of raw) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isInteger(n) && nodeOf(render, n)) seen.add(n);
  }
  return [...seen].sort((a, b) => {
    const na = /** @type {any} */ (nodeOf(render, a));
    const nb = /** @type {any} */ (nodeOf(render, b));
    return na.s - nb.s || nb.e - na.e || a - b;
  });
}

/**
 * The container record of an element: { srid, tag, s, e, label } (source range at this render's version).
 * @param {RenderResult | null} render
 * @param {number | null | undefined} srid
 * @returns {SnipContainer | null}
 */
export function snipContainerOf(render, srid) {
  const n = nodeOf(render, srid);
  if (!render || srid == null || !n) return null;
  return { srid, tag: n.t.toLowerCase(), s: n.s, e: n.e, label: elementLabelOf(render, srid) };
}

/**
 * What a set of covered blocks is, in a few words: 'figure + 2 paragraphs', 'heading + list + code block',
 * 'table'. Blocks of one table / figure / list / quote / diagram / code block count once. '' for none.
 * @param {RenderResult | null} render
 * @param {number[]} srids
 * @returns {string}
 */
export function snipCovers(render, srids) {
  if (!render) return '';
  /** @type {Map<string, Set<string>>} */
  const byWhat = new Map();
  for (const srid of srids) {
    const u = unitOf(render, srid);
    if (!u) continue;
    let set = byWhat.get(u.what);
    if (!set) byWhat.set(u.what, (set = new Set()));
    set.add(u.key);
  }
  const parts = [...byWhat].map(([what, keys]) => (keys.size === 1 ? what : `${keys.size} ${PLURAL[what] ?? `${what}s`}`));
  if (parts.length > MAX_COVER_KINDS) return `${parts.slice(0, MAX_COVER_KINDS).join(' + ')} + more`;
  return parts.join(' + ');
}

/**
 * srid / endSrid of a snip range: the deepest block elements containing its first and last non-blank characters
 * (endSrid null when it is the same block); sridSpan when no block holds one of them.
 * @param {RenderResult | null} render
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {{ srid: number | null, endSrid: number | null }}
 */
export function snipSpan(render, source, start, end) {
  if (!render?.srcmap) return { srid: null, endSrid: null };
  const [s, e] = trimRange(source, start, end);
  if (e <= s) return sridSpan(render, source, start, end);
  const block = (/** @type {number} */ _srid, /** @type {any} */ n) => Boolean(n.b);
  const first = deepestContaining(render, s, s, block);
  const last = deepestContaining(render, e - 1, e - 1, block);
  if (first == null || last == null) return sridSpan(render, source, start, end);
  return { srid: first, endSrid: last !== first ? last : null };
}

/**
 * The SnipInfo of a capture.
 * @param {RenderResult | null} render
 * @param {any} cap SnipCapture
 * @param {number[]} srids valid covered srids (snipSrids)
 * @param {number | null} containerSrid valid container srid
 * @param {SnipInfo['region']} region cleaned region
 * @returns {SnipInfo}
 */
export function snipInfo(render, cap, srids, containerSrid, region) {
  return {
    label: oneLine(String(cap?.label ?? ''), 160),
    covers: snipCovers(render, srids.length ? srids : containerSrid != null ? [containerSrid] : []),
    text: collapseWs(String(cap?.text ?? '')).trim().slice(0, SNIP.maxText),
    region,
    container: snipContainerOf(render, containerSrid),
  };
}

/**
 * 'snip (figure + 2 paragraphs)' / 'snip'.
 * @param {{ snip?: SnipInfo | null }} anchor
 * @returns {string}
 */
export function snipLabel(anchor) {
  const covers = anchor.snip?.covers ?? '';
  return covers ? `snip (${covers})` : 'snip';
}

/**
 * The content unit a covered block belongs to and its kind.
 * @param {RenderResult} render
 * @param {number} srid
 * @returns {{ key: string, what: string } | null}
 */
function unitOf(render, srid) {
  const n = nodeOf(render, srid);
  if (!n) return null;
  const chain = ancestorsOf(render, srid); // self first
  for (const x of chain) {
    const m = /** @type {any} */ (nodeOf(render, x));
    if (m.k === 'mermaid') return { key: `${x}`, what: 'diagram' };
    if (m.k === 'frontmatter') return { key: `${x}`, what: 'front matter' };
    if (m.k === 'code' && m.b) return { key: `${x}`, what: 'code block' };
    if (m.k === 'math' && m.b) return { key: `${x}`, what: 'formula' };
  }
  const table = tableOf(render, srid);
  if (table != null) return { key: `${table}`, what: 'table' };
  for (const x of chain) {
    const tag = String(nodeOf(render, x)?.t ?? '').toLowerCase();
    if (tag === 'figure') return { key: `${x}`, what: 'figure' };
    if (tag === 'blockquote') return { key: `${x}`, what: 'quote' };
    if (tag === 'details') return { key: `${x}`, what: 'details' };
  }
  const tag = n.t.toLowerCase();
  if (/^h[1-6]$/.test(tag) || n.h) return { key: `${srid}`, what: 'heading' };
  if (tag === 'svg' || n.k === 'svg') return { key: `${srid}`, what: 'diagram' };
  if (['img', 'picture', 'canvas'].includes(tag) || n.k === 'img') return { key: `${srid}`, what: 'image' };
  if (['video', 'audio'].includes(tag) || n.k === 'media') return { key: `${srid}`, what: 'media' };
  if (['iframe', 'embed', 'object'].includes(tag) || n.k === 'embed') return { key: `${srid}`, what: 'embed' };
  if (['li', 'dt', 'dd', 'ul', 'ol', 'dl'].includes(tag)) {
    const list = chain.find((x) => ['ul', 'ol', 'dl'].includes(String(nodeOf(render, x)?.t ?? '').toLowerCase()));
    return { key: `${list ?? srid}`, what: 'list' };
  }
  if (tag === 'p') return { key: `${srid}`, what: 'paragraph' };
  if (tag === 'hr') return { key: `${srid}`, what: 'rule' };
  if (tag === 'form') return { key: `${srid}`, what: 'form' };
  return { key: `${srid}`, what: 'block' };
}
