// @ts-check
// Fetched web content -> review text (`specreview snapshot <url>`, design 6.2 "Conversion"). Nothing a page carries
// can run, load or submit anything in the review UI:
//   htmlToMarkdown(html, { baseUrl })  -> { markdown, removed, textChars, title, hadScripts }   (default)
//   sanitizeHtml(html, { baseUrl })    -> { html, removed, textChars, title, hadScripts }       (--as-html)
//   stripRawHtmlFromMarkdown(md)       -> { markdown, removed }                                (fetched Markdown)
//
// HTML: parsed with hast-util-from-html (parse5, the browser's algorithm), then cleaned with an ALLOWLIST modelled
// on GitHub's (hast-util-sanitize's defaultSchema; that package is not installed, so the schema is ported here):
//   - only the listed tags survive; script, style, iframe, object, embed, svg, math, template, noscript, form
//     controls, media and every <head> element are removed with their content (counted in `removed`); any other
//     unlisted tag (nav, header, form, font, center...) is replaced by its children; comments and the doctype go;
//   - only the listed attributes survive (no on* handlers, no style, no formaction, no srcset); href/src/cite are
//     resolved against the page's final URL and kept only when http(s) (href also mailto/irc/xmpp) after the WHATWG
//     URL parser's normalisation (so `jav&#x09;ascript:` is caught); ids and names get the `user-content-` prefix
//     (no DOM clobbering of the guest's globals); an <input> survives only as a disabled checkbox; table parts
//     survive only inside a <table>.
//   - when the page has exactly one <main> (or role=main), else exactly one <article>, only that part is kept (site
//     navigation and footers are not the content under review).
// Markdown (the default): the clean tree becomes mdast (a small hast -> mdast converter: hast-util-to-mdast is not
// installed either), serialised by remark-stringify with the renderer's extensions (GFM, frontmatter, math: a `$`
// in page text is escaped, never rendered as math). There is no raw-HTML node in the output by construction.
// Fetched Markdown: parsed as the renderer parses it; when it holds raw HTML or links with other schemes, those are
// removed (an HTML block at the top level is converted through the HTML path above) and the text re-serialised; a
// clean text is kept byte for byte.

import { fromHtml } from 'hast-util-from-html';
import { toString as hastToString } from 'hast-util-to-string';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

// ------------------------------------------------------------------------------------------------ schema

/** Tags kept (GitHub's list, plus a few harmless phrasing and figure tags). */
const TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var',
]);

/** Tags removed together with their content. */
const STRIP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'svg', 'math', 'canvas', 'audio', 'video', 'track', 'source', 'map', 'area', 'button', 'select', 'option',
  'optgroup', 'textarea', 'datalist', 'output', 'progress', 'meter', 'dialog', 'head', 'title', 'meta', 'link',
  'base', 'portal', 'slot', 'xmp', 'plaintext', 'noembed', 'noframes',
]);

const ARIA = ['ariaDescribedBy', 'ariaLabel', 'ariaLabelledBy'];

/** Attributes every kept tag may carry (GitHub's '*' list without the form attributes). */
const GLOBAL_ATTRS = [
  'abbr', 'align', 'alt', 'axis', 'border', 'cellPadding', 'cellSpacing', 'char', 'charOff', 'clear', 'colSpan',
  'color', 'cols', 'compact', 'dateTime', 'dir', 'headers', 'height', 'hrefLang', 'id', 'itemProp', 'label', 'lang',
  'name', 'noShade', 'noWrap', 'open', 'rowSpan', 'rows', 'rules', 'scope', 'span', 'start', 'summary', 'title',
  'vAlign', 'value', 'width',
];

/**
 * Per-tag attributes. A string allows the attribute; [name, ...values] allows only those values (a RegExp matches a
 * class token or the value).
 * @type {Record<string, Array<string | [string, ...Array<string | RegExp | boolean>]>>}
 */
