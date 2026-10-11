// @ts-check
// Source -> approximate rendered text, with a character map back to the source.
//
// toPlain(format, src) strips Markdown/HTML markup and decodes character references, producing the text a
// reader would see (the same text the guest's TEXT_EXCLUDE DOM walk sees, modulo whitespace). Every output
// character carries the source range [map[i], mapEnd[i]) it came from, so callers can map a match in the plain
// text back to an exact source slice (used by findQuote's markup-tolerant mode and sourceToPlainText).
//
// It is a heuristic scanner, not a parser: it is designed to work on arbitrary slices (a changed word, a few
// lines) as well as whole documents. Markdown handling:
//   block level (per line): blockquote '>' markers, list markers, task boxes, ATX heading markers, setext and
//     thematic-break lines, fence lines, '$$' lines, table delimiter rows, link reference definitions, table pipes;
//     fenced code content is literal; mermaid fences are dropped (their text is excluded from rendered text).
//   inline: backslash escapes, entities (';' required), code spans, inline math, emphasis/strikethrough
//     delimiters (paired, or unpaired doubles / at slice edges), links, images (dropped), footnote refs,
//     autolinks, raw HTML tags and comments, raw-text elements and TEXT_EXCLUDE'd elements.
//   inline math is projected to approximately the text KaTeX renders: \text{..}-style wrappers keep their
//     argument, symbol commands become their glyph (\le -> '≤', \lambda -> 'λ'), other commands, braces, '^',
//     '_' and spacing are dropped, '-' / '*' become '−' / '∗' ("$\text{count}(t) < L$" -> "count(t) < L").
//   footnote refs render as their number when `opts.footnotes` (footnoteOrder of the whole document) is given,
//     else as their label; GFM table rows drop the backslash of '\|' (also inside code spans).
// HTML handling: tags, comments, doctype/PIs dropped; contents of script/style/template/textarea/title/noscript
//   and of excluded elements (data-sr-ignore, .katex-mathml, .mermaid) dropped; entities decoded.

import { TEXT_EXCLUDE } from '../../shared/protocol.js';
import { matchEntityAt } from './entities.js';
import { isWsCode } from './normalize.js';

/**
 * @typedef {Object} PlainText
 * @property {string} text
 * @property {number[]} map     raw start index of each text char
 * @property {number[]} mapEnd  raw end index (exclusive) of the construct that produced each text char
 */

/** Elements whose content never contributes rendered text (raw text / inert), from TEXT_EXCLUDE + friends. */
const SKIP_CONTENT_TAGS = new Set([...TEXT_EXCLUDE.tags, 'iframe', 'noembed', 'noframes']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr']);
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const PUNCT = /[\p{P}\p{S}]/u;

class Out {
  constructor() {
    /** @type {string[]} */ this.chars = [];
    /** @type {number[]} */ this.map = [];
    /** @type {number[]} */ this.mapEnd = [];
  }
  /** @param {string} ch @param {number} s @param {number} e */
  emit(ch, s, e) {
    this.chars.push(ch);
    this.map.push(s);
    this.mapEnd.push(e);
  }
  /** @param {string} str @param {number} s @param {number} e */
  emitAll(str, s, e) {
    for (const ch of str) for (let k = 0; k < ch.length; k++) this.emit(ch[k], s, e);
  }
  /** @returns {PlainText} */
  done() {
    return { text: this.chars.join(''), map: this.map, mapEnd: this.mapEnd };
  }
}

/**
 * Strip markup from `src`.
 * @param {'markdown'|'html'|'text'|string} format
 * @param {string} src
 * @param {{ lineStart?: boolean, footnotes?: Map<string, number> | null }} [opts]  lineStart=false: the slice
 *   starts mid-line, so its first line gets no block-level (list/heading/quote marker) processing. footnotes:
 *   footnote label (lower case) -> rendered number (footnoteOrder of the whole document).
 * @returns {PlainText}
 */
export function toPlain(format, src, opts = {}) {
  const out = new Out();
  if (format === 'html') scanHtml(src, 0, src.length, out);
  else if (format === 'markdown') scanMarkdown(src, out, opts.lineStart !== false, opts.footnotes ?? null);
  else for (let i = 0; i < src.length; i++) out.emit(src[i], i, i + 1);
  return out.done();
}

/**
 * Rendered numbers of a Markdown document's footnotes: label (lower case) -> 1, 2, ... in order of first reference
 * in the body, then of references made inside footnote definitions (rendered after the body), as remark-rehype
 * numbers them. Only labels that have a definition count (an undefined reference renders literally).
 * @param {string} src whole document
 * @returns {Map<string, number>}
 */
export function footnoteOrder(src) {
  /** @type {Set<string>} */
  const defined = new Set();
  /** @type {string[]} */
  const bodyRefs = [];
  /** @type {string[]} */
  const defRefs = [];
  /** @type {string | null} */
  let fence = null;
  for (const rawLine of String(src ?? '').split('\n')) {
    const line = rawLine.replace(/^(?:[ \t]{0,3}>[ \t]?)*/, '');
    const fm = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1];
      continue;
    }
    const body = line.replace(/(`+)[^`]*?\1/g, '');
    const def = /^ {0,3}\[\^([^\]\s]+)\]:/.exec(body);
    if (def) defined.add(def[1].toLowerCase());
    const refs = def ? defRefs : bodyRefs;
    for (const m of (def ? body.slice(def[0].length) : body).matchAll(/\[\^([^\]\s]+)\]/g)) refs.push(m[1].toLowerCase());
  }
  /** @type {Map<string, number>} */
  const order = new Map();
  for (const label of [...bodyRefs, ...defRefs]) if (defined.has(label) && !order.has(label)) order.set(label, order.size + 1);
  return order;
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

