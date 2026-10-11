// @ts-check
// Chunked Markdown parsing: works around micromark's quadratic cost for documents with many containers (every
// list/blockquote exit copies the whole event array, so a 200 KB spec full of lists can take seconds).
//
// Large sources are split at "safe" top-level boundaries - the start of a non-indented line that follows a blank
// line, is not a list item (which could continue a loose list), and is not inside a fenced code / math / raw
// HTML (types 1-5) block. Each chunk is parsed on its own and the resulting mdast children are concatenated with
// positions shifted back to whole-document offsets/lines, so the rest of the pipeline sees one tree (raw HTML
// spanning chunks still nests correctly because rehype-raw runs on the merged tree).
// Link reference and footnote definitions are document-global in micromark (a reference only parses as a link
// when its label is defined), so every chunk is parsed with stub definitions for all labels; the stubs are
// dropped after parsing and the real definitions stay in their own chunk.

/** Default chunk size target (characters). Documents shorter than twice this are parsed in one go. */
export const CHUNK_TARGET = 16 * 1024;

const LIST_ITEM_RE = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MATH_OPEN_RE = /^ {0,3}\$\$/;
const DEF_RE = /^ {0,3}(?:>[ \t]?)*\[(\^?)((?:[^\]\\\n]|\\.){1,999})\]:/;
/** HTML block types 1-5 (CommonMark): they may contain blank lines and end at a specific marker. */
const HTML_BLOCKS = [
  { start: /^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
  { start: /^ {0,3}<!--/, end: /-->/ },
  { start: /^ {0,3}<\?/, end: /\?>/ },
  { start: /^ {0,3}<![A-Za-z]/, end: />/ },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
];

/**
 * Plan chunk boundaries and collect definition labels.
 * @param {string} source
 * @param {number} target
 * @returns {{ chunks: { start: number, end: number, line: number }[], labels: { label: string, footnote: boolean }[] }}
 */
export function planChunks(source, target = CHUNK_TARGET) {
  /** @type {{ start: number, end: number, line: number }[]} */
  const chunks = [];
  /** @type {Map<string, { label: string, footnote: boolean }>} */
  const labels = new Map();
  /** @type {null | { kind: 'fence', ch: string, len: number } | { kind: 'math' } | { kind: 'html', end: RegExp }} */
  let state = null;
  let prevBlank = false;
  let chunkStart = 0;
  let chunkLine = 1;
  let line = 1;
  for (let ls = 0; ls < source.length; line++) {
    const nl = source.indexOf('\n', ls);
    const le = nl < 0 ? source.length : nl;
    const text = source.slice(ls, le).replace(/\r$/, '');

    if (!state && prevBlank && ls - chunkStart >= target && isSafeStart(text)) {
      chunks.push({ start: chunkStart, end: ls, line: chunkLine });
      chunkStart = ls;
      chunkLine = line;
    }

    if (state?.kind === 'fence') {
      const m = FENCE_RE.exec(text);
      if (m && m[1][0] === state.ch && m[1].length >= state.len && m[2].trim() === '') state = null;
    } else if (state?.kind === 'math') {
      if (/^ {0,3}\$\$+[ \t]*$/.test(text)) state = null;
    } else if (state?.kind === 'html') {
      if (state.end.test(text)) state = null;
    } else {
      const def = DEF_RE.exec(text);
      if (def) labels.set(`${def[1]}${def[2]}`, { label: def[2], footnote: def[1] === '^' });
      const fence = FENCE_RE.exec(text);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        state = { kind: 'fence', ch: fence[1][0], len: fence[1].length };
      } else if (MATH_OPEN_RE.test(text)) {
        if (!/^ {0,3}\$\$.*\$\$[ \t]*$/.test(text) || /^ {0,3}\$\$[ \t]*$/.test(text)) state = { kind: 'math' };
      } else {
        for (const h of HTML_BLOCKS) {
          if (h.start.test(text)) {
            if (!h.end.test(text.replace(h.start, ''))) state = { kind: 'html', end: h.end };
            break;
          }
        }
      }
    }
    prevBlank = !state && text.trim() === '';
    if (nl < 0) break;
    ls = nl + 1;
  }
  chunks.push({ start: chunkStart, end: source.length, line: chunkLine });
  return { chunks, labels: [...labels.values()] };
}

/** @param {string} text */
function isSafeStart(text) {
  if (!text || text[0] === ' ' || text[0] === '\t') return false;
  if (LIST_ITEM_RE.test(text)) return false;
  return true;
}

/**
 * Shift every position in an mdast subtree.
 * @param {any} node @param {number} dOff @param {number} dLine
 */
function shiftPositions(node, dOff, dLine) {
  if (node.position) {
    const { start, end } = node.position;
    node.position = {
      start: { line: start.line + dLine, column: start.column, offset: (start.offset ?? 0) + dOff },
      end: { line: end.line + dLine, column: end.column, offset: (end.offset ?? 0) + dOff },
    };
  }
  if (Array.isArray(node.children)) for (const c of node.children) shiftPositions(c, dOff, dLine);
}

/**
 * Parse Markdown to mdast, chunking large sources.
 * @param {(text: string) => any} parse a configured parser (unified processor's parse)
 * @param {string} source
 * @param {{ chunkSize?: number }} [opts]
 */
export function parseChunked(parse, source, { chunkSize = CHUNK_TARGET } = {}) {
  if (source.length < 2 * chunkSize) return parse(source);
  const { chunks, labels } = planChunks(source, chunkSize);
  if (chunks.length < 2) return parse(source);
  const stubs = labels
    .map((l) => (l.footnote ? `[^${l.label}]: stub\n\n` : `[${l.label}]: #stub\n\n`))
    .join('');
  const stubLines = (stubs.match(/\n/g) ?? []).length;
  /** @type {any[]} */
  const children = [];
  chunks.forEach((c, i) => {
    const text = source.slice(c.start, c.end);
    // chunk 0 may start with front matter, so its stubs go after it (chunk 0 always ends at a safe boundary);
    // later chunks get them in front (the last chunk may end inside an unclosed block)
    const prepend = i > 0 && stubs !== '';
    const tree = parse(prepend ? stubs + text : stubs ? `${text}\n\n${stubs}` : text);
    const lo = prepend ? stubs.length : 0;
    const hi = prepend ? stubs.length + text.length : text.length;
    for (const child of tree.children) {
      const off = child.position?.start?.offset;
      if (off != null && (off < lo || off >= hi)) continue; // a stub definition
      shiftPositions(child, c.start - lo, c.line - 1 - (prepend ? stubLines : 0));
      children.push(child);
    }
  });
  const lines = source.split('\n');
  return {
    type: 'root',
    children,
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: lines.length, column: lines[lines.length - 1].length + 1, offset: source.length },
    },
  };
}
