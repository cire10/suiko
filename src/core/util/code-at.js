// @ts-check
// The `at` forms of code reviews (design 2.11): where an agent's change for a thread landed (`revise` replies,
// `reply --at`) and the location of an unrequested change (`other[].at`), in repo files.
//
//   src/a.js:L12-14                 lines 12-14 of src/a.js ('L' before the end is optional: L12-L14)
//   src/a.js:L12,src/b.js:L3-4      a list (comma-separated; whitespace around items is ignored)
//   src/a.js:L12,L20-22             a bare item continues the previous file
//   "a,b.js":L3                     a path containing ',' (or starting with '"') is double-quoted
//   src/a.js#h3   del:src/a.js#h3   a hunk of a file (other[].at only; del: = the deletion side)
//
// Paths are parsed FROM THE RIGHT (the last ':L<n>[-<m>]' or '#h<n>'), so a path may itself contain ':'. They are
// returned as written (repo-root-relative, cwd-relative or absolute); `resolveCodePath` matches one against a
// round's file list (the code engine refuses an ambiguous one with exit 3 and the candidates). Pure functions, no
// I/O. Errors are RangeError (callers map them to UsageError). Spec docs keep util/lines-arg.js, unchanged.

import nodePath from 'node:path';

const LINES_TAIL = /:L(\d+)(?:\s*-\s*L?(\d+))?$/i;
const BARE_LINES = /^L(\d+)(?:\s*-\s*L?(\d+))?$/i;
const HUNK_TAIL = /#(h\d+)$/i;

/** @typedef {{ file: string, startLine: number, endLine: number }} CodeAtItem */

/**
 * Parses a code `at` list into one item per range, in order.
 * @param {string} s
 * @param {{ defaultFile?: string | null }} [opts] defaultFile: the file of leading bare items ('L12'), e.g. the one
 *   file a thread anchors; without it a bare leading item is an error
 * @returns {CodeAtItem[]}
 * @throws {RangeError}
 */
export function parseCodeAt(s, { defaultFile = null } = {}) {
  if (typeof s !== 'string' || !s.trim()) throw new RangeError('invalid code location: expected e.g. "src/a.js:L12-14"');
  /** @type {CodeAtItem[]} */
  const out = [];
  let file = defaultFile;
  for (const raw of splitList(s)) {
    const item = raw.trim();
    if (!item) throw new RangeError(`invalid code location "${s}": empty item`);
    const bare = BARE_LINES.exec(item);
    if (bare) {
      if (!file) throw new RangeError(`invalid code location "${item}": name the file, e.g. "src/a.js:${item}"`);
      out.push({ file, ...lineRange(bare, item) });
      continue;
    }
    const { path, rest } = splitPath(item, LINES_TAIL);
    const m = LINES_TAIL.exec(rest);
    if (!m || m.index !== 0) throw new RangeError(`invalid code location "${item}": expected <path>:L<start>[-<end>] (quote a path containing ",")`);
    file = path;
    out.push({ file, ...lineRange(m, item) });
  }
  return out;
}

/**
 * Parses an `other[].at` of a code review: a line location in one file, or a hunk of a file.
 * @param {string} s
 * @returns {{ file: string, lines: Array<[number, number]> } | { file: string, hunk: string, del: boolean }}
 * @throws {RangeError}
 */
export function parseCodeOtherAt(s) {
  if (typeof s !== 'string' || !s.trim()) throw new RangeError('invalid code location: expected e.g. "src/a.js:L12" or "src/a.js#h3"');
  let text = s.trim();
  const del = /^del:/i.test(text);
  if (del) text = text.slice(4);
  const hunk = hunkOf(text);
  if (hunk) return { ...hunk, del };
  if (del) throw new RangeError(`invalid code location "${s}": del: takes a hunk, e.g. "del:src/a.js#h3"`);
  const items = parseCodeAt(text);
  const files = [...new Set(items.map((i) => i.file))];
  if (files.length !== 1) throw new RangeError(`invalid code location "${s}": one file per "other" entry`);
  return { file: files[0], lines: items.map((i) => /** @type {[number, number]} */ ([i.startLine, i.endLine])) };
}

/**
 * '<path>#h<n>' (path quoted or not) -> { file, hunk }, else null.
 * @param {string} text
 * @returns {{ file: string, hunk: string } | null}
 */
function hunkOf(text) {
  let split;
  try {
    split = splitPath(text, HUNK_TAIL);
  } catch {
    return null;
  }
  const m = HUNK_TAIL.exec(split.rest);
  return split.path && m && m.index === 0 ? { file: split.path, hunk: m[1].toLowerCase() } : null;
}

/**
 * Whether `s` is a code `at` list (with a file on its first item).
 * @param {unknown} s
 * @returns {boolean}
 */
