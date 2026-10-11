// @ts-check
// Pure helpers of the code-review view (doc kind 'code'): the file tree, filters, display-hunk geometry (the
// collapsed unchanged lines between hunks), split-view row pairing, line selections and where threads sit.
// No DOM and no imports beyond model.js, so test/e2e/code-model.test.mjs runs them in Node.
//
// Shapes are the frozen ones of code-contracts.md: CodeFile (D/files?v=N), interdiff files (D/files?from&to),
// DisplayHunk & {threads} (D/files/diff), line anchors {kind:'source', src:{startLine,endLine}, file:{path, side}}.

import { anchorAt, draftVersion } from '../../model.js';

/** Rows of one file card above this are behind "Show all" (a generated file can have tens of thousands). */
export const ROW_CAP = 3000;

const STATUS = Object.freeze({
  A: { label: 'added', tone: 'ok' },
  M: { label: 'modified', tone: 'warn' },
  D: { label: 'deleted', tone: 'danger' },
  R: { label: 'renamed', tone: 'info' },
  T: { label: 'type changed', tone: 'muted' },
  '=': { label: 'unchanged', tone: 'muted' },
});

/**
 * Letter, label and tone of a file status ('A'|'M'|'D'|'R'|'T'|'=') or of an interdiff change
 * ('changed'|'added'|'dropped'|'renamed').
 * @param {string} status
 * @returns {{ letter: string, label: string, tone: string }}
 */
export function fileStatus(status) {
  const letter = ({ changed: 'M', added: 'A', dropped: 'D', renamed: 'R' })[/** @type {'changed'} */ (status)] || status || 'M';
  const s = STATUS[/** @type {'A'} */ (letter)] || STATUS.M;
  const label = ({ changed: 'changed since', added: 'new since', dropped: 'dropped since', renamed: 'renamed since' })[/** @type {'changed'} */ (status)] || s.label;
  return { letter, label, tone: s.tone };
}

/** A file without a text diff: binary, too large, or a stub the diff route reported. @param {any} f */
export function isStub(f) {
  return !!(f && (f.binary || f.tooLarge || f.stub));
}

/** Why a file has no diff, for its placeholder. @param {any} f @param {string|null|undefined} [stub] */
export function stubText(f, stub) {
  const why = stub || (f?.binary ? 'binary' : f?.tooLarge ? 'too-large' : '');
  if (why === 'binary') return 'Binary file not shown.';
  if (why === 'too-large') {
    const bytes = f?.tooLarge?.bytes;
    return `File too large to show${bytes ? ` (${formatBytes(bytes)})` : ''}.`;
  }
  if (why === 'submodule') return 'Submodule change not shown.';
  if (why === 'excluded') return 'Excluded from the review.';
  if (why === 'unsupported-name') return 'File name not supported.';
  return 'No diff to show.';
}

/** @param {number} n */
export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * Whether a file matches the tree filter: every whitespace-separated term is a case-insensitive substring of the
 * path (or the old path of a rename).
 * @param {{ path: string, oldPath?: string }} f
 * @param {string} filter
 */
