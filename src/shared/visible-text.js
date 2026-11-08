// @ts-check
// What a reader of a document reads, as source ranges: the measure behind "how much of the doc did this change
// rewrite", shared by the revision guards (src/core/review/guards.js) and the Claude Code pre-write hook
// (src/cli/hooks.js), so the two agree. Dependency-free on purpose (no imports at all): the hook loads it before
// anything else and must start fast and never fail on a broken module. It is a linear heuristic scanner, not a parser.
//
// hiddenRanges(format, source) -> sorted, disjoint [start, end) source ranges a reader never reads as text:
//   html      markup: tags with all their attributes (so data: URIs, inline styles and event handlers), comments,
//             doctype, processing instructions and CDATA markers; and the content of raw-text and inert elements
//             (script, style, template, noscript, textarea, title, iframe, noembed, noframes: the TEXT_EXCLUDE tags of
//             shared/protocol.js and friends), i.e. scripts, JSON/data blobs and styles - except the prose a page
//             renders from its own script: in an inline <script> of up to MAX_SCRIPT_SCAN (256 KB) characters
//             holding JavaScript or JSON, the contents of prose-like string literals are text (JSON: string values,
//             not keys; JavaScript: '...', "..." and `...` literals, comments and regular expressions skipped; a
//             heuristic tokenizer). Prose-like: at least 4 words of letters, at least 24 characters and at least 60%
//             letters and spaces, HTML tags and \n \r \t escapes inside it aside (those stay hidden), so numbers,
//             dates, short labels and markup snippets of a data blob or chart script are not text (a list of 4 or
//             more class names is, a known limit of the rule). A bigger script (an inlined library) stays hidden
//             whole. Character references count as text. A `<` that starts no tag (`a < b`) is text. Parsed as a
//             browser does where it matters to what is read: `<!-->` and `<!--->` are complete (empty) comments and
//             `--!>` also ends one; outside <svg>/<math>, `<![CDATA[` is a bogus comment ending at the first `>`,
//             while inside them a CDATA section's content is text; and `<script/>` (any raw-text element written
//             self-closing) still opens the element in HTML (only inside <svg>/<math> does `/>` close it).
//   markdown  base64 data: URIs of 64+ payload characters (inline images) and raw <script>/<style> HTML blocks (a
//             line starting with the tag, through the line holding its end tag), outside fenced code. Everything
//             else counts, markup included, so a prose doc is measured exactly as it always was.
// visibleText(source, hidden, from, to) -> { text, map }: the visible text of source[from, to). Where a hidden
//   range sat between two visible pieces that do not already meet at whitespace, a '\n' separator keeps their
//   words apart (map -1). map[i] is the source offset of text[i].
// countVisible(source, hidden, from, to, nonWs) -> number of visible characters of source[from, to) (nonWs: leaving
//   whitespace out, as the guards do for HTML, whose indentation between tags is nothing anyone reads).
// visibleBlocks(format, source) -> string[]: the visible text cut into blocks, whitespace collapsed, empty ones left
//   out: the lines of a Markdown doc (hidden parts cut out); for HTML the pieces between line breaks, block-level
//   tags, comments and raw-text elements (inline tags such as <b> or <a> do not cut). The pre-write hook's unit.
// visibleChangeRatio(format, oldText, newText) -> 0..1: the share of the old doc's visible characters (whitespace
//   left out) that the new doc no longer has, the pre-write hook's cheap stand-in for the guards' word diff: blocks
//   the new doc still has (a multiset: moved blocks are free) cost nothing; each other old block is paired, in order,
//   with a new block that is not an old one and costs the words it lost; old blocks left over cost all their words.

/** Elements whose content is never read as text (shared/protocol.js TEXT_EXCLUDE.tags + inert friends). */
export const HIDDEN_CONTENT_TAGS = Object.freeze(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'iframe', 'noembed', 'noframes']);
const HIDDEN_CONTENT = new Set(HIDDEN_CONTENT_TAGS);

/** Tags that do not end a block of text (the hook's unit): phrasing content. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins',
  'kbd', 'label', 'mark', 'nobr', 'picture', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup',
  'time', 'tt', 'u', 'var', 'wbr',
]);

/** A base64 data: URI with a payload long enough never to be prose (Markdown: inline images). */
const DATA_URI_RE = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*;base64,[A-Za-z0-9+/=]{64,}/gi;

