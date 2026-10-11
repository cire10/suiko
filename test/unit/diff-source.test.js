// Unit tests: src/core/diff/source-diff.js (sourceDiff rows with word highlights, unifiedPatch).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from 'diff';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { sourceDiff, unifiedPatch, lineHunks } = await import('../../src/core/diff/index.js');

const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('sourceDiff rows: context, numbering, word highlights on replaced lines', () => {
  const a = base.replace('line 5', 'The client MUST retry 3 times.');
  const b = base.replace('line 5', 'The client MUST retry up to 5 times.');
  const { hunks } = sourceDiff(a, b);
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.id, 'h1');
  assert.deepEqual(h.hunkIds, ['h1']);
  assert.equal(h.header, '@@ -2,7 +2,7 @@');
  assert.deepEqual(h.rows.map((r) => [r.op, r.oldNo, r.newNo]), [
    [' ', 2, 2], [' ', 3, 3], [' ', 4, 4], ['-', 5, null], ['+', null, 5], [' ', 6, 6], [' ', 7, 7], [' ', 8, 8],
  ]);
  const del = h.rows[3];
  const ins = h.rows[4];
  assert.equal(del.hunk, 'h1');
  assert.deepEqual(del.words.map(([s, e, k]) => [del.text.slice(s, e), k]), [['3', 'del']]);
  assert.deepEqual(ins.words.map(([s, e, k]) => [ins.text.slice(s, e), k]), [['up', 'ins'], ['to 5 ', 'ins']]);
  assert.deepEqual(h.rows[0].words, []);
});

test('sourceDiff groups nearby hunks and splits distant ones', () => {
  const lines = base.split('\n');
  lines[2] = 'changed 3';
  lines[6] = 'changed 7';
  lines[18] = 'changed 19';
  const b = lines.join('\n');
  const { hunks } = sourceDiff(base, b, { context: 2 });
  assert.deepEqual(hunks.map((h) => h.hunkIds), [['h1', 'h2'], ['h3']]);
  assert.equal(hunks[0].id, 'h1');
  assert.equal(hunks[1].header, '@@ -17,4 +17,4 @@');
  const zero = sourceDiff(base, b, { context: 0 });
  assert.equal(zero.hunks.length, 3);
  assert.equal(zero.hunks[0].rows.length, 2);
});

test('sourceDiff: pure insertion/deletion rows, CRLF text and dissimilar replacements', () => {
  const ins = sourceDiff('a\nb\n', 'a\nnew\nb\n', { context: 1 });
  assert.deepEqual(ins.hunks[0].rows.map((r) => [r.op, r.oldNo, r.newNo, r.text]), [[' ', 1, 1, 'a'], ['+', null, 2, 'new'], [' ', 2, 3, 'b']]);
  assert.equal(ins.hunks[0].header, '@@ -1,2 +1,3 @@');
  const del = sourceDiff('a\nb\nc\n', 'a\nc\n', { context: 0 });
  assert.equal(del.hunks[0].header, '@@ -2 +1,0 @@');
  assert.deepEqual(del.hunks[0].rows.map((r) => [r.op, r.oldNo, r.newNo]), [['-', 2, null]]);
  const crlf = sourceDiff('x\r\ny\r\n', 'x\r\nz\r\n');
  assert.deepEqual(crlf.hunks[0].rows.map((r) => r.text), ['x', 'y', 'z']);
  const dissimilar = sourceDiff('alpha beta gamma\n', 'one two three\n');
  assert.ok(dissimilar.hunks[0].rows.every((r) => r.words.length === 0));
  assert.deepEqual(sourceDiff('same\n', 'same\n'), { hunks: [] });
});

test('sourceDiff ids match lineHunks ids', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';
  const b = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n';
  const ids = lineHunks(a, b).map((h) => h.id);
  const shown = sourceDiff(a, b, { context: 1 }).hunks.flatMap((h) => h.rows.filter((r) => r.hunk).map((r) => r.hunk));
  assert.deepEqual([...new Set(shown)], ids);
});

test('unifiedPatch output applies cleanly with jsdiff (incl. missing final newline)', () => {
  const cases = [
    [base, base.replace('line 7', 'line seven').replace('line 15\n', '')],
    ['a\nb', 'a\nb\nc'],
    ['a\nb\n', 'a\nB'],
    ['', 'new file\n'],
    ['old file\n', ''],
    ['x\r\ny\r\n', 'x\r\nz\r\n'],
  ];
  for (const [a, b] of cases) {
    const patch = unifiedPatch(a, b, { fromLabel: 'a/spec.md', toLabel: 'b/spec.md' });
    assert.ok(patch.startsWith('--- a/spec.md\n+++ b/spec.md\n@@ '), patch);
    assert.equal(applyPatch(a, patch), b, `patch applies: ${JSON.stringify(patch)}`);
  }
  assert.equal(unifiedPatch('same', 'same'), '');
  const p = unifiedPatch('a\nb', 'a\nc');
  assert.match(p, /-b\n\\ No newline at end of file\n\+c\n\\ No newline at end of file\n$/);
});
