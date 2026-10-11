// @ts-check
// Source-mode diff for the UI table and plain unified patches (design 8.7, BUILD_AMENDMENTS 4.1 FROZEN):
//   sourceDiff(a, b, { context = 3 }) -> { hunks: [{ id, header, rows: [{ op, oldNo, newNo, text, words }] }] }
//   unifiedPatch(a, b, { fromLabel, toLabel, context = 3 }) -> string ('' when identical)
// Display hunks group the context-0 line hunks (lineHunks) whose gaps are <= 2 * context lines. A display hunk's
// `id` is the id of its first line hunk; `hunkIds` lists all of them and each changed row carries `hunk`
// (additions to the frozen shape, so thread chips can be attached per change). Row text excludes the line
// terminator ('\r\n' or '\n'). `words` are [start, end, 'ins'|'del'] ranges within the row text, present when a
// removed block and the added block that replaces it are similar enough for word highlights to help.

import { lineHunks } from './hunks.js';
import { wordDiff } from './words.js';

/**
 * @typedef {import('./hunks.js').Hunk} Hunk
 * @typedef {{ op: ' '|'-'|'+', oldNo: number|null, newNo: number|null, text: string,
 *             words: [number, number, 'ins'|'del'][], hunk?: string }} DiffRow
 * @typedef {{ id: string, header: string, hunkIds: string[], rows: DiffRow[] }} DisplayHunk
 */

/** Minimum share of unchanged characters for word-level highlighting of a replaced block. */
const WORD_HIGHLIGHT_MIN_EQ = 0.3;

/**
 * Lines without terminators; a trailing '\n' does not start a new line; '' has no lines.
 * @param {string} s
 */
function splitLines(s) {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Group hunks for display.
 * @param {Hunk[]} hunks @param {number} context
 * @returns {Hunk[][]}
 */
function groupHunks(hunks, context) {
  /** @type {Hunk[][]} */
  const groups = [];
  for (const h of hunks) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (prev && h.oldStart - (prev.oldStart + prev.oldLines) <= 2 * context) g.push(h);
    else groups.push([h]);
  }
  return groups;
}

/**
 * Unified-diff range notation: "start,count" (count omitted when 1; start is the line before when count is 0).
 * @param {number} start first line (1-based) @param {number} count
 */
function range(start, count) {
  if (count === 0) return `${start - 1},0`;
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}

/**
 * Walk a group of hunks producing context / removed / added row descriptors (raw line texts).
 * @param {Hunk[]} group @param {string[]} aLines @param {string[]} bLines @param {number} context
 */
function walkGroup(group, aLines, bLines, context) {
  const first = group[0];
  const last = group[group.length - 1];
  const oldFrom = Math.max(1, first.oldStart - context);
  const oldTo = Math.min(aLines.length + 1, last.oldStart + last.oldLines + context); // exclusive
  const newFrom = first.newStart - (first.oldStart - oldFrom);
  /** @type {{ op: ' '|'-'|'+', oldNo: number|null, newNo: number|null, raw: string, hunk?: Hunk }[]} */
  const rows = [];
  let o = oldFrom;
  let n = newFrom;
  for (const h of group) {
    for (; o < h.oldStart; o++, n++) rows.push({ op: ' ', oldNo: o, newNo: n, raw: aLines[o - 1] ?? '' });
    for (let k = 0; k < h.oldLines; k++, o++) rows.push({ op: '-', oldNo: o, newNo: null, raw: aLines[o - 1] ?? '', hunk: h });
    for (let k = 0; k < h.newLines; k++, n++) rows.push({ op: '+', oldNo: null, newNo: n, raw: bLines[n - 1] ?? '', hunk: h });
  }
  for (; o < oldTo; o++, n++) rows.push({ op: ' ', oldNo: o, newNo: n, raw: aLines[o - 1] ?? '' });
  const oldCount = oldTo - oldFrom;
  const newCount = oldCount + group.reduce((d, h) => d + h.newLines - h.oldLines, 0);
  const header = `@@ -${range(oldFrom, oldCount)} +${range(newFrom, newCount)} @@`;
  return { rows, header };
}