/**
 * @param {string} src
 * @param {number} from
 * @param {number} to
 * @param {Out} out
 */
function scanHtml(src, from, to, out) {
  let i = from;
  while (i < to) {
    const c = src.charCodeAt(i);
    if (c === 60 /* < */) {
      const j = skipHtmlMarkup(src, i, to);
      if (j > i) {
        i = j;
        continue;
      }
    } else if (c === 38 /* & */) {
      const m = matchEntityAt(src, i);
      if (m && m.end <= to) {
        out.emitAll(m.text, i, m.end);
        i = m.end;
        continue;
      }
    } else if (c === 13 && src.charCodeAt(i + 1) === 10) {
      i++; // CRLF -> the '\n' is emitted next
      continue;
    }
    out.emit(src[i], i, i + 1);
    i++;
  }
}

/**
 * If `src[i]` ('<') starts a tag, comment, doctype or processing instruction, return the index just past the
 * construct (and past the content of raw-text / excluded elements). Otherwise return -1 (a literal '<').
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @returns {number}
 */
export function skipHtmlMarkup(src, i, to) {
  const n1 = src.charCodeAt(i + 1);
  if (src.startsWith('<!--', i)) {
    const k = src.indexOf('-->', i + 4);
    return k < 0 || k + 3 > to ? to : k + 3;
  }
  if (n1 === 33 /* ! */ || n1 === 63 /* ? */) {
    const k = src.indexOf('>', i + 2);
    return k < 0 || k >= to ? to : k + 1;
  }
  const isEnd = n1 === 47; /* / */
  const nameStart = isEnd ? i + 2 : i + 1;
  if (!isAsciiAlpha(src.charCodeAt(nameStart))) return -1;
  let k = nameStart;
  while (k < to && !isTagNameEnd(src.charCodeAt(k))) k++;
  const name = src.slice(nameStart, k).toLowerCase();
  const tagEnd = findTagEnd(src, k, to);
  if (tagEnd < 0) return -1;
  if (isEnd) return tagEnd;
  const tagText = src.slice(i, tagEnd);
  const selfClosing = /\/\s*>$/.test(tagText);
  if (SKIP_CONTENT_TAGS.has(name)) return skipToClose(src, tagEnd, to, name, false);
  if (!VOID_TAGS.has(name) && !selfClosing && isExcludedTag(tagText)) return skipToClose(src, tagEnd, to, name, true);
  return tagEnd;
}

/** @param {number} c */
function isAsciiAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** @param {number} c */
function isTagNameEnd(c) {
  return c === 62 || c === 47 || isWsCode(c);
}

/**
 * Index just past the '>' closing a start/end tag whose name ends at `k`, honouring quoted attribute values.
 * @param {string} src @param {number} k @param {number} to
 */
