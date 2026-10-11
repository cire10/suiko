// @ts-check
// Parsing and formatting of line-range arguments used by the CLI and packets: 'L42-46,L90' <-> [[42,46],[90,90]].
// Lines are 1-based and ranges are inclusive [start, end] (this is the human-facing form; diff hunks use
// half-open ranges internally). Order is preserved; ranges are not merged.

const TOKEN = /^L?(\d+)(?:\s*-\s*L?(\d+))?$/i;

/**
 * Parses 'L42-46,L90' (also '42-46', 'l90', '42 - 46', 'L42-L46', a bare number) into inclusive ranges.
 * @param {string | number} arg
 * @returns {Array<[number, number]>}
 * @throws {RangeError} on an empty or malformed argument, a line < 1, or end < start
 */
export function parseLinesArg(arg) {
  const raw = typeof arg === 'number' ? String(arg) : arg;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RangeError('invalid line range: expected e.g. "L42-46,L90"');
  }
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    const m = TOKEN.exec(token);
    if (!m) throw new RangeError(`invalid line range "${token}" in "${raw}": expected e.g. "L42-46,L90"`);
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (!Number.isSafeInteger(start) || start < 1) throw new RangeError(`invalid line number in "${token}": lines start at 1`);
    if (!Number.isSafeInteger(end) || end < start) throw new RangeError(`invalid line range "${token}": end is before start`);
    out.push([start, end]);
  }
  return out;
}

/**
 * Formats one inclusive range: [42,46] -> 'L42-46', [90,90] -> 'L90'.
 * @param {[number, number] | number[]} range
 * @returns {string}
 */
export function formatRange(range) {
  const [start, end = start] = range;
  return end === start ? `L${start}` : `L${start}-${end}`;
}

/**
 * Formats ranges: [[42,46],[90,90]] -> 'L42-46,L90'. A single [start, end] pair is accepted too.
 * @param {Array<[number, number] | number[]> | [number, number]} ranges
 * @returns {string}
 */
export function formatLines(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return '';
  if (typeof ranges[0] === 'number') return formatRange(/** @type {number[]} */ (ranges));
  return /** @type {number[][]} */ (ranges).map((r) => formatRange(r)).join(',');
}