/**
 * @param {string} a
 * @param {string} b
 * @param {{ context?: number, hunks?: Hunk[] }} [opts]
 * @returns {{ hunks: DisplayHunk[] }}
 */
export function sourceDiff(a, b, { context = 3, hunks } = {}) {
  a = a ?? '';
  b = b ?? '';
  const hs = hunks ?? lineHunks(a, b);
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  /** @type {DisplayHunk[]} */
  const out = [];
  for (const group of groupHunks(hs, Math.max(0, context))) {
    const { rows: raw, header } = walkGroup(group, aLines, bLines, Math.max(0, context));
    /** @type {DiffRow[]} */
    const rows = raw.map((r) => {
      /** @type {DiffRow} */
      const row = { op: r.op, oldNo: r.oldNo, newNo: r.newNo, text: r.raw.replace(/\r$/, ''), words: [] };
      if (r.hunk) row.hunk = r.hunk.id;
      return row;
    });
    addWordHighlights(rows);
    out.push({ id: group[0].id, header, hunkIds: group.map((h) => h.id), rows });
  }
  return { hunks: out };
}

/**
 * For each run of '-' rows followed by '+' rows, word-diff the two blocks and attach per-row ranges.
 * @param {DiffRow[]} rows
 */
function addWordHighlights(rows) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].op !== '-') {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].op === '-') j++;
    let k = j;
    while (k < rows.length && rows[k].op === '+') k++;
    if (k > j) highlightPair(rows.slice(i, j), rows.slice(j, k));
    i = k;
  }
}

/**
 * @param {DiffRow[]} delRows @param {DiffRow[]} insRows
 */
function highlightPair(delRows, insRows) {
  const oldText = delRows.map((r) => r.text).join('\n');
  const newText = insRows.map((r) => r.text).join('\n');
  const ops = wordDiff(oldText, newText);
  const eq = ops.filter((o) => o.op === 'eq').reduce((n, o) => n + o.text.replace(/\s+/g, '').length, 0);
  const size = Math.max(oldText.replace(/\s+/g, '').length, newText.replace(/\s+/g, '').length, 1);
  if (eq / size < WORD_HIGHLIGHT_MIN_EQ) return;
  for (const o of ops) {
    if (o.op === 'del') distribute(delRows, o.aStart, o.aEnd, 'del');
    else if (o.op === 'ins') distribute(insRows, o.bStart, o.bEnd, 'ins');
  }
}

/**
 * Split a range of the '\n'-joined block text across its rows.
 * @param {DiffRow[]} rows @param {number} s @param {number} e @param {'ins'|'del'} kind
 */
function distribute(rows, s, e, kind) {
  let base = 0;
  for (const row of rows) {
    const rs = base;
    const re = base + row.text.length;
    const a = Math.max(s, rs);
    const b = Math.min(e, re);
    if (b > a) {
      const lastRange = row.words[row.words.length - 1];
      if (lastRange && lastRange[2] === kind && lastRange[1] === a - rs) lastRange[1] = b - rs;
      else row.words.push([a - rs, b - rs, kind]);
    }
    base = re + 1;
  }
}

/**
 * A unified diff (GNU/git compatible), '' when the texts are identical.
 * @param {string} a
 * @param {string} b
 * @param {{ fromLabel?: string, toLabel?: string, context?: number }} [opts]
 * @returns {string}
 */
export function unifiedPatch(a, b, { fromLabel = 'a', toLabel = 'b', context = 3 } = {}) {
  a = a ?? '';
  b = b ?? '';
  const hs = lineHunks(a, b);
  if (!hs.length) return '';
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const aNoEol = a.length > 0 && !a.endsWith('\n');
  const bNoEol = b.length > 0 && !b.endsWith('\n');
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const group of groupHunks(hs, Math.max(0, context))) {
    const { rows, header } = walkGroup(group, aLines, bLines, Math.max(0, context));
    out.push(header);
    for (const r of rows) {
      out.push(`${r.op}${r.raw}`);
      const lastOld = r.oldNo === aLines.length && aNoEol && r.op !== '+';
      const lastNew = r.newNo === bLines.length && bNoEol && r.op !== '-';
      if (lastOld || lastNew) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}