const TAG_ATTRS = {
  a: [...ARIA, 'href'],
  blockquote: ['cite'],
  code: [['className', /^language-./]],
  del: ['cite'],
  div: ['itemScope', 'itemType'],
  dl: [...ARIA],
  img: [...ARIA, 'src'],
  input: [['disabled', true], ['type', 'checkbox'], 'checked'],
  ins: ['cite'],
  li: [['className', 'task-list-item']],
  ol: [...ARIA, 'reversed', ['className', 'contains-task-list']],
  q: ['cite'],
  summary: [...ARIA],
  table: [...ARIA],
  ul: [...ARIA, ['className', 'contains-task-list']],
};

/** URL attributes and the schemes they may use (after resolution against the page URL). */
const PROTOCOLS = /** @type {Record<string, string[]>} */ ({
  href: ['http:', 'https:', 'mailto:', 'irc:', 'ircs:', 'xmpp:'],
  src: ['http:', 'https:'],
  cite: ['http:', 'https:'],
});

/** Attributes holding ids (prefixed so a page cannot clobber the guest's globals). */
const CLOBBER = new Set(['id', 'name']);
const CLOBBER_LIST = new Set(['ariaDescribedBy', 'ariaLabelledBy']);
export const CLOBBER_PREFIX = 'user-content-';

/** Table parts kept only inside a <table>. */
const NEEDS_TABLE = new Set(['tbody', 'td', 'th', 'thead', 'tfoot', 'tr', 'caption']);

// ------------------------------------------------------------------------------------------------ sanitize

/**
 * @typedef {{ type: string, tagName?: string, properties?: Record<string, any>, children?: HastNode[], value?: string,
 *   content?: HastNode }} HastNode
 * @typedef {{ removed: number, hadScripts: boolean, base: URL | null }} SanitizeState
 */

/**
 * Parses a page and returns its clean content tree (a hast root), its title and what was removed.
 * @param {string} html
 * @param {{ baseUrl?: string | null }} [opts]
 * @returns {{ tree: HastNode, title: string, removed: number, hadScripts: boolean }}
 */
export function sanitizeTree(html, { baseUrl = null } = {}) {
  const doc = /** @type {HastNode} */ (/** @type {unknown} */ (fromHtml(String(html ?? ''))));
  /** @type {SanitizeState} */
  const state = { removed: 0, hadScripts: false, base: parseBase(baseUrl) };
  const title = pageTitle(doc);
  // scripts anywhere (head included) mean the page is probably rendered by JavaScript
  walk(doc, (n) => {
    if (n.type === 'element' && n.tagName === 'script') state.hadScripts = true;
  });
  const body = findFirst(doc, (n) => n.type === 'element' && n.tagName === 'body') ?? doc;
  const content = mainContent(body) ?? body;
  const children = cleanChildren(content.children ?? [], state, []);
  return { tree: { type: 'root', children }, title, removed: state.removed, hadScripts: state.hadScripts };
}

/**
 * --as-html: the page as a sanitized HTML document (doctype, charset, title, the clean content).
 * @param {string} html
 * @param {{ baseUrl?: string | null }} [opts]
 * @returns {{ html: string, removed: number, textChars: number, title: string, hadScripts: boolean }}
 */
