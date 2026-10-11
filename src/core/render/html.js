// @ts-check
// HTML pipeline (design 6.3): parse with parse5 (source locations on), then splice ` data-srid="n"` into the
// ORIGINAL start tags (never re-serialise), so the served page is byte-identical to the author's file apart from
// the inserted attributes.
//
// Eligible elements: have a startTag location, are inside <body> (not <head>, not <html>/<head> themselves), are
// not script/style/template/noscript/title, do not already carry data-srid, and are not template content.
// Insertion point: before the final '>'; for '/>' endings before the '/', unless the last attribute is unquoted
// and ends right before the '/' (the slash is part of its value): then before '>' for HTML elements, and foreign
// (SVG/MathML) elements are left unstamped. Removing every inserted attribute yields the original string.
// guestInsertAt: after the <head> start tag, else after <html>, else after the doctype, else 0 (after a BOM).
// The srcmap uses each element's full outer range (startOffset..endOffset); the text stream covers <body> only
// and applies TEXT_EXCLUDE. pre.mermaid/div.mermaid elements are kind 'mermaid' (text excluded); when the doc
// has them and no script mentions mermaid, features.mermaid is set so the vendored mermaid gets appended.

import { parse } from 'parse5';
import { RefCollector } from './assets.js';
import { isTextExcluded, kindOf, pickAttrs, pickTitle, SrcMapBuilder } from './srcmap.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const NEVER_STAMP = new Set(['html', 'head', 'script', 'style', 'template', 'noscript', 'title']);
const LEADING_NL_TAGS = new Set(['pre', 'listing', 'textarea']);

/**
 * @typedef {Object} P5Attr
 * @property {string} name
 * @property {string} value
 * @property {string} [prefix]
 */
/**
 * @typedef {Object} P5Node
 * @property {string} nodeName
 * @property {string} [tagName]
 * @property {string} [namespaceURI]
 * @property {P5Attr[]} [attrs]
 * @property {P5Node[]} [childNodes]
 * @property {string} [value]
 * @property {any} [sourceCodeLocation]
 */

/** @param {P5Node} el */
function attrGetter(el) {
  const attrs = el.attrs ?? [];
  return (/** @type {string} */ name) => {
    for (const a of attrs) if ((a.prefix ? `${a.prefix}:${a.name}` : a.name) === name) return a.value;
    return undefined;
  };
}

/** @param {P5Node} node */
function textContent(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textContent).join('');
}

/**
 * Where to insert ` data-srid` in an element's start tag, or -1 when it must not be stamped.
 * @param {string} source
 * @param {P5Node} el
 * @returns {number}
 */
export function stampInsertionPoint(source, el) {
  const st = el.sourceCodeLocation?.startTag;
  if (!st) return -1;
  const tagText = source.slice(st.startOffset, st.endOffset);
  if (!tagText.endsWith('>')) return -1;
  if (!tagText.endsWith('/>')) return st.endOffset - 1;
  /** @type {{ startOffset: number, endOffset: number } | null} */
  let last = null;
  for (const loc of Object.values(st.attrs ?? {})) {
    if (!last || loc.endOffset > last.endOffset) last = loc;
  }
  if (last && last.endOffset === st.endOffset - 1) {
    const raw = source.slice(last.startOffset, last.endOffset);
    const eq = raw.indexOf('=');
    const unquoted = eq >= 0 && !/^\s*["']/.test(raw.slice(eq + 1));
    if (unquoted) return el.namespaceURI === HTML_NS ? st.endOffset - 1 : -1;
  }
  return st.endOffset - 2;
}

/**
 * Numeric data-srid values already present in the document (e.g. a saved rendered page): our numbering skips
 * them so the guest never sees duplicates.
 * @param {P5Node} node
 * @param {Set<number>} [out]
 */
function existingSrids(node, out = new Set()) {
  for (const c of node.childNodes ?? []) {
    if (!c.tagName) continue;
    const v = attrGetter(c)('data-srid');
    if (v != null && /^\d+$/.test(v)) out.add(Number(v));
    existingSrids(c, out);
  }
  return out;
}

/**
 * Find the first element matching a predicate (depth-first, document order).
 * @param {P5Node} node
 * @param {(n: P5Node) => boolean} pred
 * @returns {P5Node|null}
 */
function findElement(node, pred) {
  for (const c of node.childNodes ?? []) {
    if (c.tagName && pred(c)) return c;
    const r = c.tagName ? findElement(c, pred) : null;
    if (r) return r;
  }
  return null;
}

/**
 * Render (stamp + analyse) an HTML document.
 * @param {string} source decoded source
 * @param {{ docPath?: string, stamp?: boolean }} [opts]
 */
export function renderHtml(source, { docPath, stamp = true } = {}) {
  const doc = /** @type {P5Node} */ (/** @type {unknown} */ (parse(source, { sourceCodeLocationInfo: true })));
  const b = new SrcMapBuilder(source, { reserved: existingSrids(doc) });
  const refs = new RefCollector(docPath);
  const base = findElement(doc, (n) => n.tagName === 'base' && attrGetter(n)('href') != null);
  if (base) refs.baseHref = attrGetter(base)('href') ?? null;

  /** @type {{ at: number, text: string }[]} */
  const inserts = [];
  let titleText = '';
  let hasMermaidEls = false;
  let scriptMentionsMermaid = false;
  let hasCode = false;

  /**
   * @param {P5Node} node
   * @param {{ parent: number, inHead: boolean, inBody: boolean, excluded: boolean }} ctx
   */
  const walk = (node, ctx) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === '#text') {
        if (ctx.inBody && !ctx.excluded) b.pushText(child.value ?? '');
        continue;
      }
      if (!child.tagName) continue; // comments, doctype
      const tag = child.tagName;
      const lower = tag.toLowerCase();
      const get = attrGetter(child);
      const classes = (get('class') ?? '').split(/\s+/).filter(Boolean);

      refs.addElement(lower, get);
      if (lower === 'style') refs.addCss(textContent(child));
      if (lower === 'title' && ctx.inHead && !titleText) titleText = textContent(child);
      if (lower === 'script' && /mermaid/i.test(`${get('src') ?? ''} ${textContent(child)}`)) scriptMentionsMermaid = true;

      const isMermaid = (lower === 'pre' || lower === 'div') && classes.includes('mermaid');
      if (isMermaid) hasMermaidEls = true;
      const srKind = get('data-sr-kind') ?? (isMermaid ? 'mermaid' : lower === 'pre' ? 'code' : undefined);
      const kind = kindOf(lower, srKind);
      if (kind === 'code') hasCode = true;
      const excluded = ctx.excluded || isTextExcluded(lower, classes, (a) => get(a) !== undefined, srKind);

      const loc = child.sourceCodeLocation;
      let srid = 0;
      if (ctx.inBody && !ctx.inHead && loc?.startTag && !NEVER_STAMP.has(lower) && get('data-srid') === undefined) {
        const at = stampInsertionPoint(source, child);
        if (at >= 0) {
          srid = b.add({
            tag, s: loc.startOffset, e: loc.endOffset ?? loc.startTag.endOffset, parent: ctx.parent, kind,
            attrs: pickAttrs(get), content: kind === 'code' || kind === 'mermaid' ? contentRange(source, b, child, lower) : undefined,
          });
          if (stamp) inserts.push({ at, text: ` data-srid="${srid}"` });
          b.openSpan(srid);
        }
      }
      if (lower !== 'template') {
        walk(child, {
          parent: srid || ctx.parent,
          inHead: ctx.inHead || lower === 'head',
          inBody: ctx.inBody || lower === 'body',
          excluded,
        });
      }
      if (srid) b.closeSpan(srid);
    }
  };
  walk(doc, { parent: 0, inHead: false, inBody: false, excluded: false });

  const { srcmap, text, outline } = b.finish();
  const { guestAt, bodyEnd } = landmarks(doc, source);
  const { html, shift } = splice(source, inserts);
  const title = pickTitle(titleText, outline, docPath);
  return {
    html,
    guestInsertAt: shift(guestAt),
    bodyEndAt: shift(bodyEnd),
    srcmap,
    text,
    outline,
    assets: refs.assets,
    externals: refs.externals,
    title,
    features: { mermaid: hasMermaidEls && !scriptMentionsMermaid, math: false, code: hasCode },
  };
}