function findTagEnd(src, k, to) {
  let quote = 0;
  for (let j = k; j < to; j++) {
    const c = src.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      // only an attribute value quote when preceded by '=' (possibly with spaces)
      let p = j - 1;
      while (p > k && isWsCode(src.charCodeAt(p))) p--;
      if (src.charCodeAt(p) === 61 /* = */) quote = c;
    } else if (c === 62) return j + 1;
    else if (c === 60 && j > k) return -1; // a new tag starts: this '<' was not a tag
  }
  return -1;
}

/**
 * Skip to just past the matching `</name>` (case-insensitive); `nested` counts nested same-name elements.
 * @param {string} src @param {number} from @param {number} to @param {string} name @param {boolean} nested
 */
function skipToClose(src, from, to, name, nested) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(src); m && m.index < to; m = re.exec(src)) {
    if (m[1]) depth--;
    else if (nested) depth++;
    if (depth === 0) {
      const end = src.indexOf('>', m.index);
      return end < 0 || end >= to ? to : end + 1;
    }
  }
  return to;
}

/**
 * Whether a start tag's attributes put the element under TEXT_EXCLUDE (data-sr-ignore, excluded classes,
 * data-sr-kind) or mark it as a mermaid diagram (class "mermaid": its text is diagram source).
 * @param {string} tagText
 */
function isExcludedTag(tagText) {
  for (const a of TEXT_EXCLUDE.attrs) if (new RegExp(`\\s${a}(?=[\\s=/>])`, 'i').test(tagText)) return true;
  const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagText);
  if (cls) {
    const list = (cls[1] ?? cls[2] ?? cls[3] ?? '').split(/\s+/);
    if (list.some((c) => TEXT_EXCLUDE.classes.includes(c) || c === 'mermaid')) return true;
  }
  const kind = /\sdata-sr-kind\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagText);
  if (kind && TEXT_EXCLUDE.kinds.includes(kind[1] ?? kind[2] ?? kind[3] ?? '')) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown: stage 1 (block level) builds a content string with per-char source ranges and flags; stage 2
// (inline) strips inline markup from the content.

const F_INLINE = 0; // ordinary content: inline markup is interpreted
const F_LITERAL = 1; // code/math block content: copied verbatim
const F_BREAK = 2; // structural char (table cell separator, dropped-line newline): copied, ends inline runs
const F_NL = 3; // a content line's newline: whitespace inside an inline run

const FENCE_OPEN_RE = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const THEMATIC_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/;
const DELIM_ROW_RE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LIST_MARKER_RE = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const TASK_RE = /^\[[ xX]\](?:[ \t]+|$)/;
const ATX_RE = /^#{1,6}(?=[ \t]|$)[ \t]*/;
const FOOTDEF_RE = /^\[\^[^\]\s]+\]:[ \t]*/;
const LINKDEF_RE = /^\[[^\]^][^\]]*\]:[ \t]*\S/;

class Content {
  constructor() {
    /** @type {string[]} */ this.chars = [];
    /** @type {number[]} */ this.map = [];
    /** @type {number[]} */ this.mapEnd = [];
    /** @type {number[]} */ this.flags = [];
  }
  /** @param {string} src @param {number} s @param {number} e @param {number} flag */
  copy(src, s, e, flag) {
    for (let i = s; i < e; i++) {
      if (src.charCodeAt(i) === 13 && src.charCodeAt(i + 1) === 10) continue;
      this.chars.push(src[i]);
      this.map.push(i);
      this.mapEnd.push(i + 1);
      this.flags.push(flag);
    }
  }
  /** @param {string} ch @param {number} s @param {number} e @param {number} flag */
  push(ch, s, e, flag) {
    this.chars.push(ch);
    this.map.push(s);
    this.mapEnd.push(e);
    this.flags.push(flag);
  }
}

/**
 * @param {string} src
 * @param {Out} out
 * @param {boolean} firstLineStart
 * @param {Map<string, number> | null} notes footnote numbers
 */