export function matchesFilter(f, filter) {
  const terms = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${f.path}\n${f.oldPath || ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * @typedef {{ type: 'dir', name: string, path: string, children: TreeNode[] }
 *   | { type: 'file', name: string, path: string, file: any }} TreeNode
 */

/**
 * The file tree: directories first, then files, each sorted by name; a directory with a single child directory is
 * compacted into one row ('src/util').
 * @param {any[]} files objects with `path`
 * @returns {TreeNode[]}
 */
export function buildTree(files) {
  /** @type {{ dirs: Map<string, any>, files: any[] }} */
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = String(f.path).split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push(f);
  }
  /** @param {any} node @param {string} prefix @returns {TreeNode[]} */
  const walk = (node, prefix) => {
    /** @type {TreeNode[]} */
    const out = [];
    for (const name of [...node.dirs.keys()].sort(byName)) {
      let n = node.dirs.get(name);
      let label = name;
      while (n.files.length === 0 && n.dirs.size === 1) {
        const [only] = n.dirs.keys();
        label = `${label}/${only}`;
        n = n.dirs.get(only);
      }
      const path = prefix ? `${prefix}/${label}` : label;
      out.push({ type: 'dir', name: label, path, children: walk(n, path) });
    }
    for (const f of [...node.files].sort((a, b) => byName(baseName(a.path), baseName(b.path)))) {
      out.push({ type: 'file', name: baseName(f.path), path: f.path, file: f });
    }
    return out;
  };
  return walk(root, '');
}

/** The files in tree order (what j / k and the center column follow). @param {TreeNode[]} tree @returns {any[]} */
export function treeOrder(tree) {
  /** @type {any[]} */
  const out = [];
  /** @param {TreeNode[]} nodes */
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'dir') walk(n.children);
      else out.push(n.file);
    }
  };
  walk(tree);
  return out;
}

/** @param {string} a @param {string} b */
const byName = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** @param {string} p */
export function baseName(p) {
  const s = String(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

// ------------------------------------------------------------------------------------------------ hunk geometry

/**
 * The line ranges of a display hunk: first line and the first line after it, on each side. From the unified header
 * ('@@ -a,b +c,d @@', a count of 0 names the line before), else from the rows.
 * @param {{ header?: string, rows?: any[] }} h
 * @returns {{ oldFirst: number, oldAfter: number, newFirst: number, newAfter: number }}
 */
export function hunkSpan(h) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(String(h?.header || ''));
  if (m) {
    const [a, b, c, d] = [Number(m[1]), m[2] == null ? 1 : Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])];
    const oldFirst = b === 0 ? a + 1 : a;
    const newFirst = d === 0 ? c + 1 : c;
    return { oldFirst, oldAfter: oldFirst + b, newFirst, newAfter: newFirst + d };
  }
  const rows = h?.rows || [];
  const olds = rows.map((r) => r.oldNo).filter((n) => n != null);
  const news = rows.map((r) => r.newNo).filter((n) => n != null);
  const oldFirst = olds.length ? Math.min(...olds) : 1;
  const newFirst = news.length ? Math.min(...news) : 1;
  return {
    oldFirst, oldAfter: olds.length ? Math.max(...olds) + 1 : oldFirst,
    newFirst, newAfter: news.length ? Math.max(...news) + 1 : newFirst,
  };
}

/**
 * @typedef {{ id: string, before: number, newStart: number, newEnd: number|null, delta: number }} Gap
 *   before: index of the hunk the gap precedes (hunks.length = after the last hunk); new-side lines
 *   newStart..newEnd (null = to the end of the file, unknown until the source is loaded); delta = old - new line
 *   number for these unchanged lines.
 */

/**
 * The unchanged lines a diff does not show: before each hunk and, unless the file is added or deleted (all of it
 * is in the hunks), after the last one. A file with no hunks (status '=') is a single gap.
 * @param {any[]} hunks
 * @param {{ status?: string }} [opts]
 * @returns {Gap[]}
 */
export function diffGaps(hunks, opts = {}) {
  /** @type {Gap[]} */
  const out = [];
  let oldAfter = 1;
  let newAfter = 1;
  hunks.forEach((h, i) => {
    const s = hunkSpan(h);
    if (s.newFirst > newAfter) out.push({ id: `g${i}`, before: i, newStart: newAfter, newEnd: s.newFirst - 1, delta: oldAfter - newAfter });
    oldAfter = s.oldAfter;
    newAfter = s.newAfter;
  });
  if (opts.status !== 'A' && opts.status !== 'D') {
    out.push({ id: `g${hunks.length}`, before: hunks.length, newStart: newAfter, newEnd: null, delta: oldAfter - newAfter });
  }
  return out;
}

/**
 * Rows for the revealed part of a gap from the new-side source lines (unchanged lines are the same on both sides).
 * @param {Gap} gap @param {string[]} lines new-side lines of the file
 * @returns {Array<{ op: ' ', oldNo: number, newNo: number, text: string, words: [] }>}
 */
