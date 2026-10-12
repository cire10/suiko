// @ts-check
// Unit tests (node:test) for the code-review view's pure helpers, src/ui/components/kinds/code-model.js: file
// statuses, the tree and its filter, display-hunk geometry (the collapsed unchanged lines), split-view pairing,
// word segments, line selections and where threads and drafts sit. No browser:  node --test test/e2e/code-model.test.mjs
// (Playwright only picks up *.spec.mjs.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseName, buildTree, coveredLines, diffGaps, fileStatus, formatBytes, gapRows, gapSize, hunkFile, hunkSpan, isStub,
  itemsByEndLine, itemsByFile, markerKey, matchesFilter, nextSelection, openCounts, outsideReview, selectionCapture, selectionLabel,
  splitPairs, stubText, treeOrder, wordSegments,
} from '../../src/ui/components/kinds/code-model.js';

test('fileStatus: file statuses and interdiff changes map to a letter, a label and a tone', () => {
  assert.deepEqual(fileStatus('A'), { letter: 'A', label: 'added', tone: 'ok' });
  assert.deepEqual(fileStatus('D'), { letter: 'D', label: 'deleted', tone: 'danger' });
  assert.deepEqual(fileStatus('R'), { letter: 'R', label: 'renamed', tone: 'info' });
  assert.equal(fileStatus('=').label, 'unchanged');
  assert.deepEqual(fileStatus('changed'), { letter: 'M', label: 'changed since', tone: 'warn' });
  assert.deepEqual(fileStatus('dropped'), { letter: 'D', label: 'dropped since', tone: 'danger' });
  assert.equal(fileStatus('added').letter, 'A');
  assert.equal(fileStatus('').letter, 'M');
});

test('stubs: binary and too-large files have placeholders', () => {
  assert.equal(isStub({ path: 'a.png', binary: true }), true);
  assert.equal(isStub({ path: 'big.json', tooLarge: { side: 'new', bytes: 9 } }), true);
  assert.equal(isStub({ path: 'a.js' }), false);
  assert.equal(stubText({ binary: true }), 'Binary file not shown.');
  assert.equal(stubText({ tooLarge: { side: 'new', bytes: 6 * 1024 * 1024 } }), 'File too large to show (6.0 MB).');
  assert.equal(stubText({}, 'submodule'), 'Submodule change not shown.');
  assert.equal(stubText({}), 'No diff to show.');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
});

test('outsideReview: skipped entries of files that are in the round (binary, too large) are not outside it', () => {
  const files = [{ path: 'a.png', binary: true }, { path: 'src/a.js' }];
  const skipped = [{ path: '.env', reason: 'excluded' }, { path: 'a.png', reason: 'binary' }];
  assert.deepEqual(outsideReview(files, skipped), [{ path: '.env', reason: 'excluded' }]);
  assert.deepEqual(outsideReview(files, undefined), []);
});

test('matchesFilter: every term is a case-insensitive substring of the path or the old path', () => {
  const f = { path: 'src/util/Strings.js', oldPath: 'lib/format.js' };
  assert.equal(matchesFilter(f, ''), true);
  assert.equal(matchesFilter(f, 'strings'), true);
  assert.equal(matchesFilter(f, 'util  .js'), true);
  assert.equal(matchesFilter(f, 'format'), true);
  assert.equal(matchesFilter(f, 'util test'), false);
});

test('buildTree: directories first, sorted, single-child directories compacted; treeOrder follows it', () => {
  const files = [
    { path: 'src/b.js' }, { path: 'README.md' }, { path: 'src/util/strings.js' }, { path: 'src/A.js' },
    { path: 'deep/one/two/x.js' },
  ];
  const tree = buildTree(files);
  assert.deepEqual(tree.map((n) => [n.type, n.name]), [['dir', 'deep/one/two'], ['dir', 'src'], ['file', 'README.md']]);
  const src = /** @type {any} */ (tree[1]);
  assert.deepEqual(src.children.map((/** @type {any} */ n) => [n.type, n.name, n.path]),
    [['dir', 'util', 'src/util'], ['file', 'A.js', 'src/A.js'], ['file', 'b.js', 'src/b.js']]);
  assert.deepEqual(treeOrder(tree).map((f) => f.path), ['deep/one/two/x.js', 'src/util/strings.js', 'src/A.js', 'src/b.js', 'README.md']);
  assert.equal(baseName('src/util/strings.js'), 'strings.js');
  assert.equal(baseName('top'), 'top');
});