/** Inline scripts up to this many characters are read for prose-like string literals; bigger ones stay hidden whole. */
export const MAX_SCRIPT_SCAN = 256 * 1024;

/** Script types read as JavaScript (no type attribute, `module`, the JavaScript MIME types). */
const JS_TYPE_RE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script(?:1\.\d)?|text\/(?:jscript|livescript))$/;

/** Script types read as JSON. */
const JSON_TYPE_RE = /^(?:importmap|speculationrules|[a-z0-9.+-]+\/(?:[a-z0-9.-]+\+)?json)$/;

/** Words after which a '/' starts a regular expression, not a division. */
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * What stays hidden inside a prose-like string literal: HTML tags and the \n \r \t escapes. An escaped backslash is
 * matched only so that `\\n` is not read as a `\n` escape; it stays text.
 */
const LITERAL_MARKUP_RE = /<\/?[A-Za-z][^<>]*>|\\[nrt\\]/g;

/** @typedef {[number, number]} Range */

/**
 * Hidden source ranges of a document (see the header).
 * @param {string} format 'html' | 'markdown' (anything else: nothing hidden)
 * @param {string} source
 * @returns {Range[]}
 */
export function hiddenRanges(format, source) {
  const src = String(source ?? '');
  if (format === 'html') return merge(scanHtml(src).map((m) => [m.s, m.e]));
  if (format === 'markdown') return merge(scanMarkdown(src));
  return [];
}

/**
 * The visible text of source[from, to) (see the header).
 * @param {string} source
 * @param {Range[]} hidden sorted, disjoint (hiddenRanges)
 * @param {number} [from]
 * @param {number} [to]
 * @returns {{ text: string, map: number[] }}
 */
export function visibleText(source, hidden, from = 0, to = source.length) {
  /** @type {string[]} */
  const parts = [];
  /** @type {number[]} */
  const map = [];
  let pos = from;
  let gap = false;
  /** @param {number} s @param {number} e */
  const emit = (s, e) => {
    if (e <= s) return;
    const piece = source.slice(s, e);
    if (gap && parts.length && !isWs(parts[parts.length - 1]) && !isWs(piece[0])) {
      parts.push('\n');
      map.push(-1);
    }
    gap = false;
    for (let i = 0; i < piece.length; i++) {
      parts.push(piece[i]);
      map.push(s + i);
    }
  };
  for (let k = firstEndingAfter(hidden, from); k < hidden.length && hidden[k][0] < to; k++) {
    const [hs, he] = hidden[k];
    emit(pos, Math.max(pos, Math.min(hs, to)));
    pos = Math.max(pos, he);
    gap = true;
  }
  emit(pos, to);
  return { text: parts.join(''), map };
}

/**
 * Number of visible characters of source[from, to); `nonWs` leaves whitespace out.
 * @param {string} source
 * @param {Range[]} hidden sorted, disjoint
 * @param {number} from
 * @param {number} to
 * @param {boolean} nonWs
 * @returns {number}
 */
export function countVisible(source, hidden, from, to, nonWs) {
  let n = 0;
  let pos = from;
  /** @param {number} s @param {number} e */
  const add = (s, e) => {
    if (e <= s) return;
    if (!nonWs) n += e - s;
    else for (let i = s; i < e; i++) if (!isWsCode(source.charCodeAt(i))) n++;
  };
  for (let k = firstEndingAfter(hidden, from); k < hidden.length && hidden[k][0] < to; k++) {
    add(pos, Math.min(hidden[k][0], to));
    pos = Math.max(pos, hidden[k][1]);
  }
  add(pos, to);
  return n;
}

/**
 * Visible blocks of a document (see the header).
 * @param {string} format
 * @param {string} source
 * @returns {string[]}
 */