export function isCodeAt(s) {
  try {
    parseCodeAt(/** @type {string} */ (s));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `s` is a code `other[].at` (line location or hunk).
 * @param {unknown} s
 * @returns {boolean}
 */
export function isCodeOtherAt(s) {
  try {
    parseCodeOtherAt(/** @type {string} */ (s));
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats items back into the canonical list ('src/a.js:L12-14,L20,"a,b.js":L3'): a repeated file is written once
 * per run, a path containing ',' or starting with '"' is quoted.
 * @param {CodeAtItem[]} items
 * @returns {string}
 */
export function formatCodeAt(items) {
  /** @type {string[]} */
  const parts = [];
  let prev = null;
  for (const { file, startLine, endLine } of items) {
    const lines = endLine === startLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    parts.push(file === prev ? lines : `${quotePath(file)}:${lines}`);
    prev = file;
  }
  return parts.join(',');
}

/**
 * @param {string} file
 * @returns {string}
 */
function quotePath(file) {
  return file.includes(',') || file.startsWith('"') ? `"${file}"` : file;
}

/**
 * Splits on commas outside double quotes.
 * @param {string} s
 * @returns {string[]}
 */
function splitList(s) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quoted) throw new RangeError(`invalid code location "${s}": unbalanced double quote`);
  out.push(cur);
  return out;
}

/**
 * The path of an item and the tail after it: a quoted path ends at its closing quote, an unquoted one before the
 * LAST match of `tail`.
 * @param {string} item
 * @param {RegExp} tail
 * @returns {{ path: string, rest: string }}
 */
function splitPath(item, tail) {
  let path;
  let rest;
  if (item.startsWith('"')) {
    const close = item.indexOf('"', 1);
    if (close < 0) throw new RangeError(`invalid code location "${item}": unbalanced double quote`);
    path = item.slice(1, close);
    rest = item.slice(close + 1);
  } else {
    const m = tail.exec(item);
    if (!m) return { path: '', rest: item };
    path = item.slice(0, m.index);
    rest = item.slice(m.index);
  }
  if (!path || path.includes('\0') || /[\r\n]/.test(path)) throw new RangeError(`invalid code location "${item}": missing or invalid path`);
  return { path, rest };
}

/**
 * @param {RegExpExecArray} m [, start, end?]
 * @param {string} item
 * @returns {{ startLine: number, endLine: number }}
 */
function lineRange(m, item) {
  const startLine = Number(m[1]);
  const endLine = m[2] === undefined ? startLine : Number(m[2]);
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new RangeError(`invalid line number in "${item}": lines start at 1`);
  if (!Number.isSafeInteger(endLine) || endLine < startLine) throw new RangeError(`invalid line range "${item}": end is before start`);
  return { startLine, endLine };
}

/**
 * Matches a path as the agent wrote it against a round's file list (repo-root-relative POSIX paths): an absolute
 * path inside `root`, a repo-root-relative path, a path relative to the agent's `cwd`, else a unique suffix match
 * ('refresh.js' for 'src/auth/refresh.js'). `file` is set when exactly one file matches; otherwise `candidates`
 * lists the matches (two or more: ambiguous; none: not in the round).
 * @param {string} written
 * @param {readonly string[]} files
 * @param {{ root?: string | null, cwd?: string | null }} [opts] absolute repo root and the agent's cwd
 * @returns {{ file: string | null, candidates: string[] }}
 */
export function resolveCodePath(written, files, { root = null, cwd = null } = {}) {
  const set = new Set(files);
  const p = String(written ?? '').replace(/^(?:\.\/)+/, '');
  /** @type {Set<string>} */
  const exact = new Set();
  const rel = (/** @type {string} */ abs) => (root ? nodePath.posix.relative(toPosixAbs(root), abs) : null);
  if (nodePath.posix.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    const r = rel(toPosixAbs(p));
    if (r && !r.startsWith('..') && set.has(r)) exact.add(r);
    return exact.size ? { file: [...exact][0], candidates: [...exact] } : { file: null, candidates: [] };
  }
  if (set.has(p)) exact.add(p);
  if (root && cwd) {
    const r = rel(nodePath.posix.resolve(toPosixAbs(cwd), p));
    if (r && !r.startsWith('..') && set.has(r)) exact.add(r);
  }
  const found = exact.size ? [...exact] : files.filter((f) => f === p || f.endsWith(`/${p}`));
  const candidates = [...new Set(found)].sort();
  return { file: candidates.length === 1 ? candidates[0] : null, candidates };
}

/**
 * @param {string} p an absolute path (POSIX or Windows)
 * @returns {string} POSIX form
 */
function toPosixAbs(p) {
  return String(p).replace(/\\/g, '/');
}
