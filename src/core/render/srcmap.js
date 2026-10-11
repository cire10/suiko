// @ts-check
// Shared builders for the render result's source map, rendered-text stream and outline (BUILD_AMENDMENTS 3.1).
// Used by both pipelines: the Markdown stamp plugin (hast) and the HTML byte-splice renderer (parse5 tree).
//
// SrcMap: srids are assigned 1..N in document (pre-order) order (skipping numbers a document already uses in its
// own data-srid attributes); s/e are UTF-16 offsets into the decoded source,
// ls/le 1-based lines computed from s and e (le = line of the last character, e - 1).
// Text stream: concatenation of every text node outside TEXT_EXCLUDE, raw (not normalised), and per srid the
// contiguous [t0, t1) range covered by its descendants.

import { createHash } from 'node:crypto';
import { BLOCK_TAGS, TEXT_EXCLUDE } from '../../shared/protocol.js';
import { lineIndex } from '../text/lines.js';

/**
 * @typedef {Object} SrcNode
 * @property {string} t        tag name
 * @property {number} s        start offset (inclusive)
 * @property {number} e        end offset (exclusive)
 * @property {number} ls       start line (1-based)
 * @property {number} le       end line (1-based, line of the last character)
 * @property {number} p        parent srid (0 = none)
 * @property {boolean} b       block element (BLOCK_TAGS)
 * @property {string} [k]      kind: code|math|mermaid|frontmatter|table|tr|cell|img|svg|media|embed|heading
 * @property {{ level: number, text: string }} [h]
 * @property {{ id?: string, src?: string, alt?: string, href?: string, class?: string, poster?: string, data?: string }} [a]
 * @property {{ contentStart: number, contentEnd: number, firstLine: number }} [c]
 */

/**
 * @typedef {Object} SrcMap
 * @property {number[]} order
 * @property {Record<string, SrcNode>} nodes
 */

/** @typedef {{ srid: number, level: number, text: string, line: number, id: string }} OutlineItem */

const BLOCK = new Set(BLOCK_TAGS);
const SPECIAL_KINDS = new Set(['code', 'math', 'mermaid', 'frontmatter']);
/** @type {Record<string, string>} */
const KIND_BY_TAG = {
  table: 'table', tr: 'tr', td: 'cell', th: 'cell', img: 'img', picture: 'img', svg: 'svg', video: 'media',
  audio: 'media', iframe: 'embed', embed: 'embed', object: 'embed',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
};
const ATTR_KEYS = /** @type {const} */ (['id', 'src', 'alt', 'href', 'class', 'poster', 'data']);
const MAX_ATTR = 512;

/** @param {string} tag */
export function isBlockTag(tag) {
  return BLOCK.has(tag);
}

/** @param {string} tag */
export function headingLevel(tag) {
  return /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0;
}

/**
 * Element kind from its tag and our data-sr-kind marker.
 * @param {string} tag
 * @param {string|undefined|null} srKind
 */
export function kindOf(tag, srKind) {
  if (srKind && SPECIAL_KINDS.has(srKind)) return srKind;
  return KIND_BY_TAG[tag];
}

/**
 * Whether an element's text is excluded from the rendered-text stream (TEXT_EXCLUDE, shared with the guest).
 * @param {string} tag
 * @param {string[]} classes
 * @param {(name: string) => boolean} hasAttr
 * @param {string|undefined|null} srKind
 */
export function isTextExcluded(tag, classes, hasAttr, srKind) {
  if (TEXT_EXCLUDE.tags.includes(tag)) return true;
  if (classes.some((c) => TEXT_EXCLUDE.classes.includes(c))) return true;
  if (TEXT_EXCLUDE.attrs.some((a) => hasAttr(a))) return true;
  if (srKind && TEXT_EXCLUDE.kinds.includes(srKind)) return true;
  return false;
}

/**
 * Keep an attribute value small: long values (data: URIs) are truncated with a length + hash fingerprint so
 * they remain comparable across versions.
 * @param {string} v
 */
export function compactAttr(v) {
  if (v.length <= MAX_ATTR) return v;
  const sha8 = createHash('sha256').update(v).digest('hex').slice(0, 8);
  return `${v.slice(0, 256)}…[${v.length} chars sha256:${sha8}]`;
}

/**
 * Pick the SrcNode `a` attributes.
 * @param {(name: string) => string|undefined|null} get
 * @returns {SrcNode['a'] | undefined}
 */
export function pickAttrs(get) {
  /** @type {Record<string, string>} */
  const a = {};
  let any = false;
  for (const key of ATTR_KEYS) {
    const v = get(key);
    if (v == null || v === '') continue;
    a[key] = compactAttr(String(v));
    any = true;
  }
  return any ? a : undefined;
}