function scanMarkdown(src, out, firstLineStart, notes) {
  const content = new Content();
  /** @type {{ ls: number, le: number, nl: number }[]} */
  const lines = [];
  for (let ls = 0; ls <= src.length;) {
    const nl = src.indexOf('\n', ls);
    const lineEndNl = nl < 0 ? src.length : nl;
    let le = lineEndNl;
    if (le > ls && src.charCodeAt(le - 1) === 13) le--;
    lines.push({ ls, le, nl: nl < 0 ? -1 : nl });
    if (nl < 0) break;
    ls = nl + 1;
    if (ls === src.length) break;
  }
  const delimRow = lines.map((l) => {
    const t = stripContainers(src, l.ls, l.le).text.trim();
    return t.includes('|') && t.includes('-') && DELIM_ROW_RE.test(t);
  });
  const hasPipe = lines.map((l) => src.slice(l.ls, l.le).includes('|'));
  const inTable = lines.map(() => false);
  for (let k = 0; k < lines.length; k++) {
    if (!delimRow[k]) continue;
    for (let j = k; j >= 0 && hasPipe[j]; j--) inTable[j] = true;
    for (let j = k + 1; j < lines.length && hasPipe[j]; j++) inTable[j] = true;
  }

  /** @type {{ ch: string, len: number, indent: number, drop: boolean } | null} */
  let fence = null;
  lines.forEach((line, k) => {
    const blockLevel = k > 0 || firstLineStart;
    const { ls, le, nl } = line;
    if (fence) {
      const inner = stripQuotes(src, ls, le);
      const t = src.slice(inner, le);
      const close = new RegExp(`^[ \\t]*\\${fence.ch}{${fence.len},}[ \\t]*$`);
      if (close.test(t)) {
        fence = null;
      } else if (!fence.drop) {
        let p = inner;
        for (let n = 0; n < fence.indent && p < le && (src[p] === ' ' || src[p] === '\t'); n++) p++;
        content.copy(src, p, le, F_LITERAL);
        if (nl >= 0) content.push('\n', nl, nl + 1, F_BREAK);
      }
      return;
    }
    let p = ls;
    if (blockLevel) {
      const c = stripContainers(src, ls, le);
      p = c.end;
      const rest = src.slice(p, le);
      if (THEMATIC_RE.test(rest) || SETEXT_RE.test(rest) || delimRow[k] || LINKDEF_RE.test(rest)) {
        if (nl >= 0) content.push('\n', nl, nl + 1, F_BREAK);
        return;
      }
      const fm = FENCE_OPEN_RE.exec(rest);
      if (fm) {
        const lang = fm[2].toLowerCase();
        fence = { ch: fm[1][0], len: fm[1].length, indent: c.indent, drop: lang === 'mermaid' };
        return;
      }
      if (/^\$\$[ \t]*$/.test(rest)) {
        fence = { ch: '$', len: 2, indent: c.indent, drop: false };
        return;
      }
      let m = ATX_RE.exec(rest);
      let end = le;
      if (m) {
        p += m[0].length;
        const closing = /[ \t]+#+[ \t]*$/.exec(src.slice(p, le));
        if (closing) end = p + closing.index;
        else if (/^#+[ \t]*$/.test(src.slice(p, le))) end = p;
      } else if ((m = FOOTDEF_RE.exec(rest))) {
        p += m[0].length;
      }
      if (inTable[k]) {
        emitTableRow(src, p, end, content);
        if (nl >= 0) content.push('\n', nl, nl + 1, F_BREAK);
        return;
      }
      content.copy(src, p, end, F_INLINE);
    } else if (inTable[k]) {
      emitTableRow(src, p, le, content);
      if (nl >= 0) content.push('\n', nl, nl + 1, F_BREAK);
      return;
    } else {
      content.copy(src, p, le, F_INLINE);
    }
    if (nl >= 0) content.push('\n', nl, nl + 1, F_NL);
  });

  const text = content.chars.join('');
  // Stage 2: inline runs are maximal stretches of F_INLINE/F_NL chars that do not cross a blank line, so
  // emphasis, links and code spans may continue onto the next line of the same paragraph.
  const n = text.length;
  // slice edges (ignoring surrounding whitespace) for the unpaired-delimiter rule
  let ra = 0;
  while (ra < n && isWsCode(text.charCodeAt(ra))) ra++;
  let rz = n;
  while (rz > ra && isWsCode(text.charCodeAt(rz - 1))) rz--;
  let i = 0;
  while (i < n) {
    const f = content.flags[i];
    if (f !== F_INLINE && f !== F_NL) {
      out.emit(text[i], content.map[i], content.mapEnd[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < n && (content.flags[j] === F_INLINE || content.flags[j] === F_NL)) {
      if (content.flags[j] === F_NL && j > i) {
        let k = j + 1;
        while (k < n && content.flags[k] === F_INLINE && isWsCode(text.charCodeAt(k))) k++;
        if (k >= n || content.flags[k] !== F_INLINE) break; // blank line / end of paragraph
      }
      j++;
    }
    if (j === i) j = i + 1;
    inline(text, content, i, j, out, ra, rz, notes);
    i = j;
  }
}

/**
 * Strip leading blockquote markers only (used inside fences).
 * @param {string} src @param {number} ls @param {number} le
 */
function stripQuotes(src, ls, le) {
  let p = ls;
  for (;;) {
    let q = p;
    while (q < le && (src[q] === ' ' || src[q] === '\t') && q - p < 3) q++;
    if (src[q] === '>') {
      p = q + 1;
      if (src[p] === ' ') p++;
      continue;
    }
    return p;
  }
}

/**
 * Strip container prefixes from a line: indentation, blockquote markers, list markers and task boxes.
 * `indent` is the column of the remaining content relative to the last container (for fence indentation).
 * @param {string} src @param {number} ls @param {number} le
 * @returns {{ end: number, indent: number, text: string }}
 */
function stripContainers(src, ls, le) {
  let p = ls;
  let indent = 0;
  for (let guard = 0; guard < 16; guard++) {
    let q = p;
    while (q < le && (src[q] === ' ' || src[q] === '\t')) q++;
    const rest = src.slice(q, le);
    if (rest.startsWith('>')) {
      p = q + 1;
      if (src[p] === ' ') p++;
      indent = 0;
      continue;
    }
    if (THEMATIC_RE.test(rest)) {
      indent = q - p;
      p = q;
      break;
    }
    const m = LIST_MARKER_RE.exec(rest);
    if (m) {
      p = q + m[0].length;
      const t = TASK_RE.exec(src.slice(p, le));
      if (t) p += t[0].length;
      indent = 0;
      continue;
    }
    indent = q - p;
    p = q;
    break;
  }
  return { end: p, indent, text: src.slice(p, le) };
}

/**
 * Emit a GFM table row: cell contents separated by a single break space mapped to the pipe.
 * @param {string} src @param {number} p @param {number} le @param {Content} content
 */
function emitTableRow(src, p, le, content) {
  let start = p;
  let first = true;
  for (let i = p; i <= le; i++) {
    if (i < le && src[i] === '\\') {
      i++;
      continue;
    }
    if (i < le && src[i] !== '|') continue;
    const empty = src.slice(start, i).trim() === '';
    const skip = empty && ((first && i < le) || i === le);
    if (!skip) copyCell(src, start, i, content);
    if (i < le) content.push(' ', i, i + 1, F_BREAK);
    first = false;
    start = i + 1;
  }
}

/**
 * Copy a table cell's content; GFM removes the backslash of an escaped pipe '\|' before any inline parsing, so it
 * renders as '|' even inside a code span.
 * @param {string} src @param {number} s @param {number} e @param {Content} content
 */
function copyCell(src, s, e, content) {
  let from = s;
  for (let k = s; k < e - 1; k++) {
    if (src[k] === '\\' && src[k + 1] === '|') {
      content.copy(src, from, k, F_INLINE);
      from = k + 1;
      k++;
    }
  }
  content.copy(src, from, e, F_INLINE);
}

/**
 * @typedef {{ t: 'text', s: number, e: number } |
 *           { t: 'emit', str: string, ms: number, me: number } |
 *           { t: 'delim', s: number, e: number, ch: string, open: boolean, close: boolean, drop: boolean }} Tok
 */

/**
 * Inline pass over content[a, z): tokenises, pairs emphasis delimiters and emits plain text.
 * `ra`/`rz` are the outermost run bounds (slice edges) used for the unpaired-delimiter rule.
 * @param {string} text @param {Content} content @param {number} a @param {number} z @param {Out} out
 * @param {number} ra @param {number} rz @param {Map<string, number> | null} [notes]
 */
function inline(text, content, a, z, out, ra, rz, notes = null) {
  /** @type {Tok[]} */
  const toks = [];
  tokenize(text, content, a, z, toks, notes);
  resolveDelims(toks, ra, rz);
  for (const t of toks) {
    if (t.t === 'text') {
      for (let k = t.s; k < t.e; k++) out.emit(text[k], content.map[k], content.mapEnd[k]);
    } else if (t.t === 'emit') {
      out.emitAll(t.str, t.ms, t.me);
    } else if (!t.drop) {
      for (let k = t.s; k < t.e; k++) out.emit(text[k], content.map[k], content.mapEnd[k]);
    }
  }
}

/**
 * @param {string} text @param {Content} content @param {number} a @param {number} z @param {Tok[]} toks
 * @param {Map<string, number> | null} [notes] footnote numbers
 */
function tokenize(text, content, a, z, toks, notes = null) {
  let i = a;
  let textStart = a;
  const flush = (/** @type {number} */ end) => {
    if (end > textStart) toks.push({ t: 'text', s: textStart, e: end });
  };
  /** content index range -> raw range */
  const raw = (/** @type {number} */ s, /** @type {number} */ e) => [content.map[s], content.mapEnd[e - 1]];
  while (i < z) {
    const ch = text[i];
    let handled = -1; // new index when a construct was consumed
    if (ch === '\\' && i + 1 < z) {
      const nx = text[i + 1];
      if (ASCII_PUNCT.test(nx)) {
        flush(i);
        toks.push({ t: 'text', s: i + 1, e: i + 2 });
        handled = i + 2;
      } else if (nx === '\n') {
        flush(i);
        handled = i + 1;
      }
    } else if (ch === '`' || ch === '$') {
      let n = 1;
      while (i + n < z && text[i + n] === ch) n++;
      const close = findRun(text, i + n, z, ch, n);
      if (close >= 0 && (ch === '`' || n <= 2)) {
        flush(i);
        let cs = i + n;
        let ce = close;
        if (ch === '`' && ce - cs >= 2 && /\s/.test(text[cs]) && /\s/.test(text[ce - 1]) && text.slice(cs, ce).trim() !== '') {
          cs++;
          ce--;
        }
        if (ch === '$') {
          texTokens(text, cs, ce, toks, raw);
          handled = close + n;
          if (handled > i) {
            i = handled;
            textStart = i;
          } else i++;
          continue;
        }
        for (let k = cs; k < ce; k++) {
          if (text[k] === '\n') {
            const [ms, me] = raw(k, k + 1);
            toks.push({ t: 'emit', str: ' ', ms, me });
          } else toks.push({ t: 'text', s: k, e: k + 1 });
        }
        handled = close + n;
      } else {
        // an unmatched run is literal
        flush(i);
        toks.push({ t: 'text', s: i, e: i + n });
        handled = i + n;
      }
    } else if (ch === '&') {
      const m = matchEntityInContent(text, content, i, z);
      if (m) {
        flush(i);
        toks.push({ t: 'emit', str: m.text, ms: content.map[i], me: content.mapEnd[m.end - 1] });
        handled = m.end;
      }
    } else if (ch === '<') {
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)>/.exec(text.slice(i, Math.min(z, i + 2048)));
      if (auto) {
        flush(i);
        toks.push({ t: 'text', s: i + 1, e: i + auto[0].length - 1 });
        handled = i + auto[0].length;
      } else {
        const j = skipHtmlMarkup(text, i, z);
        if (j > i) {
          flush(i);
          handled = j;
        }
      }
    } else if (ch === '!' && text[i + 1] === '[') {
      const link = parseLink(text, i + 1, z);
      if (link && link.kind !== 'shortcut') {
        flush(i);
        handled = link.end;
      }
    } else if (ch === '[') {
      const foot = /^\[\^([^\]\s]+)\]/.exec(text.slice(i, Math.min(z, i + 256)));
      if (foot) {
        flush(i);
        const num = notes?.get(foot[1].toLowerCase());
        if (num != null) {
          const [ms, me] = raw(i, i + foot[0].length);
          toks.push({ t: 'emit', str: String(num), ms, me });
        } else toks.push({ t: 'text', s: i + 2, e: i + 2 + foot[1].length });
        handled = i + foot[0].length;
      } else {
        const link = parseLink(text, i, z);
        if (link && link.kind !== 'shortcut') {
          flush(i);
          tokenize(text, content, i + 1, link.textEnd, toks, notes);
          handled = link.end;
        }
      }
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let n = 1;
      while (i + n < z && text[i + n] === ch) n++;
      const prev = i > a ? text[i - 1] : ' ';
      const next = i + n < z ? text[i + n] : ' ';
      const prevWs = /\s/.test(prev);
      const nextWs = /\s/.test(next);
      const prevP = PUNCT.test(prev);
      const nextP = PUNCT.test(next);
      const left = !nextWs && (!nextP || prevWs || prevP);
      const right = !prevWs && (!prevP || nextWs || nextP);
      const intraword = ch === '_' && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next);
      if ((left || right) && !intraword && (ch !== '~' || n === 2)) {
        flush(i);
        toks.push({ t: 'delim', s: i, e: i + n, ch, open: left, close: right, drop: false });
        handled = i + n;
      } else {
        handled = -1;
        i += n;
        continue;
      }
    }
    if (handled > i) {
      i = handled;
      textStart = i;
    } else {
      i++;
    }
  }
  flush(z);
}