export function sanitizeHtml(html, opts = {}) {
  const { tree, title, removed, hadScripts } = sanitizeTree(html, opts);
  const body = unified().use(rehypeStringify).stringify(/** @type {any} */ (tree));
  const out = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n${body.trim()}\n</body>\n</html>\n`;
  return { html: out, removed, textChars: textLength(tree), title, hadScripts };
}

/**
 * The default conversion: the clean tree as Markdown without raw HTML.
 * @param {string} html
 * @param {{ baseUrl?: string | null }} [opts]
 * @returns {{ markdown: string, removed: number, textChars: number, title: string, hadScripts: boolean }}
 */
export function htmlToMarkdown(html, opts = {}) {
  const { tree, title, removed, hadScripts } = sanitizeTree(html, opts);
  const mdast = hastToMdast(tree);
  const markdown = stringifyMarkdown(mdast);
  return { markdown, removed, textChars: textLength(tree), title, hadScripts };
}

/**
 * @param {string | null} baseUrl
 * @returns {URL | null}
 */
function parseBase(baseUrl) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

/**
 * The page title: <title>, else the first <h1>, else ''.
 * @param {HastNode} doc
 * @returns {string}
 */
function pageTitle(doc) {
  const t = findFirst(doc, (n) => n.type === 'element' && n.tagName === 'title');
  const h1 = t ? null : findFirst(doc, (n) => n.type === 'element' && n.tagName === 'h1');
  const text = collapse(hastToString(/** @type {any} */ (t ?? h1 ?? { type: 'root', children: [] })));
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * The page's single <main> (or role=main), else its single <article>, else null.
 * @param {HastNode} body
 * @returns {HastNode | null}
 */
function mainContent(body) {
  /** @type {HastNode[]} */
  const mains = [];
  /** @type {HastNode[]} */
  const articles = [];
  walk(body, (n) => {
    if (n.type !== 'element') return;
    if (n.tagName === 'main' || String(n.properties?.role ?? '').toLowerCase() === 'main') mains.push(n);
    else if (n.tagName === 'article') articles.push(n);
  });
  const usable = (/** @type {HastNode} */ n) => collapse(hastToString(/** @type {any} */ (n))).length > 0;
  if (mains.length === 1 && usable(mains[0])) return mains[0];
  if (mains.length === 0 && articles.length === 1 && usable(articles[0])) return articles[0];
  return null;
}

/**
 * @param {HastNode[]} children
 * @param {SanitizeState} state
 * @param {string[]} ancestors tag names of the kept ancestors
 * @returns {HastNode[]}
 */
function cleanChildren(children, state, ancestors) {
  /** @type {HastNode[]} */
  const out = [];
  for (const child of children) out.push(...cleanNode(child, state, ancestors));
  return out;
}

/**
 * @param {HastNode} node
 * @param {SanitizeState} state
 * @param {string[]} ancestors
 * @returns {HastNode[]}
 */
function cleanNode(node, state, ancestors) {
  if (node.type === 'text') return [{ type: 'text', value: String(node.value ?? '') }];
  if (node.type === 'root') return cleanChildren(node.children ?? [], state, ancestors);
  if (node.type !== 'element') return []; // comments, doctype, raw
  const tag = String(node.tagName ?? '').toLowerCase();
  if (STRIP.has(tag)) {
    state.removed += 1;
    return [];
  }
  const unwrap = () => cleanChildren(node.children ?? [], state, ancestors);
  if (!TAGS.has(tag)) return unwrap();
  if (NEEDS_TABLE.has(tag) && !ancestors.includes('table')) return unwrap();
  const properties = cleanProperties(tag, node.properties ?? {}, state);
  if (properties === null) {
    state.removed += 1;
    return [];
  }
  if (tag === 'a' && properties.href === undefined && node.properties?.href !== undefined) {
    // a link whose target was refused keeps its text
    return unwrap();
  }
  if (tag === 'img' && properties.src === undefined) {
    // nothing to show: keep the alt text
    const alt = typeof node.properties?.alt === 'string' ? node.properties.alt : '';
    return alt ? [{ type: 'text', value: alt }] : [];
  }
  return [{ type: 'element', tagName: tag, properties, children: cleanChildren(node.children ?? [], state, [...ancestors, tag]) }];
}

/**
 * The allowed properties of an element (null: the element itself is refused, e.g. an input that is not a checkbox).
 * @param {string} tag
 * @param {Record<string, any>} props
 * @param {SanitizeState} state
 * @returns {Record<string, any> | null}
 */
function cleanProperties(tag, props, state) {
  /** @type {Record<string, any>} */
  const out = {};
  const rules = [...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] ?? [])];
  for (const rule of rules) {
    const name = Array.isArray(rule) ? rule[0] : rule;
    if (!Object.hasOwn(props, name)) continue;
    let value = props[name];
    if (value === null || value === undefined || value === false) continue;
    if (Array.isArray(rule)) {
      value = allowedValue(value, /** @type {Array<string | RegExp | boolean>} */ (rule.slice(1)));
      if (value === undefined) continue;
    }
    if (Object.hasOwn(PROTOCOLS, name)) {
      value = safeUrl(String(value), PROTOCOLS[name], state.base);
      if (value === undefined) continue;
    }
    if (CLOBBER.has(name)) value = clobber(String(value));
    else if (CLOBBER_LIST.has(name)) value = (Array.isArray(value) ? value : String(value).split(/\s+/)).filter(Boolean).map((v) => clobber(String(v)));
    out[name] = value;
  }
  if (tag === 'input') {
    // GitHub's `required`: only a disabled checkbox (task lists)
    if (String(props.type ?? '').toLowerCase() !== 'checkbox') return null;
    out.type = 'checkbox';
    out.disabled = true;
  }
  return out;
}

/**
 * @param {any} value
 * @param {Array<string | RegExp | boolean>} allowed
 * @returns {any}
 */
function allowedValue(value, allowed) {
  const ok = (/** @type {any} */ v) => allowed.some((a) => (a instanceof RegExp ? a.test(String(v)) : a === v || (typeof a === 'string' && String(v).toLowerCase() === a)));
  if (Array.isArray(value)) {
    const kept = value.filter(ok);
    return kept.length ? kept : undefined;
  }
  return ok(value) ? value : undefined;
}

/**
 * A URL attribute value made absolute against the page URL, or undefined when its scheme is not allowed.
 * Fragment-only links (#section) stay as they are.
 * @param {string} raw
 * @param {string[]} protocols
 * @param {URL | null} base
 * @returns {string | undefined}
 */
export function safeUrl(raw, protocols, base) {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith('#') && !/[\0-\x1f\x7f]/.test(value)) return value;
  let url;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
  return protocols.includes(url.protocol) ? url.href : undefined;
}

/** @param {string} v */
function clobber(v) {
  return v.startsWith(CLOBBER_PREFIX) ? v : `${CLOBBER_PREFIX}${v}`;
}

// ------------------------------------------------------------------------------------------------ hast -> mdast

/** Elements that start a block (anything else is phrasing content). */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'html', 'legend', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/**
 * @typedef {{ type: string, children?: MdNode[], value?: string, [k: string]: any }} MdNode
 */

/**
 * Converts a clean hast tree into an mdast root (block structure, GFM tables and task lists, phrasing).
 * @param {HastNode} tree
 * @returns {MdNode}
 */
export function hastToMdast(tree) {
  return { type: 'root', children: toBlocks(tree.children ?? []) };
}

/**
 * @param {HastNode} n
 * @returns {boolean}
 */
function isBlock(n) {
  return n.type === 'element' && BLOCK.has(String(n.tagName));
}

/**
 * Block content: runs of phrasing content become paragraphs.
 * @param {HastNode[]} nodes
 * @returns {MdNode[]}
 */
function toBlocks(nodes) {
  /** @type {MdNode[]} */
  const out = [];
  /** @type {HastNode[]} */
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const para = paragraph(toPhrasing(run));
    if (para) out.push(para);
    run = [];
  };
  for (const n of nodes) {
    if (isBlock(n)) {
      flush();
      out.push(...blockOf(n));
    } else {
      run.push(n);
    }
  }
  flush();
  return out;
}

/**
 * @param {MdNode[]} phrasing
 * @returns {MdNode | null} a paragraph, or null when it holds only whitespace
 */
function paragraph(phrasing) {
  const children = trimPhrasing(phrasing);
  return children.length ? { type: 'paragraph', children } : null;
}

/**
 * @param {HastNode} el
 * @returns {MdNode[]}
 */
function blockOf(el) {
  const tag = String(el.tagName);
  const kids = el.children ?? [];
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const children = trimPhrasing(toPhrasing(kids));
      return children.length ? [{ type: 'heading', depth: Number(tag[1]), children }] : [];
    }
    case 'p':
      return toBlocks(kids);
    case 'blockquote': {
      const children = toBlocks(kids);
      return children.length ? [{ type: 'blockquote', children }] : [];
    }
    case 'ul': case 'ol': case 'menu': case 'dir':
      return listOf(el);
    case 'li':
      return toBlocks(kids);
    case 'pre':
      return [codeOf(el)];
    case 'hr':
      return [{ type: 'thematicBreak' }];
    case 'table':
      return tableOf(el);
    case 'dt': {
      const children = trimPhrasing(toPhrasing(kids));
      return children.length ? [{ type: 'paragraph', children: [{ type: 'strong', children }] }] : [];
    }
    case 'summary': case 'caption': case 'figcaption': case 'legend': {
      const children = trimPhrasing(toPhrasing(kids));
      if (!children.length) return [];
      return [{ type: 'paragraph', children: [tag === 'summary' ? { type: 'strong', children } : { type: 'emphasis', children }] }];
    }
    default:
      return toBlocks(kids);
  }
}

/**
 * @param {HastNode} el ul / ol
 * @returns {MdNode[]}
 */
function listOf(el) {
  const ordered = el.tagName === 'ol';
  /** @type {MdNode[]} */
  const items = [];
  /** @type {HastNode[]} */
  let loose = [];
  const flushLoose = () => {
    if (loose.some((n) => n.type !== 'text' || /\S/.test(String(n.value ?? '')))) items.push(listItem(loose));
    loose = [];
  };
  for (const n of el.children ?? []) {
    if (n.type === 'element' && n.tagName === 'li') {
      flushLoose();
      items.push(listItem(n.children ?? []));
    } else {
      loose.push(n);
    }
  }
  flushLoose();
  const kept = items.filter((i) => i.children?.length);
  if (!kept.length) return [];
  const start = Number(el.properties?.start);
  /** @type {MdNode} */
  const list = { type: 'list', ordered, spread: false, children: kept };
  if (ordered) list.start = Number.isSafeInteger(start) && start >= 0 ? start : 1;
  return [list];
}

/**
 * @param {HastNode[]} kids
 * @returns {MdNode}
 */
function listItem(kids) {
  // a leading checkbox makes a task-list item
  let checked = null;
  const first = firstMeaningful(kids);
  const box = first && first.type === 'element' && first.tagName === 'input' ? first : first?.type === 'element' && first.tagName === 'p' ? firstMeaningful(first.children ?? []) : null;
  if (box && box.type === 'element' && box.tagName === 'input' && String(box.properties?.type) === 'checkbox') checked = Boolean(box.properties?.checked);
  const children = toBlocks(kids);
  return { type: 'listItem', spread: false, checked, children };
}

/**
 * @param {HastNode[]} nodes
 * @returns {HastNode | undefined}
 */
function firstMeaningful(nodes) {
  return nodes.find((n) => n.type !== 'text' || /\S/.test(String(n.value ?? '')));
}

/**
 * @param {HastNode} pre
 * @returns {MdNode}
 */
function codeOf(pre) {
  const code = (pre.children ?? []).find((n) => n.type === 'element' && n.tagName === 'code');
  const classes = /** @type {unknown[]} */ (code?.properties?.className ?? []);
  const lang = classes.map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
  const value = hastToString(/** @type {any} */ (pre)).replace(/^\n/, '').replace(/\s+$/, '');
  return { type: 'code', lang: lang && /^[\w+#.-]{1,40}$/.test(lang) ? lang : null, meta: null, value };
}

/**
 * A GFM table: the first row is the header (a table without one gets an empty header row); cells hold phrasing only.
 * @param {HastNode} table
 * @returns {MdNode[]}
 */
function tableOf(table) {
  /** @type {HastNode[]} */
  const rows = [];
  /** @type {MdNode[]} */
  const extra = [];
  const collect = (/** @type {HastNode} */ n) => {
    for (const c of n.children ?? []) {
      if (c.type !== 'element') continue;
      if (c.tagName === 'tr') rows.push(c);
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') collect(c);
      else if (c.tagName === 'caption') extra.push(...blockOf(c));
    }
  };
  collect(table);
  const cellsOf = (/** @type {HastNode} */ tr) => (tr.children ?? []).filter((c) => c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th'));
  const width = Math.max(0, ...rows.map((r) => cellsOf(r).length));
  if (!rows.length || !width) return extra;
  const hasHeader = cellsOf(rows[0]).every((c) => c.tagName === 'th');
  /** @type {MdNode[]} */
  const mdRows = rows.map((r) => {
    const cells = cellsOf(r).map((c) => ({ type: 'tableCell', children: trimPhrasing(toPhrasing(c.children ?? [], true)) }));
    while (cells.length < width) cells.push({ type: 'tableCell', children: [] });
    return { type: 'tableRow', children: cells };
  });
  if (!hasHeader) mdRows.unshift({ type: 'tableRow', children: Array.from({ length: width }, () => ({ type: 'tableCell', children: [] })) });
  return [...extra, { type: 'table', align: Array.from({ length: width }, () => null), children: mdRows }];
}

/**
 * Phrasing content. Block elements met here (a <div> inside a <span>, a list in a table cell) contribute their
 * phrasing, separated by spaces (in a table cell, by breaks).
 * @param {HastNode[]} nodes
 * @param {boolean} [inCell]
 * @returns {MdNode[]}
 */
function toPhrasing(nodes, inCell = false) {
  /** @type {MdNode[]} */
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push({ type: 'text', value: String(n.value ?? '').replace(/[ \t\n\r\f]+/g, ' ') });
      continue;
    }
    if (n.type !== 'element') continue;
    const tag = String(n.tagName);
    const kids = n.children ?? [];
    switch (tag) {
      case 'strong': case 'b':
        pushWrapped(out, 'strong', toPhrasing(kids, inCell));
        break;
      case 'em': case 'i': case 'cite': case 'dfn':
        pushWrapped(out, 'emphasis', toPhrasing(kids, inCell));
        break;
      case 'del': case 's': case 'strike':
        pushWrapped(out, 'delete', toPhrasing(kids, inCell));
        break;
      case 'code': case 'kbd': case 'samp': case 'tt': case 'var': {
        const value = hastToString(/** @type {any} */ (n)).replace(/\s+/g, ' ');
        if (value.trim()) out.push({ type: 'inlineCode', value });
        break;
      }
      case 'a': {
        const children = toPhrasing(kids, inCell);
        const href = typeof n.properties?.href === 'string' ? n.properties.href : '';
        if (!href) out.push(...children);
        else if (children.some((c) => c.type !== 'text' || /\S/.test(String(c.value)))) {
          out.push({ type: 'link', url: href, title: typeof n.properties?.title === 'string' ? n.properties.title : null, children: trimPhrasing(children) });
        }
        break;
      }
      case 'img': {
        const src = typeof n.properties?.src === 'string' ? n.properties.src : '';
        const alt = typeof n.properties?.alt === 'string' ? collapse(n.properties.alt) : '';
        if (src) out.push({ type: 'image', url: src, alt, title: typeof n.properties?.title === 'string' ? n.properties.title : null });
        else if (alt) out.push({ type: 'text', value: alt });
        break;
      }
      case 'br':
        out.push({ type: 'break' });
        break;
      case 'input':
        break; // task-list checkbox: listItem.checked
      case 'q':
        out.push({ type: 'text', value: '“' }, ...toPhrasing(kids, inCell), { type: 'text', value: '”' });
        break;
      case 'pre': {
        const value = hastToString(/** @type {any} */ (n)).replace(/\s+/g, ' ').trim();
        if (value) out.push({ type: 'inlineCode', value });
        break;
      }
      default:
        if (BLOCK.has(tag)) {
          const inner = toPhrasing(kids, inCell);
          if (inner.length) out.push(inCell && out.length ? { type: 'break' } : { type: 'text', value: ' ' }, ...inner, { type: 'text', value: ' ' });
        } else {
          out.push(...toPhrasing(kids, inCell));
        }
    }
  }
  return out;
}

/**
 * Wraps phrasing in strong / emphasis / delete, keeping the outer spaces outside the markers.
 * @param {MdNode[]} out
 * @param {string} type
 * @param {MdNode[]} children
 */
function pushWrapped(out, type, children) {
  const trimmed = trimPhrasing(children);
  if (!trimmed.length) {
    if (children.length) out.push({ type: 'text', value: ' ' });
    return;
  }
  const lead = children[0]?.type === 'text' && /^\s/.test(String(children[0].value));
  const last = children[children.length - 1];
  const trail = last?.type === 'text' && /\s$/.test(String(last.value));
  if (lead) out.push({ type: 'text', value: ' ' });
  out.push({ type, children: trimmed });
  if (trail) out.push({ type: 'text', value: ' ' });
}

/**
 * Merges adjacent text, collapses spaces across node boundaries, and trims the ends (and spaces around breaks).
 * @param {MdNode[]} nodes
 * @returns {MdNode[]}
 */
function trimPhrasing(nodes) {
  /** @type {MdNode[]} */
  const merged = [];
  for (const n of nodes) {
    const prev = merged[merged.length - 1];
    if (n.type === 'text' && prev?.type === 'text') prev.value = `${prev.value}${n.value}`.replace(/ {2,}/g, ' ');
    else merged.push(n.type === 'text' ? { ...n, value: String(n.value).replace(/ {2,}/g, ' ') } : n);
  }
  for (let i = 0; i < merged.length; i++) {
    const n = merged[i];
    if (n.type !== 'text') continue;
    const before = merged[i - 1];
    const after = merged[i + 1];
    if (!before || before.type === 'break') n.value = String(n.value).replace(/^ +/, '');
    if (!after || after.type === 'break') n.value = String(n.value).replace(/ +$/, '');
  }
  const kept = merged.filter((n) => n.type !== 'text' || n.value);
  while (kept.length && kept[0].type === 'break') kept.shift();
  while (kept.length && kept[kept.length - 1].type === 'break') kept.pop();
  return kept;
}

// ------------------------------------------------------------------------------------------------ markdown

/** remark-stringify options: '-' bullets, '***' rules (never '---', which could open front matter on line 1). */
const STRINGIFY = { bullet: '-', rule: '*', emphasis: '_', strong: '*', fences: true, fence: '`', listItemIndent: 'one', incrementListMarker: true };

function markdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkMath)
    .use(remarkStringify, /** @type {any} */ (STRINGIFY));
}