export function visibleBlocks(format, source) {
  const src = String(source ?? '');
  /** @type {string[]} */
  const out = [];
  /** @param {string} s */
  const push = (s) => {
    for (const line of s.split('\n')) {
      const b = line.replace(/\s+/g, ' ').trim();
      if (b) out.push(b);
    }
  };
  if (format !== 'html') {
    // a Markdown line keeps its place: a hidden data: URI or script block is cut out of it, never splits it
    let pos = 0;
    let text = '';
    for (const [s, e] of format === 'markdown' ? merge(scanMarkdown(src)) : []) {
      text += src.slice(pos, s);
      pos = e;
    }
    push(text + src.slice(pos));
    return out;
  }
  let pos = 0;
  let block = '';
  for (const m of scanHtml(src)) {
    block += src.slice(pos, m.s);
    if (!m.inline) {
      push(block);
      block = '';
    }
    pos = Math.max(pos, m.e);
  }
  push(block + src.slice(pos));
  return out;
}

/**
 * The pre-write hook's measure (see the header).
 * @param {string} format
 * @param {string} oldText
 * @param {string} newText
 * @returns {number} 0..1
 */
export function visibleChangeRatio(format, oldText, newText) {
  const oldBlocks = visibleBlocks(format, oldText);
  const newBlocks = visibleBlocks(format, newText);
  /** @type {Map<string, number>} */
  const pool = new Map();
  for (const b of newBlocks) pool.set(b, (pool.get(b) ?? 0) + 1);
  /** @type {Map<string, number>} */
  const taken = new Map();
  let total = 0;
  /** @type {string[]} old blocks the new text does not have as they were */
  const changed = [];
  for (const b of oldBlocks) {
    total += weightOf(b);
    const n = pool.get(b);
    if (n) {
      pool.set(b, n - 1);
      taken.set(b, (taken.get(b) ?? 0) + 1);
    } else {
      changed.push(b);
    }
  }
  /** @type {string[]} new blocks that are not old ones, in order */
  const fresh = [];
  for (const b of newBlocks) {
    const n = taken.get(b);
    if (n) taken.set(b, n - 1);
    else fresh.push(b);
  }
  // A changed block is paired, in document order, with a new one: only the words it lost count (a word changed in a
  // paragraph is not the whole paragraph). Changed blocks left over count whole.
  let missing = 0;
  changed.forEach((b, i) => {
    missing += i < fresh.length ? lostWeight(b, fresh[i]) : weightOf(b);
  });
  return total ? missing / total : 0;
}

/** @param {string} block */
function weightOf(block) {
  return block.replace(/\s/g, '').length;
}

/**
 * Characters (whitespace aside) of the words of `a` that `b` does not have (a multiset of words: order is free).
 * @param {string} a
 * @param {string} b
 */
function lostWeight(a, b) {
  /** @type {Map<string, number>} */
  const bag = new Map();
  for (const w of b.split(' ')) bag.set(w, (bag.get(w) ?? 0) + 1);
  let lost = 0;
  for (const w of a.split(' ')) {
    const n = bag.get(w);
    if (n) bag.set(w, n - 1);
    else lost += w.length;
  }
  return lost;
}

// ------------------------------------------------------------------------------------------------ HTML

/**
 * Hidden constructs of an HTML source, in order: markup and the content of hidden elements. `inline`: a tag that
 * does not end a block of text.
 * @param {string} src
 * @returns {Array<{ s: number, e: number, inline: boolean }>}
 */