/** Math-mode commands that render their braced argument as text. */
const TEX_ARG_TEXT = new Set(['text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textnormal', 'mathrm', 'mathit',
  'mathbf', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'mathscr', 'operatorname', 'mbox', 'hbox', 'boldsymbol', 'bm', 'emph']);
/** Math-mode commands that render a glyph (or a word); everything else renders no text of its own. */
const TEX_SYMBOLS = /** @type {Record<string, string>} */ ({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ',
  Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡',
  cong: '≅', propto: '∝', ll: '≪', gg: '≫', lt: '<', gt: '>', times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓',
  ast: '∗', star: '⋆', circ: '∘', bullet: '∙', oplus: '⊕', otimes: '⊗', infty: '∞', to: '→', rightarrow: '→',
  leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  implies: '⟹', iff: '⟺', mapsto: '↦', uparrow: '↑', downarrow: '↓', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅',
  varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮', ldots: '…', dots: '…', cdots: '⋯',
  vdots: '⋮', ddots: '⋱', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
  vert: '∣', mid: '∣', Vert: '∥', parallel: '∥', perp: '⊥', angle: '∠', prime: '′', degree: '°', ell: 'ℓ',
  hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', min: 'min', max: 'max', sup: 'sup', inf: 'inf', lim: 'lim',
  sin: 'sin', cos: 'cos', tan: 'tan', sec: 'sec', csc: 'csc', cot: 'cot', arcsin: 'arcsin', arccos: 'arccos',
  arctan: 'arctan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', det: 'det', dim: 'dim', ker: 'ker', gcd: 'gcd',
  deg: 'deg', arg: 'arg', Pr: 'Pr', mod: 'mod', bmod: 'mod', pmod: 'mod',
  '{': '{', '}': '}', '%': '%', '$': '$', _: '_', '#': '#', '&': '&', '|': '∥',
});
/** Characters KaTeX renders differently in math mode. */
const TEX_CHARS = /** @type {Record<string, string>} */ ({ '-': '−', '*': '∗', "'": '′' });

