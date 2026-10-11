// @ts-check
// rehype plugin (runs after rehype-raw, before rehype-katex/highlight): prepares positioned elements whose
// rendering would otherwise lose their source positions (design 6.2):
//   1. pre>code.language-mermaid -> <pre class="mermaid" data-sr-kind="mermaid">source</pre> (pre's position);
//   2. math: code.math-inline -> wrapped in <span class="sr-math" data-sr-kind="math">, pre>code.math-display ->
//      wrapped in <div class="sr-math" data-sr-kind="math">, both carrying the math node's position (KaTeX
//      output has none);
//   3. every pre with a positioned code gets data-sr-kind="code" and a verbatim content mapping
//      {contentStart, contentEnd, firstLine} stored on node.data.srContent (read by rehype-sr-stamp);
//   4. the front-matter code block is wrapped in <details class="sr-frontmatter" open><summary>Front matter</summary>.
// The source string comes from file.data.sr.source (set by render/markdown.js) or the file's value.

import { lineIndex } from '../../text/lines.js';
import { fenceContent } from '../srcmap.js';
import { FRONTMATTER_META, FRONTMATTER_PROP } from './remark-sr-frontmatter.js';

/**
 * @typedef {{ type: string, tagName?: string, properties?: Record<string, any>, children?: any[], position?: any,
 *             data?: Record<string, any>, value?: string }} HNode
 */

/** @param {HNode} node */
function classes(node) {
  const c = node.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(/\s+/) : [];
}

/** @param {HNode} node */
function hasOffsets(node) {
  return node.position?.start?.offset != null && node.position?.end?.offset != null;
}

/** @param {HNode} node */
function textOf(node) {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * @returns {(tree: any, file: any) => void}
 */
export default function rehypeSrPrepare() {
  return (tree, file) => {
    const source = file?.data?.sr?.source ?? String(file?.value ?? '');
    /** @type {import('../../text/lines.js').LineIndex | null} */
    let li = null;
    const lines = () => (li ??= lineIndex(source));
    /** @param {HNode} node */
    const content = (node) => fenceContent(source, lines(), node.position.start.offset, node.position.end.offset);

    /** @param {HNode} parent */
    const walk = (parent) => {
      const kids = parent.children ?? [];
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.type !== 'element') continue;
        if (node.tagName === 'pre') {
          const code = (node.children ?? []).find((/** @type {HNode} */ c) => c.type === 'element' && c.tagName === 'code');
          if (code) {
            const cls = classes(code);
            if (cls.includes('language-mermaid')) {
              /** @type {HNode} */
              const pre = {
                type: 'element', tagName: 'pre', properties: { className: ['mermaid'], dataSrKind: 'mermaid' },
                children: [{ type: 'text', value: textOf(code).replace(/\n$/, '') }], position: node.position,
              };
              if (hasOffsets(node)) pre.data = { srContent: content(node) };
              kids[i] = pre;
              continue;
            }
            if (cls.includes('math-display')) {
              /** @type {HNode} */
              const wrap = {
                type: 'element', tagName: 'div', properties: { className: ['sr-math'], dataSrKind: 'math' },
                children: [node], position: node.position,
              };
              if (hasOffsets(node)) wrap.data = { srContent: content(node) };
              delete node.position;
              kids[i] = wrap;
              continue;
            }
            if (hasOffsets(node) || hasOffsets(code)) {
              if (!hasOffsets(node)) node.position = code.position;
              node.properties = { ...(node.properties ?? {}), dataSrKind: 'code' };
              node.data = { ...(node.data ?? {}), srContent: content(node) };
            }
            const isFrontmatter = code.data?.meta === FRONTMATTER_META || code.properties?.[FRONTMATTER_PROP] != null;
            if (code.properties) delete code.properties[FRONTMATTER_PROP];
            if (isFrontmatter) {
              const summary = { type: 'element', tagName: 'summary', properties: {}, children: [{ type: 'text', value: 'Front matter' }] };
              /** @type {HNode} */
              const details = {
                type: 'element', tagName: 'details', properties: { className: ['sr-frontmatter'], open: true, dataSrKind: 'frontmatter' },
                children: [summary, node], position: node.position,
              };
              if (node.data?.srContent) details.data = { srContent: node.data.srContent };
              kids[i] = details;
              continue;
            }
          }
          continue; // code text needs no further preparation
        }
        if (node.tagName === 'code' && classes(node).includes('math-inline')) {
          kids[i] = {
            type: 'element', tagName: 'span', properties: { className: ['sr-math'], dataSrKind: 'math' },
            children: [node], position: node.position,
          };
          delete node.position;
          continue;
        }
        walk(node);
      }
    };
    walk(tree);
  };
}