function scanHtml(src) {
  const n = src.length;
  /** @type {Array<{ s: number, e: number, inline: boolean }>} */
  const out = [];
  /** open <svg> / <math> elements: foreign content, where CDATA sections are text and `/>` closes any element */
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const j = src.indexOf('<', i);
    if (j < 0) break;
    const c1 = src.charCodeAt(j + 1);
    if (src.startsWith('<!--', j)) {
      i = commentEnd(src, j);
      out.push({ s: j, e: i, inline: false });
      continue;
    }
    if (foreign && src.startsWith('<![CDATA[', j)) {
      // a CDATA section: its markers are markup, its content is text
      const k = src.indexOf(']]>', j + 9);
      out.push({ s: j, e: j + 9, inline: true });
      if (k >= 0) out.push({ s: k, e: k + 3, inline: true });
      i = k < 0 ? n : k + 3;
      continue;
    }
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      // doctype, processing instruction, or a bogus comment (`<![CDATA[` outside <svg>/<math> is one): to the first '>'
      const k = src.indexOf('>', j + 2);
      i = k < 0 ? n : k + 1;
      out.push({ s: j, e: i, inline: false });
      continue;
    }
    const isEnd = c1 === 47; /* / */
    const nameStart = isEnd ? j + 2 : j + 1;
    if (!isAsciiAlpha(src.charCodeAt(nameStart))) {
      i = j + 1;
      continue;
    }
    let k = nameStart;
    while (k < n && !isTagNameEnd(src.charCodeAt(k))) k++;
    const name = src.slice(nameStart, k).toLowerCase();
    const tagEnd = findTagEnd(src, k, n);
    if (tagEnd < 0) {
      i = j + 1;
      continue;
    }
    const inline = INLINE_TAGS.has(name);
    out.push({ s: j, e: tagEnd, inline });
    i = tagEnd;
    const selfClosing = src.charCodeAt(tagEnd - 2) === 47; /* <x/> */
    if (name === 'svg' || name === 'math') {
      if (isEnd) foreign = Math.max(0, foreign - 1);
      else if (!selfClosing) foreign++;
      continue;
    }
    // `/>` closes an element only in foreign content: in HTML, <script/> opens a script like <script> does
    if (!isEnd && HIDDEN_CONTENT.has(name) && !(selfClosing && foreign)) {
      const close = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
      close.lastIndex = tagEnd;
      const m = close.exec(src);
      const end = m ? m.index : n;
      const kind = name === 'script' && end - tagEnd <= MAX_SCRIPT_SCAN ? scriptKind(src.slice(j, tagEnd)) : null;
      let pos = tagEnd;
      // the prose a page renders from its own script or data blob is text (see the header); the rest is hidden
      if (kind) {
        for (const [s, e] of scriptProse(src, tagEnd, end, kind)) {
          if (s > pos) out.push({ s: pos, e: s, inline: false });
          pos = Math.max(pos, e);
        }
      }
      if (end > pos) out.push({ s: pos, e: end, inline: false });
      i = end;
    }
  }
  return out;
}

/**
 * Index just past the comment that starts at `j` (`<!--`) as a browser ends it: `<!-->` and `<!--->` are complete
 * empty comments; otherwise the first `-->` or `--!>` ends it; unterminated, it runs to the end.
 * @param {string} src
 * @param {number} j
 * @returns {number}
 */
function commentEnd(src, j) {
  if (src.charCodeAt(j + 4) === 62 /* > */) return j + 5;
  if (src.startsWith('->', j + 4)) return j + 6;
  const a = src.indexOf('-->', j + 4);
  const b = src.indexOf('--!>', j + 4);
  if (a < 0 && b < 0) return src.length;
  if (b < 0 || (a >= 0 && a < b)) return a + 3;
  return b + 4;
}

/**
 * How a <script> holds what it holds, from its opening tag's type attribute: 'js', 'json', or null (another type:
 * a template, a shader, text for some library... stays hidden whole).
 * @param {string} tag the opening tag, `<script ...>`
 * @returns {'js' | 'json' | null}
 */
function scriptKind(tag) {
  const m = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
  const type = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').split(';')[0].trim().toLowerCase();
  if (!type || JS_TYPE_RE.test(type)) return 'js';
  return JSON_TYPE_RE.test(type) ? 'json' : null;
}

/**
 * Source ranges of a script's content src[from, to) a reader reads: the contents of its prose-like string literals
 * (see the header), with the HTML tags and \n \r \t escapes inside them left out. A heuristic tokenizer: JSON string
 * values (a string followed by ':' is a key); JavaScript '...', "..." and `...` literals (the text parts of a template
 * literal are one literal; its ${} expressions are code), with // and /* *\/ comments and regular expressions
 * skipped. A quote left unclosed on its line is no literal.
 * @param {string} src
 * @param {number} from
 * @param {number} to
 * @param {'js' | 'json'} kind
 * @returns {Range[]} sorted, disjoint
 */