/**
 * Inline math content[cs, ce) projected to approximately the text KaTeX renders (see the header).
 * @param {string} text @param {number} cs @param {number} ce @param {Tok[]} toks
 * @param {(s: number, e: number) => number[]} raw content index range -> raw range
 */
function texTokens(text, cs, ce, toks, raw) {
  for (let k = cs; k < ce;) {
    const c = text[k];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|[^A-Za-z])/.exec(text.slice(k, Math.min(ce, k + 48)));
      if (!m) {
        k++;
        continue;
      }
      const end = k + m[0].length;
      if (TEX_ARG_TEXT.has(m[1]) && text[end] === '{') {
        // text-mode argument: its characters render as written (no math-mode glyph substitution)
        let depth = 0;
        let j = end;
        for (; j < ce; j++) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}' && --depth === 0) break;
        }
        for (let q = end + 1; q < Math.min(j, ce); q++) {
          if (text[q] === '{' || text[q] === '}') continue;
          if (text[q] === '\\' && q + 1 < j) {
            q++;
            toks.push({ t: 'text', s: q, e: q + 1 });
            continue;
          }
          toks.push({ t: 'text', s: q, e: q + 1 });
        }
        k = Math.min(ce, j + 1);
        continue;
      }
      const sym = TEX_ARG_TEXT.has(m[1]) ? undefined : TEX_SYMBOLS[m[1]];
      if (sym !== undefined) {
        const [ms, me] = raw(k, end);
        toks.push({ t: 'emit', str: sym, ms, me });
      }
      k = end;
      continue;
    }
    if (c === '{' || c === '}' || c === '^' || c === '_' || c === '&' || c === '~') {
      k++;
      continue;
    }
    if (c === '\n') {
      const [ms, me] = raw(k, k + 1);
      toks.push({ t: 'emit', str: ' ', ms, me });
    } else if (TEX_CHARS[c]) {
      const [ms, me] = raw(k, k + 1);
      toks.push({ t: 'emit', str: TEX_CHARS[c], ms, me });
    } else {
      toks.push({ t: 'text', s: k, e: k + 1 });
    }
    k++;
  }
}