export function gapRows(gap, lines) {
  const end = Math.min(gap.newEnd ?? lines.length, lines.length);
  const out = [];
  for (let n = gap.newStart; n <= end; n++) out.push({ op: /** @type {' '} */ (' '), oldNo: n + gap.delta, newNo: n, text: lines[n - 1] ?? '', words: /** @type {[]} */ ([]) });
  return out;
}

/** Number of lines in a gap, or null when it runs to an unknown end of file. @param {Gap} gap @param {number|null} [total] */
export function gapSize(gap, total = null) {
  const end = gap.newEnd ?? total;
  return end == null ? null : Math.max(0, end - gap.newStart + 1);
}

/**
 * Split view: '-' runs pair with the '+' runs that follow them; context rows sit on both sides.
 * @param {any[]} rows
 * @returns {Array<{ left: any|null, right: any|null }>}
 */
export function splitPairs(rows) {
  /** @type {Array<{ left: any|null, right: any|null }>} */
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.op === ' ') {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].op === '-') dels.push(rows[i++]);
    while (i < rows.length && rows[i].op === '+') adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return out;
}

/**
 * Splits a row's text at its word ranges into plain / ins / del segments (text nodes only).
 * @param {string} text @param {Array<[number, number, string]>} [words]
 * @returns {Array<{ text: string, kind: ''|'ins'|'del' }>}
 */
export function wordSegments(text, words) {
  const t = String(text ?? '');
  if (!words?.length) return [{ text: t, kind: '' }];
  /** @type {Array<{ text: string, kind: ''|'ins'|'del' }>} */
  const out = [];
  let at = 0;
  for (const [s, e, kind] of [...words].sort((a, b) => a[0] - b[0])) {
    const a = Math.max(at, Math.min(t.length, s));
    const b = Math.max(a, Math.min(t.length, e));
    if (a > at) out.push({ text: t.slice(at, a), kind: '' });
    if (b > a) out.push({ text: t.slice(a, b), kind: kind === 'del' ? 'del' : 'ins' });
    at = b;
  }
  if (at < t.length) out.push({ text: t.slice(at), kind: '' });
  return out;
}

// ------------------------------------------------------------------------------------------------ selection

/**
 * @typedef {{ file: string, side: 'new'|'old', anchor: number, start: number, end: number }} LineSel
 */

/**
 * The selection after a click on a line number: a plain click selects the line (or clears a one-line selection of
 * the same line); a shift-click extends a selection on the same file and side.
 * @param {LineSel|null} sel
 * @param {{ file: string, side: 'new'|'old', line: number, shift?: boolean }} click
 * @returns {LineSel|null}
 */
export function nextSelection(sel, click) {
  const same = sel && sel.file === click.file && sel.side === click.side;
  if (click.shift && same && sel) {
    return { ...sel, start: Math.min(sel.anchor, click.line), end: Math.max(sel.anchor, click.line) };
  }
  if (same && sel && sel.start === click.line && sel.end === click.line) return null;
  return { file: click.file, side: click.side, anchor: click.line, start: click.line, end: click.line };
}

/** The capture of a selection (code-contracts.md section 1). @param {LineSel|null} sel */
export function selectionCapture(sel) {
  if (!sel) return null;
  return { kind: 'line', file: sel.file, side: sel.side, startLine: sel.start, endLine: sel.end };
}

/** 'src/a.js:L3-4' | 'src/a.js (old side) L3'. @param {LineSel|null} sel */
export function selectionLabel(sel) {
  if (!sel) return '';
  const lines = sel.start === sel.end ? `L${sel.start}` : `L${sel.start}-${sel.end}`;
  return sel.side === 'old' ? `${sel.file} (old side) ${lines}` : `${sel.file}:${lines}`;
}

/** Marker key of one line (code-contracts.md 12): `${file}:${side}:${line}`. @param {string} file @param {string} side @param {number} line */
export function markerKey(file, side, line) {
  return `${file}:${side}:${line}`;
}