/**
 * Serialises mdast as Markdown with the renderer's extensions (escaping included).
 * @param {MdNode} mdast
 * @returns {string}
 */
function stringifyMarkdown(mdast) {
  const text = String(markdownProcessor().stringify(/** @type {any} */ (mdast)));
  return text.trim() ? `${text.replace(/\s+$/, '')}\n` : '';
}

/**
 * Fetched Markdown without raw HTML (see the header). A text without HTML nodes and without links of other schemes
 * is returned unchanged.
 * @param {string} md
 * @param {{ baseUrl?: string | null }} [opts] links are resolved against it only when the text is re-serialised
 * @returns {{ markdown: string, removed: number }}
 */
export function stripRawHtmlFromMarkdown(md, { baseUrl = null } = {}) {
  const text = String(md ?? '');
  const proc = markdownProcessor();
  const tree = /** @type {any} */ (proc.parse(text));
  let dirty = false;
  visit(tree, (/** @type {any} */ n) => {
    if (n.type === 'html') dirty = true;
    else if ((n.type === 'link' || n.type === 'image' || n.type === 'definition') && unsafeMdUrl(n.url, n.type === 'image')) dirty = true;
  });
  if (!dirty) return { markdown: text, removed: 0 };

  const base = parseBase(baseUrl);
  let removed = 0;
  /** @param {any} parent */
  const clean = (parent) => {
    /** @type {any[]} */
    const next = [];
    for (const n of parent.children ?? []) {
      if (n.type === 'html') {
        removed += 1;
        // an HTML block at the top level (a README's centred title, a <details> section) keeps its text
        if (parent.type === 'root') next.push(...hastToMdast(sanitizeFragment(String(n.value ?? ''), base)).children ?? []);
        continue;
      }
      if (n.type === 'link' || n.type === 'image' || n.type === 'definition') {
        const safe = safeUrl(String(n.url ?? ''), n.type === 'image' ? PROTOCOLS.src : PROTOCOLS.href, base) ?? (isRelative(n.url) ? n.url : undefined);
        if (safe === undefined) {
          removed += 1;
          if (n.type === 'link') {
            clean(n);
            next.push(...(n.children ?? []));
          } else if (n.type === 'image') {
            if (n.alt) next.push({ type: 'text', value: n.alt });
          }
          continue;
        }
        n.url = safe;
      }
      if (n.children) clean(n);
      next.push(n);
    }
    parent.children = next;
  };
  clean(tree);
  // a removed tag leaves its neighbours' spaces at the ends of a line
  visit(tree, (/** @type {any} */ n) => {
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'tableCell') n.children = trimPhrasing(n.children ?? []);
  });
  let out = stringifyMarkdown(tree);
  // defence in depth: the serialiser escapes '<', so this never loops; drop anything that still parses as HTML
  for (let i = 0; i < 3 && hasHtmlNode(out); i++) out = stringifyMarkdown(dropHtml(proc.parse(out)));
  return { markdown: out, removed };
}