/**
 * Pair emphasis delimiters (same char) with a stack; paired runs are dropped. Unpaired runs are dropped when
 * they are doubled ("**", "__", "~~") or touch the edges of the scanned slice (a slice cut through emphasis).
 * @param {Tok[]} toks @param {number} ra @param {number} rz
 */
function resolveDelims(toks, ra, rz) {
  /** @type {Extract<Tok, { t: 'delim' }>[]} */
  const stack = [];
  for (const t of toks) {
    if (t.t !== 'delim') continue;
    if (t.close) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].ch !== t.ch) k--;
      if (k >= 0) {
        stack[k].drop = true;
        t.drop = true;
        stack.length = k;
        continue;
      }
    }
    if (t.open) stack.push(t);
  }
  for (const t of toks) {
    if (t.t !== 'delim' || t.drop) continue;
    if (t.e - t.s >= 2 || t.s === ra || t.e === rz) t.drop = true;
  }
}

/**
 * Find a run of exactly `n` `ch` characters in text[from, to).
 * @param {string} text @param {number} from @param {number} to @param {string} ch @param {number} n
 */
function findRun(text, from, to, ch, n) {
  for (let k = from; k < to; k++) {
    if (text[k] !== ch) continue;
    let m = 1;
    while (k + m < to && text[k + m] === ch) m++;
    if (m === n) return k;
    k += m - 1;
  }
  return -1;
}

