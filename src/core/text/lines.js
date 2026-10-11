// @ts-check
// Line index over a source string: converts between UTF-16 offsets and 1-based line numbers.
//
// Conventions (shared by render, diff and anchoring):
// - Lines are separated by '\n' (a '\r' before '\n' belongs to the line terminator, as in jsdiff).
// - A trailing '\n' does not open a new line ("a\nb\n" has 2 lines); an empty source has 1 (empty) line.
// - startOf(line) is the offset of the line's first character; endOf(line) is the offset just past its last
//   content character (excluding '\r\n' / '\n'); nextStartOf(line) is the start of the following line (or the
//   source length), i.e. the end of the line *including* its terminator.

/**
 * @typedef {Object} LineIndex
 * @property {number} count                       number of lines (>= 1)
 * @property {(off: number) => number} lineOf     1-based line containing offset `off` (clamped to [1, count])
 * @property {(off: number) => number} colOf      0-based column of `off` within its line
 * @property {(line: number) => number} startOf   offset of the first char of `line` (clamped)
 * @property {(line: number) => number} endOf     offset just past the content of `line` (no terminator)
 * @property {(line: number) => number} nextStartOf offset just past the terminator of `line` (or source length)
 * @property {(line: number) => string} lineText  content of `line` without its terminator
 */

/**
 * Build a line index for `source`.
 * @param {string} source
 * @returns {LineIndex}
 */
export function lineIndex(source) {
  const len = source.length;
  /** @type {number[]} */
  const starts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    if (i + 1 < len) starts.push(i + 1);
  }
  const count = starts.length;

  /** @param {number} line */
  const clampLine = (line) => (line < 1 ? 1 : line > count ? count : Math.floor(line));

  /** @param {number} off */
  const lineOf = (off) => {
    if (!(off > 0)) return 1;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /** @param {number} line */
  const startOf = (line) => starts[clampLine(line) - 1];

  /** @param {number} line */
  const nextStartOf = (line) => {
    const l = clampLine(line);
    return l < count ? starts[l] : len;
  };

  /** @param {number} line */
  const endOf = (line) => {
    let end = nextStartOf(line);
    const start = startOf(line);
    if (end > start && source.charCodeAt(end - 1) === 10 /* \n */) end--;
    if (end > start && source.charCodeAt(end - 1) === 13 /* \r */) end--;
    return end;
  };

  return {
    count,
    lineOf,
    colOf: (off) => Math.max(0, Math.min(off, len) - starts[lineOf(off) - 1]),
    startOf,
    endOf,
    nextStartOf,
    lineText: (line) => source.slice(startOf(line), endOf(line)),
  };
}

/**
 * Lines spanned by the half-open range [start, end): `{ startLine, endLine }` (1-based, inclusive).
 * An empty range reports the line containing `start`.
 * @param {LineIndex} li
 * @param {number} start
 * @param {number} end
 */
export function linesOfRange(li, start, end) {
  const startLine = li.lineOf(start);
  const endLine = end > start ? li.lineOf(end - 1) : startLine;
  return { startLine, endLine };
}