/**
 * Verbatim content range of a pre / mermaid element (the parser drops one leading newline in pre/listing/textarea).
 * @param {string} source @param {SrcMapBuilder} b @param {P5Node} el @param {string} lower
 */
function contentRange(source, b, el, lower) {
  const loc = el.sourceCodeLocation;
  let contentStart = loc.startTag.endOffset;
  if (LEADING_NL_TAGS.has(lower)) {
    if (source.startsWith('\r\n', contentStart)) contentStart += 2;
    else if (source[contentStart] === '\n') contentStart += 1;
  }
  const contentEnd = Math.max(contentStart, loc.endTag ? loc.endTag.startOffset : loc.endOffset ?? contentStart);
  return { contentStart, contentEnd, firstLine: b.lines.lineOf(contentStart) };
}

/**
 * Guest insertion point and the end of the body content (both in source offsets).
 * @param {P5Node} doc @param {string} source
 */
function landmarks(doc, source) {
  const htmlEl = (doc.childNodes ?? []).find((n) => n.tagName === 'html');
  const head = htmlEl?.childNodes?.find((n) => n.tagName === 'head');
  const body = htmlEl?.childNodes?.find((n) => n.tagName === 'body');
  const doctype = (doc.childNodes ?? []).find((n) => n.nodeName === '#documentType');
  let guestAt = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (head?.sourceCodeLocation?.startTag) guestAt = head.sourceCodeLocation.startTag.endOffset;
  else if (htmlEl?.sourceCodeLocation?.startTag) guestAt = htmlEl.sourceCodeLocation.startTag.endOffset;
  else if (doctype?.sourceCodeLocation) guestAt = doctype.sourceCodeLocation.endOffset;
  let bodyEnd = source.length;
  if (body?.sourceCodeLocation?.endTag) bodyEnd = body.sourceCodeLocation.endTag.startOffset;
  else if (htmlEl?.sourceCodeLocation?.endTag) bodyEnd = htmlEl.sourceCodeLocation.endTag.startOffset;
  return { guestAt, bodyEnd };
}

/**
 * Apply insertions (equivalent to splicing from the highest offset down) and return an offset shifter that maps
 * a source offset to the output (insertions at the same offset land before the source character).
 * @param {string} source
 * @param {{ at: number, text: string }[]} inserts
 */
function splice(source, inserts) {
  const sorted = [...inserts].sort((x, y) => x.at - y.at);
  /** @type {string[]} */
  const parts = [];
  let last = 0;
  for (const ins of sorted) {
    parts.push(source.slice(last, ins.at), ins.text);
    last = ins.at;
  }
  parts.push(source.slice(last));
  /** @param {number} off */
  const shift = (off) => {
    let d = 0;
    for (const ins of sorted) {
      if (ins.at >= off) break;
      d += ins.text.length;
    }
    return off + d;
  };
  return { html: parts.join(''), shift };
}

/**
 * Remove the attributes inserted by stamping (` data-srid="n"`), e.g. to verify the round trip.
 * @param {string} html
 */
export function unstamp(html) {
  return html.replace(/ data-srid="\d+"/g, '');
}