test('hunkSpan: from the unified header, a count of 0 naming the line before', () => {
  assert.deepEqual(hunkSpan({ header: '@@ -2,15 +2,14 @@' }), { oldFirst: 2, oldAfter: 17, newFirst: 2, newAfter: 16 });
  assert.deepEqual(hunkSpan({ header: '@@ -0,0 +1,8 @@' }), { oldFirst: 1, oldAfter: 1, newFirst: 1, newAfter: 9 });
  assert.deepEqual(hunkSpan({ header: '@@ -5 +5 @@' }), { oldFirst: 5, oldAfter: 6, newFirst: 5, newAfter: 6 });
  // no header: from the rows
  const rows = [{ op: ' ', oldNo: 3, newNo: 4 }, { op: '-', oldNo: 4, newNo: null }, { op: '+', oldNo: null, newNo: 5 }];
  assert.deepEqual(hunkSpan({ rows }), { oldFirst: 3, oldAfter: 5, newFirst: 4, newAfter: 6 });
});

test('diffGaps: unchanged lines before, between and after hunks, with the old/new offset', () => {
  const hunks = [{ header: '@@ -2,15 +2,14 @@' }, { header: '@@ -34,5 +33,6 @@' }];
  const gaps = diffGaps(hunks, { status: 'M' });
  assert.deepEqual(gaps, [
    { id: 'g0', before: 0, newStart: 1, newEnd: 1, delta: 0 },
    { id: 'g1', before: 1, newStart: 16, newEnd: 32, delta: 1 },
    { id: 'g2', before: 2, newStart: 39, newEnd: null, delta: 0 },
  ]);
  // an added file is all in its hunk: no trailing gap
  assert.deepEqual(diffGaps([{ header: '@@ -0,0 +1,3 @@' }], { status: 'A' }), []);
  // an unchanged file is one gap
  assert.deepEqual(diffGaps([], { status: '=' }), [{ id: 'g0', before: 0, newStart: 1, newEnd: null, delta: 0 }]);

  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const rows = gapRows(gaps[1], lines);
  assert.equal(rows.length, 17);
  assert.deepEqual(rows[0], { op: ' ', oldNo: 17, newNo: 16, text: 'line 16', words: [] });
  assert.equal(gapRows(gaps[2], lines).length, 2);
  assert.equal(gapSize(gaps[1]), 17);
  assert.equal(gapSize(gaps[2]), null);
  assert.equal(gapSize(gaps[2], 40), 2);
});

test('splitPairs: deletions pair with the additions after them; context sits on both sides', () => {
  const r = (/** @type {string} */ op, /** @type {number} */ n) => ({ op, n });
  const pairs = splitPairs([r(' ', 1), r('-', 2), r('-', 3), r('+', 4), r(' ', 5), r('+', 6), r('-', 7)]);
  assert.deepEqual(pairs.map((p) => [p.left?.n ?? null, p.right?.n ?? null]), [[1, 1], [2, 4], [3, null], [5, 5], [null, 6], [7, null]]);
});

test('wordSegments: splits a line at its word ranges, clamped to the text', () => {
  assert.deepEqual(wordSegments('let a = 1;', []), [{ text: 'let a = 1;', kind: '' }]);
  assert.deepEqual(wordSegments('let a = 12;', [[8, 10, 'ins']]), [
    { text: 'let a = ', kind: '' }, { text: '12', kind: 'ins' }, { text: ';', kind: '' },
  ]);
  assert.deepEqual(wordSegments('abc', [[2, 99, 'del'], [0, 1, 'del']]), [
    { text: 'a', kind: 'del' }, { text: 'b', kind: '' }, { text: 'c', kind: 'del' },
  ]);
});