/**
 * Parse a link/image tail at text[i] === '['. Returns null when brackets do not balance.
 * kind: 'inline' ([t](u)), 'ref' ([t][r]) or 'shortcut' ([t]).
 * @param {string} text @param {number} i @param {number} z
 * @returns {{ textEnd: number, end: number, kind: 'inline'|'ref'|'shortcut' } | null}
 */
function parseLink(text, i, z) {
  let depth = 0;
  let k = i;
  for (; k < z; k++) {
    const c = text[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (text[k + n] === '`') n++;
      const close = findRun(text, k + n, z, '`', n);
      if (close >= 0) k = close + n - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (k >= z) return null;
  const textEnd = k;
  if (text[k + 1] === '(') {
    let d = 0;
    let angle = false;
    for (let j = k + 1; j < z; j++) {
      const c = text[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (angle) {
        if (c === '>') angle = false;
        continue;
      }
      if (c === '<' && text[j - 1] === '(') angle = true;
      else if (c === '(') d++;
      else if (c === ')' && --d === 0) return { textEnd, end: j + 1, kind: 'inline' };
    }
    return { textEnd, end: textEnd + 1, kind: 'shortcut' };
  }
  if (text[k + 1] === '[') {
    const close = text.indexOf(']', k + 2);
    if (close >= 0 && close < z && !text.slice(k + 2, close).includes('[')) return { textEnd, end: close + 1, kind: 'ref' };
  }
  return { textEnd, end: textEnd + 1, kind: 'shortcut' };
}

/**
 * Match a character reference in the content string (contiguous source chars only).
 * @param {string} text @param {Content} content @param {number} i @param {number} z
 */
function matchEntityInContent(text, content, i, z) {
  const m = matchEntityAt(text, i, { requireSemicolon: true });
  if (!m || m.end > z) return null;
  // the reference must be contiguous in the source (not spliced across a stripped prefix)
  if (content.map[m.end - 1] - content.map[i] !== m.end - 1 - i) return null;
  return m;
}