// ------------------------------------------------------------------------------------------------ threads

/**
 * @typedef {{ id: string, kind: 'thread'|'draft', item: any, anchor: any, side: 'new'|'old'|null,
 *   start: number|null, end: number|null, whole: boolean }} PlacedItem
 */

/**
 * Threads and new-thread drafts of one round, by file: line items (a side and lines) and whole-file items. A thread
 * shows from the round it was created in; a draft only on the round it was written on (drafts are not carried).
 * Whole-review items (no file) are left to the side panel.
 * @param {any} ds DocState
 * @param {number} v
 * @returns {Map<string, PlacedItem[]>}
 */
export function itemsByFile(ds, v) {
  /** @type {Map<string, PlacedItem[]>} */
  const out = new Map();
  /** @param {string} id @param {'thread'|'draft'} kind @param {any} item @param {any} a */
  const add = (id, kind, item, a) => {
    if (!a?.file?.path) return;
    const whole = a.kind === 'doc' || !a.src || !(Number(a.src.startLine) > 0);
    const placed = {
      id, kind, item, anchor: a, side: a.file.side === 'old' ? /** @type {const} */ ('old') : /** @type {const} */ ('new'),
      start: whole ? null : Number(a.src.startLine), end: whole ? null : Number(a.src.endLine || a.src.startLine), whole,
    };
    if (!out.has(a.file.path)) out.set(a.file.path, []);
    out.get(a.file.path)?.push(placed);
  };
  for (const t of ds?.threads || []) {
    if (Number(t.createdIn) > v) continue;
    add(t.id, 'thread', t, anchorAt(t, v));
  }
  for (const d of ds?.drafts?.items || []) {
    if (d.kind !== 'thread' || !d.anchor) continue;
    if (draftVersion(d) !== v) continue;
    add(d.id, 'draft', d, d.anchor);
  }
  for (const list of out.values()) list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || idNum(a.id) - idNum(b.id));
  return out;
}

/** @param {string} id */
const idNum = (id) => Number(String(id).replace(/^\D+/, '')) || 0;

/**
 * Open (not resolved) thread count per file path at round v, for the tree badges.
 * @param {any} ds @param {number} v
 * @returns {Map<string, number>}
 */
export function openCounts(ds, v) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const t of ds?.threads || []) {
    if (t.status === 'resolved' || Number(t.createdIn) > v) continue;
    const p = anchorAt(t, v)?.file?.path;
    if (p) out.set(p, (out.get(p) || 0) + 1);
  }
  return out;
}

/**
 * Which placed items end on each line of a side (they render under that row), keyed `${side}:${line}`.
 * @param {PlacedItem[]} items
 * @returns {Map<string, PlacedItem[]>}
 */
export function itemsByEndLine(items) {
  /** @type {Map<string, PlacedItem[]>} */
  const out = new Map();
  for (const it of items) {
    if (it.whole || it.end == null) continue;
    const k = `${it.side}:${it.end}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k)?.push(it);
  }
  return out;
}

/**
 * Lines covered by items, keyed `${side}:${line}` -> the ids starting there (for the gutter marker) or [] for
 * covered lines that are not a start.
 * @param {PlacedItem[]} items
 * @returns {Map<string, string[]>}
 */
export function coveredLines(items) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const it of items) {
    if (it.whole || it.start == null || it.end == null) continue;
    for (let n = it.start; n <= Math.min(it.end, it.start + 2000); n++) {
      const k = `${it.side}:${n}`;
      if (!out.has(k)) out.set(k, []);
      if (n === it.start) out.get(k)?.push(it.id);
    }
  }
  return out;
}

/**
 * The file a hunk id belongs to ('src/a.js#h3' -> 'src/a.js'), or null.
 * @param {string|null|undefined} id
 */
export function hunkFile(id) {
  const s = String(id || '');
  const i = s.lastIndexOf('#h');
  return i > 0 ? s.slice(0, i) : null;
}