test('line selection: click selects, shift-click extends on the same file and side, a second click clears', () => {
  let sel = nextSelection(null, { file: 'a.js', side: 'new', line: 5 });
  assert.deepEqual(sel, { file: 'a.js', side: 'new', anchor: 5, start: 5, end: 5 });
  sel = nextSelection(sel, { file: 'a.js', side: 'new', line: 3, shift: true });
  assert.deepEqual(sel, { file: 'a.js', side: 'new', anchor: 5, start: 3, end: 5 });
  sel = nextSelection(sel, { file: 'a.js', side: 'new', line: 8, shift: true });
  assert.deepEqual([sel?.start, sel?.end], [5, 8]);
  // shift-click on the other side starts a new selection there
  sel = nextSelection(sel, { file: 'a.js', side: 'old', line: 2, shift: true });
  assert.deepEqual(sel, { file: 'a.js', side: 'old', anchor: 2, start: 2, end: 2 });
  assert.equal(nextSelection(sel, { file: 'a.js', side: 'old', line: 2 }), null);
  assert.deepEqual(selectionCapture({ file: 'a.js', side: 'old', anchor: 2, start: 2, end: 4 }),
    { kind: 'line', file: 'a.js', side: 'old', startLine: 2, endLine: 4 });
  assert.equal(selectionCapture(null), null);
  assert.equal(selectionLabel({ file: 'a.js', side: 'new', anchor: 3, start: 3, end: 4 }), 'a.js:L3-4');
  assert.equal(selectionLabel({ file: 'a.js', side: 'old', anchor: 3, start: 3, end: 3 }), 'a.js (old side) L3');
  assert.equal(markerKey('a.js', 'new', 7), 'a.js:new:7');
});

test('threads and drafts by file: line items with side and lines, whole-file items, drafts of the round only', () => {
  const line = (/** @type {number} */ v, /** @type {string} */ path, /** @type {'new'|'old'} */ side, /** @type {number} */ s, /** @type {number} */ e) => ({
    v, kind: 'source', mappedBy: 'lines', section: [path], src: { startLine: s, endLine: e, text: 'x' }, file: { path, side },
  });
  const ds = {
    threads: [
      { id: 't2', status: 'open', createdIn: 1, anchors: { 1: line(1, 'a.js', 'old', 13, 13) } },
      { id: 't1', status: 'open', createdIn: 1, anchors: { 1: line(1, 'a.js', 'new', 5, 6), 2: line(2, 'a.js', 'new', 5, 7) } },
      { id: 't4', status: 'resolved', createdIn: 1, anchors: { 1: { v: 1, kind: 'doc', file: { path: 'logo.png', side: 'new' } } } },
      { id: 't5', status: 'open', createdIn: 1, anchors: { 1: { v: 1, kind: 'doc' } } },
      { id: 't9', status: 'open', createdIn: 3, anchors: { 3: line(3, 'a.js', 'new', 1, 1) } },
    ],
    drafts: { items: [
      { id: 'd1', kind: 'thread', anchor: line(2, 'b.js', 'new', 2, 2) },
      { id: 'd2', kind: 'thread', anchor: line(1, 'b.js', 'new', 9, 9) },
      { id: 'd3', kind: 'reply', thread: 't1', anchor: null },
    ] },
  };
  const at2 = itemsByFile(ds, 2);
  assert.deepEqual([...at2.keys()].sort(), ['a.js', 'b.js', 'logo.png']);
  const a = /** @type {any[]} */ (at2.get('a.js'));
  assert.deepEqual(a.map((it) => [it.id, it.kind, it.side, it.start, it.end, it.whole]), [
    ['t1', 'thread', 'new', 5, 7, false],
    ['t2', 'thread', 'old', 13, 13, false],
  ]);
  assert.deepEqual(at2.get('logo.png')?.map((it) => [it.id, it.whole, it.start]), [['t4', true, null]]);
  assert.deepEqual(at2.get('b.js')?.map((it) => it.id), ['d1']);
  assert.deepEqual(itemsByFile(ds, 1).get('b.js')?.map((it) => it.id), ['d2']);
  assert.deepEqual(itemsByFile(ds, 1).get('a.js')?.map((it) => [it.id, it.end]), [['t1', 6], ['t2', 13]]);

  assert.deepEqual([...openCounts(ds, 2)], [['a.js', 2]]);
  assert.deepEqual([...openCounts(ds, 3)].sort(), [['a.js', 3]]);

  const ends = itemsByEndLine(a);
  assert.deepEqual([...ends.keys()], ['new:7', 'old:13']);
  const covered = coveredLines(a);
  assert.deepEqual(covered.get('new:5'), ['t1']);
  assert.deepEqual(covered.get('new:6'), []);
  assert.equal(covered.has('new:8'), false);
  assert.deepEqual(covered.get('old:13'), ['t2']);
});

test('hunkFile: the path of a hunk id', () => {
  assert.equal(hunkFile('src/a.js#h3'), 'src/a.js');
  assert.equal(hunkFile('dir#h/x.js#h12'), 'dir#h/x.js');
  assert.equal(hunkFile('nohunk'), null);
  assert.equal(hunkFile(null), null);
});