/** Builds the SrcMap, the text stream with spans, and the outline. */
export class SrcMapBuilder {
  /**
   * @param {string} source
   * @param {{ reserved?: Set<number> }} [opts] srids already present in the document (never assigned)
   */
  constructor(source, opts = {}) {
    this.source = source;
    this.reserved = opts.reserved ?? new Set();
    this.nextSrid = 1;
    this.lines = lineIndex(source);
    /** @type {number[]} */
    this.order = [];
    /** @type {Record<string, SrcNode>} */
    this.nodes = {};
    /** @type {string[]} */
    this.chunks = [];
    this.textLength = 0;
    /** @type {Record<string, [number, number]>} */
    this.spans = {};
    /** @type {Map<number, number>} */
    this.open = new Map();
  }

  /**
   * Register an element; returns its srid.
   * @param {{ tag: string, s: number, e: number, parent: number, kind?: string, attrs?: SrcNode['a'],
   *           content?: SrcNode['c'] }} el
   */
  add(el) {
    while (this.reserved.has(this.nextSrid)) this.nextSrid++;
    const srid = this.nextSrid++;
    const s = Math.max(0, Math.min(el.s, this.source.length));
    const e = Math.max(s, Math.min(el.e, this.source.length));
    /** @type {SrcNode} */
    const node = {
      t: el.tag, s, e, ls: this.lines.lineOf(s), le: this.lines.lineOf(e > s ? e - 1 : s), p: el.parent,
      b: BLOCK.has(el.tag),
    };
    if (el.kind) node.k = el.kind;
    const level = headingLevel(el.tag);
    if (level) node.h = { level, text: '' };
    if (el.attrs) node.a = el.attrs;
    if (el.content) node.c = el.content;
    this.order.push(srid);
    this.nodes[srid] = node;
    return srid;
  }

  /** @param {string} value */
  pushText(value) {
    if (!value) return;
    this.chunks.push(value);
    this.textLength += value.length;
  }

  /** @param {number} srid */
  openSpan(srid) {
    this.open.set(srid, this.textLength);
  }

  /** @param {number} srid */
  closeSpan(srid) {
    const t0 = this.open.get(srid) ?? this.textLength;
    this.open.delete(srid);
    this.spans[srid] = [t0, this.textLength];
  }

  /**
   * Finish: fills heading texts and returns { srcmap, text, outline }.
   */
  finish() {
    const text = this.chunks.join('');
    /** @type {OutlineItem[]} */
    const outline = [];
    for (const srid of this.order) {
      const node = this.nodes[srid];
      if (!node.h) continue;
      const span = this.spans[srid] || [0, 0];
      node.h.text = text.slice(span[0], span[1]).replace(/\s+/g, ' ').trim();
      outline.push({ srid, level: node.h.level, text: node.h.text, line: node.ls, id: node.a?.id ?? '' });
    }
    return {
      srcmap: /** @type {SrcMap} */ ({ order: this.order, nodes: this.nodes }),
      text: { text, spans: this.spans },
      outline,
    };
  }
}

/**
 * Verbatim content mapping for a fenced block (code, mermaid, display math, front matter) whose node covers
 * source[s, e): content starts on the line after the opening fence and ends at the end of the line before the
 * closing fence (exclusive of its line terminator). Unfenced (indented) blocks map their whole range.
 * @param {string} source
 * @param {import('../text/lines.js').LineIndex} li
 * @param {number} s
 * @param {number} e
 * @returns {{ contentStart: number, contentEnd: number, firstLine: number }}
 */
export function fenceContent(source, li, s, e) {
  const ls = li.lineOf(s);
  const le = li.lineOf(e > s ? e - 1 : s);
  const firstLineText = source.slice(s, li.endOf(ls));
  if (!/^(?:`{3,}|~{3,}|-{3,}|\+{3,}|\${2})/.test(firstLineText)) {
    return { contentStart: s, contentEnd: e, firstLine: ls };
  }
  if (le === ls) return { contentStart: e, contentEnd: e, firstLine: ls + 1 };
  const contentStart = li.startOf(ls + 1);
  const lastLineText = source.slice(li.startOf(le), e);
  const closed = /^[ \t>]*(?:`{3,}|~{3,}|-{3,}|\+{3,}|\${2,})[ \t]*$/.test(lastLineText);
  let contentEnd = e;
  if (closed) contentEnd = le - 1 > ls ? li.endOf(le - 1) : contentStart;
  return { contentStart, contentEnd: Math.max(contentStart, contentEnd), firstLine: ls + 1 };
}

/**
 * Pick a document title: explicit title, else the first h1, else the first heading, else the file name.
 * @param {string|null|undefined} explicit
 * @param {OutlineItem[]} outline
 * @param {string|undefined} docPath
 */
export function pickTitle(explicit, outline, docPath) {
  const clean = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
  if (explicit && clean(explicit)) return clean(explicit);
  const h1 = outline.find((o) => o.level === 1 && o.text);
  if (h1) return h1.text;
  const any = outline.find((o) => o.text);
  if (any) return any.text;
  if (docPath) {
    const base = docPath.split('/').pop() || docPath;
    return base.replace(/\.[^.]+$/, '') || base;
  }
  return 'Untitled';
}
