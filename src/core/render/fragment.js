// @ts-check
// Fragment rendering for deletion popovers and suggestion previews (BUILD_AMENDMENTS 4.1):
// renderFragment({ format, source }) -> Promise<string>, an HTML fragment (no shell, no data-srid) with active
// content removed: script/iframe/object/embed/frame(set)/base/meta/link/style/template/noscript/title elements,
// on* event-handler attributes, srcdoc, and javascript:/vbscript:/data:text/html URLs. KaTeX inline styles and
// highlight classes are kept. This is defence in depth, not a full sanitiser: consumers inserting the result
// into a privileged origin should still run DOMPurify.

import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { renderMarkdownBody } from './markdown.js';

const DROP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'meta', 'link',
  'style', 'template', 'noscript', 'applet', 'portal', 'title', 'head']);
const URL_PROPS = new Set(['href', 'src', 'xLinkHref', 'poster', 'data', 'action', 'formAction', 'cite',
  'background', 'ping', 'srcSet', 'manifest', 'codeBase', 'longDesc', 'useMap']);
const BAD_URL = /^(?:javascript|vbscript|livescript):|^data:(?!image\/(?:png|gif|jpe?g|webp|avif|bmp);)/i;

/**
 * Remove active content from a hast tree in place.
 * @param {any} tree
 */
export function sanitizeHast(tree) {
  /** @param {any} parent */
  const walk = (parent) => {
    if (!Array.isArray(parent.children)) return;
    parent.children = parent.children.filter((/** @type {any} */ node) => {
      if (node.type === 'comment' || node.type === 'raw' || node.type === 'doctype') return false;
      if (node.type !== 'element') return true;
      if (DROP_TAGS.has(String(node.tagName).toLowerCase())) return false;
      const props = node.properties ?? {};
      for (const key of Object.keys(props)) {
        if (/^on/i.test(key) || key === 'srcDoc' || key === 'dataSrid') {
          delete props[key];
          continue;
        }
        if (URL_PROPS.has(key)) {
          const values = Array.isArray(props[key]) ? props[key] : [props[key]];
          if (values.some((v) => BAD_URL.test(String(v ?? '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '')))) delete props[key];
        }
      }
      walk(node);
      return true;
    });
  };
  walk(tree);
  return tree;
}

/**
 * Synchronous variant of renderFragment (used by changeSet).
 * @param {{ format: 'markdown'|'html'|string, source: string }} p
 * @returns {string}
 */
export function renderFragmentSync({ format, source }) {
  const src = String(source ?? '');
  if (!src.trim()) return '';
  if (format === 'markdown') return renderMarkdownBody(src, sanitizeHast).trim();
  const tree = { type: 'root', children: [{ type: 'raw', value: src }] };
  const proc = unified().use(rehypeRaw).use(() => sanitizeHast).use(rehypeStringify);
  const out = proc.runSync(/** @type {any} */ (tree));
  return String(proc.stringify(/** @type {any} */ (out))).trim();
}

/**
 * @param {{ format: 'markdown'|'html'|string, source: string }} p
 * @returns {Promise<string>}
 */
export async function renderFragment(p) {
  return renderFragmentSync(p);
}