function scriptProse(src, from, to, kind) {
  const json = kind === 'json';
  /** @type {Range[]} */
  const out = [];
  let regexOk = true; // a '/' here starts a regular expression (JavaScript)
  let i = from;
  while (i < to) {
    const c = src.charCodeAt(i);
    if (c === 34 /* " */ || (!json && (c === 39 /* ' */ || c === 96 /* ` */))) {
      const lit = c === 96 ? templateLiteral(src, i, to, 0) : quotedLiteral(src, i, to);
      if (!lit) {
        i++;
        continue;
      }
      let k = lit.end;
      if (json) while (k < to && isWsCode(src.charCodeAt(k))) k++;
      if (!(json && src.charCodeAt(k) === 58 /* : a key */)) out.push(...proseRanges(src, lit.parts));
      i = lit.end;
      regexOk = false;
      continue;
    }
    if (json) {
      i++;
      continue;
    }
    if (c === 47 /* / */) {
      const d = src.charCodeAt(i + 1);
      if (d === 47 /* // */) {
        const nl = src.indexOf('\n', i + 2);
        i = nl < 0 || nl >= to ? to : nl + 1;
        continue;
      }
      if (d === 42 /* /* */) {
        const k = src.indexOf('*/', i + 2);
        i = k < 0 || k + 2 > to ? to : k + 2;
        continue;
      }
      const k = regexOk ? regexEnd(src, i, to) : -1;
      i = k > 0 ? k : i + 1;
      regexOk = k <= 0;
      continue;
    }
    if (isWsCode(c)) {
      i++;
      continue;
    }
    if (isIdentCode(c)) {
      let k = i + 1;
      while (k < to && isIdentCode(src.charCodeAt(k))) k++;
      regexOk = BEFORE_EXPR.has(src.slice(i, k));
      i = k;
      continue;
    }
    regexOk = c !== 41 /* ) */ && c !== 93 /* ] */;
    i++;
  }
  return out;
}

/**
 * A '...' or "..." literal starting at `i`: its end (past the closing quote) and content range; null when it is not
 * closed on its line (or within `to`).
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @returns {{ end: number, parts: Range[] } | null}
 */
function quotedLiteral(src, i, to) {
  const q = src.charCodeAt(i);
  for (let k = i + 1; k < to; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 /* \ */) k++;
    else if (c === q) return { end: k + 1, parts: [[i + 1, k]] };
    else if (c === 10 || c === 13) return null;
  }
  return null;
}

/**
 * A `...` template literal starting at `i`: its end and the ranges of its text parts (its ${} expressions skipped,
 * literals nested in them included); null when it is not closed within `to` or nests too deep.
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @param {number} depth
 * @returns {{ end: number, parts: Range[] } | null}
 */
function templateLiteral(src, i, to, depth) {
  if (depth > 8) return null;
  /** @type {Range[]} */
  const parts = [];
  let seg = i + 1;
  for (let k = i + 1; k < to; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 /* \ */) {
      k++;
    } else if (c === 96 /* ` */) {
      parts.push([seg, k]);
      return { end: k + 1, parts };
    } else if (c === 36 /* $ */ && src.charCodeAt(k + 1) === 123 /* { */) {
      parts.push([seg, k]);
      let open = 1;
      k += 2;
      while (k < to && open) {
        const d = src.charCodeAt(k);
        if (d === 34 || d === 39 || d === 96) {
          const lit = d === 96 ? templateLiteral(src, k, to, depth + 1) : quotedLiteral(src, k, to);
          k = lit ? lit.end : k + 1;
          continue;
        }
        if (d === 123) open++;
        else if (d === 125) open--;
        k++;
      }
      if (open) return null;
      seg = k;
      k--;
    }
  }
  return null;
}

/**
 * Index past a regular expression literal starting at `i` ('/'), its flags included; -1 when it does not end on its
 * line (then the '/' was a division after all).
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @returns {number}
 */
function regexEnd(src, i, to) {
  let inClass = false;
  for (let k = i + 1; k < to; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 /* \ */) k++;
    else if (c === 10 || c === 13) return -1;
    else if (inClass) inClass = c !== 93; /* ] */
    else if (c === 91 /* [ */) inClass = true;
    else if (c === 47 /* / */) {
      let e = k + 1;
      while (e < to && isIdentCode(src.charCodeAt(e))) e++;
      return e;
    }
  }
  return -1;
}

/**
 * The readable ranges of a string literal's text parts when, read together, they are prose-like (see the header);
 * else none. HTML tags and \n \r \t escapes inside it are left out (and do not count for the test).
 * @param {string} src
 * @param {Range[]} parts
 * @returns {Range[]}
 */