/**
 * A fragment of HTML (from a Markdown HTML block) cleaned like a page (no main/article selection).
 * @param {string} html
 * @param {URL | null} base
 * @returns {HastNode}
 */
function sanitizeFragment(html, base) {
  const frag = /** @type {HastNode} */ (/** @type {unknown} */ (fromHtml(html, { fragment: true })));
  /** @type {SanitizeState} */
  const state = { removed: 0, hadScripts: false, base };
  return { type: 'root', children: cleanChildren(frag.children ?? [], state, []) };
}

/**
 * Whether a Markdown link target has a scheme other than the allowed ones (a relative target is fine).
 * @param {unknown} url
 * @param {boolean} image
 * @returns {boolean}
 */
function unsafeMdUrl(url, image) {
  const v = String(url ?? '').trim();
  if (!v || isRelative(v)) return false;
  return safeUrl(v, image ? PROTOCOLS.src : PROTOCOLS.href, null) === undefined;
}

/**
 * hast-util-sanitize's rule: no ':' before the first '/', '?' or '#' means a relative URL. Control characters
 * (which URL parsers strip) never count as relative.
 * @param {unknown} url
 * @returns {boolean}
 */
function isRelative(url) {
  const v = String(url ?? '');
  if (/[\0-\x20\x7f]/.test(v.trim())) return false;
  const colon = v.indexOf(':');
  if (colon < 0) return true;
  const cut = ['/', '?', '#'].map((c) => v.indexOf(c)).filter((i) => i >= 0);
  return cut.length > 0 && Math.min(...cut) < colon;
}

/**
 * @param {string} md
 * @returns {boolean}
 */
export function hasHtmlNode(md) {
  let found = false;
  visit(/** @type {any} */ (markdownProcessor().parse(md)), 'html', () => {
    found = true;
  });
  return found;
}

/**
 * @param {any} tree
 * @returns {any}
 */
function dropHtml(tree) {
  visit(tree, (/** @type {any} */ n) => {
    if (Array.isArray(n.children)) n.children = n.children.filter((/** @type {any} */ c) => c.type !== 'html');
  });
  return tree;
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * Depth-first walk over a hast tree (template contents included).
 * @param {HastNode} node
 * @param {(n: HastNode) => void} fn
 */
function walk(node, fn) {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
  if (node.content) walk(node.content, fn);
}

/**
 * @param {HastNode} node
 * @param {(n: HastNode) => boolean} pred
 * @returns {HastNode | null}
 */
function findFirst(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return null;
}

/** @param {string} s */
function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {HastNode} tree */
function textLength(tree) {
  return collapse(hastToString(/** @type {any} */ (tree))).length;
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
