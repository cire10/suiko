// @ts-check
// rehype plugin (LAST before stringify): assigns data-srid to every element with a source position, in document
// order, and builds the render data for the Markdown pipeline (BUILD_AMENDMENTS 3.1):
//   SrcMap nodes (tag, offsets, lines, parent, block flag, kind, heading, key attributes, verbatim content map),
//   the global rendered-text stream with per-srid spans (TEXT_EXCLUDE applied), the outline, asset/external
//   references and feature flags.
// Elements without positions (KaTeX output, highlight spans, generated footnote markup) get no srid; their text
// is attributed to the nearest positioned ancestor. Input: file.data.sr = { source, stamp, docPath }.
// Output: file.data.srResult = { srcmap, text, outline, assets, externals, features }.

import { RefCollector } from '../assets.js';
import { isTextExcluded, kindOf, pickAttrs, SrcMapBuilder } from '../srcmap.js';

/** hast property names for the HTML attributes we read. */
const PROP = /** @type {Record<string, string>} */ ({
  class: 'className', srcset: 'srcSet', 'xlink:href': 'xLinkHref', 'data-sr-ignore': 'dataSrIgnore',
  'data-sr-kind': 'dataSrKind', 'data-srid': 'dataSrid',
});

/**
 * Attribute getter over hast properties (arrays are space-joined; booleans become '').
 * @param {Record<string, any>} props
 * @returns {(name: string) => string|undefined}
 */
export function hastAttrGetter(props) {
  return (name) => {
    const v = props[PROP[name] ?? name];
    if (v == null || v === false) return undefined;
    if (Array.isArray(v)) return v.join(' ');
    if (v === true) return '';
    return String(v);
  };
}

/** @param {any} node */
function textOf(node) {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Numeric data-srid values authored in raw HTML (never reassigned, so the guest never sees duplicates).
 * @param {any} node
 * @param {Set<number>} [out]
 */
function existingSrids(node, out = new Set()) {
  for (const c of node.children ?? []) {
    if (c.type !== 'element') continue;
    const v = c.properties?.dataSrid;
    if (v != null && /^\d+$/.test(String(v))) out.add(Number(v));
    existingSrids(c, out);
  }
  return out;
}

/**
 * @returns {(tree: any, file: any) => void}
 */
export default function rehypeSrStamp() {
  return (tree, file) => {
    const opts = file?.data?.sr ?? {};
    const source = opts.source ?? String(file?.value ?? '');
    const stamp = opts.stamp !== false;
    const b = new SrcMapBuilder(source, { reserved: existingSrids(tree) });
    const refs = new RefCollector(opts.docPath);
    const features = { mermaid: false, math: false, code: false };

    /**
     * @param {any} parent
     * @param {number} parentSrid
     * @param {boolean} excluded
     */
    const walk = (parent, parentSrid, excluded) => {
      for (const node of parent.children ?? []) {
        if (node.type === 'text') {
          if (!excluded) b.pushText(node.value ?? '');
          continue;
        }
        if (node.type !== 'element') continue;
        const tag = String(node.tagName).toLowerCase();
        const props = (node.properties ??= {});
        const get = hastAttrGetter(props);
        const srKind = get('data-sr-kind');
        const classList = (get('class') ?? '').split(/\s+/).filter(Boolean);

        refs.addElement(tag, get);
        if (tag === 'style') refs.addCss(textOf(node));

        const kind = kindOf(tag, srKind);
        if (kind === 'mermaid') features.mermaid = true;
        else if (kind === 'math') features.math = true;
        else if (kind === 'code') features.code = true;

        const ex = excluded || isTextExcluded(tag, classList, (a) => get(a) !== undefined, srKind);
        const pos = node.position;
        let srid = 0;
        if (pos?.start?.offset != null && pos?.end?.offset != null && get('data-srid') === undefined) {
          srid = b.add({
            tag, s: pos.start.offset, e: pos.end.offset, parent: parentSrid, kind, attrs: pickAttrs(get),
            content: node.data?.srContent,
          });
          if (stamp) props.dataSrid = srid;
          b.openSpan(srid);
        }
        walk(node, srid || parentSrid, ex);
        if (srid) b.closeSpan(srid);
      }
    };
    walk(tree, 0, false);

    const { srcmap, text, outline } = b.finish();
    file.data.srResult = { srcmap, text, outline, assets: refs.assets, externals: refs.externals, features };
  };
}