function proseRanges(src, parts) {
  /** @type {Range[]} */
  const out = [];
  if (parts.reduce((n, [s, e]) => n + e - s, 0) < 24) return out; // too short to be prose, markup or not
  for (const [s, e] of parts) {
    if (e - s <= 0) continue;
    let pos = s;
    for (const m of src.slice(s, e).matchAll(LITERAL_MARKUP_RE)) {
      if (m[0] === '\\\\') continue;
      const at = s + (m.index ?? 0);
      if (at > pos) out.push([pos, at]);
      pos = at + m[0].length;
    }
    if (e > pos) out.push([pos, e]);
  }
  return proseLike(out.map(([s, e]) => src.slice(s, e)).join(' ')) ? out : [];
}

/**
 * Prose-like text: at least 24 characters, at least 60% of them letters or whitespace, and at least 4 words of
 * letters (whitespace-separated, punctuation around them aside).
 * @param {string} text
 * @returns {boolean}
 */
function proseLike(text) {
  if (text.length < 24) return false;
  let letters = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (isWsCode(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c > 127 && /\p{L}/u.test(text[k]))) letters++;
  }
  if (letters < 0.6 * text.length) return false;
  let words = 0;
  for (const w of text.split(/\s+/)) {
    if (/^[^\p{L}\p{N}]*\p{L}[\p{L}\p{M}'’-]*[^\p{L}\p{N}]*$/u.test(w) && ++words >= 4) return true;
  }
  return false;
}

/**
 * Index just past the '>' closing a tag whose name ends at `k`, honouring quoted attribute values (a quote counts
 * only after '='); -1 when a new '<' starts first outside quotes, or the text ends (then that '<' was text).
 * @param {string} src
 * @param {number} k
 * @param {number} to
 * @returns {number}
 */
function findTagEnd(src, k, to) {
  let quote = 0;
  for (let j = k; j < to; j++) {
    const c = src.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      let p = j - 1;
      while (p > k && isWsCode(src.charCodeAt(p))) p--;
      if (src.charCodeAt(p) === 61 /* = */) quote = c;
    } else if (c === 62) {
      return j + 1;
    } else if (c === 60 && j > k) {
      return -1;
    }
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------ Markdown

/**
 * Hidden ranges of a Markdown source (see the header), unsorted.
 * @param {string} src
 * @returns {Range[]}
 */
function scanMarkdown(src) {
  /** @type {Range[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
  /** @type {RegExp | null} */
  let rawEnd = null;
  let rawStart = 0;
  let lineStart = 0;
  while (lineStart < src.length) {
    const nl = src.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? src.length : nl + 1;
    const line = src.slice(lineStart, lineEnd);
    if (rawEnd) {
      if (rawEnd.test(line)) {
        out.push([rawStart, lineEnd]);
        rawEnd = null;
      }
    } else if (fence) {
      const f = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      const raw = open ? null : /^ {0,3}<(script|style)(?=[\s>]|$)/i.exec(line);
      if (open) {
        fence = open[1];
      } else if (raw) {
        rawEnd = new RegExp(`</${raw[1]}>`, 'i');
        rawStart = lineStart;
        if (rawEnd.test(line.slice(raw[0].length))) {
          out.push([rawStart, lineEnd]);
          rawEnd = null;
        }
      } else {
        DATA_URI_RE.lastIndex = 0;
        for (const m of line.matchAll(DATA_URI_RE)) out.push([lineStart + (m.index ?? 0), lineStart + (m.index ?? 0) + m[0].length]);
      }
    }
    lineStart = lineEnd;
  }
  if (rawEnd) out.push([rawStart, src.length]);
  return out;
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * Sorts and merges ranges (touching ones too); empty ranges are dropped.
 * @param {Range[]} ranges
 * @returns {Range[]}
 */
function merge(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Range[]} */
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Index of the first range ending after `off` (binary search over sorted, disjoint ranges).
 * @param {Range[]} ranges
 * @param {number} off
 * @returns {number}
 */
function firstEndingAfter(ranges, off) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] <= off) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
 * A character of a JavaScript identifier, keyword or number (ASCII letters and digits, $, _, anything non-ASCII).
 * @param {number} c
 */
function isIdentCode(c) {
  return isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === 36 || c === 95 || (c > 127 && !isWsCode(c));
}

/** @param {string} ch */
function isWs(ch) {
  return isWsCode(ch.charCodeAt(0));
}

/**
 * Whitespace in the JS `\s` sense (the same rule as core/text/normalize.js isWsCode).
 * @param {number} c
 */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
