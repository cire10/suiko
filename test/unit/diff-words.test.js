// Unit tests: src/core/diff/words.js (wordDiff, hunkStats, rewriteRatio).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { wordDiff, hunkStats, rewriteRatio, lineHunks, countWords } = await import('../../src/core/diff/index.js');

test('wordDiff ops reconstruct both sides with consistent offsets', () => {
  const a = 'The client MUST retry 3 times.\n';
  const b = 'The client MUST retry up to 5 times with backoff.\n';
  const ops = wordDiff(a, b);
  let ra = '';
  let rb = '';
  for (const o of ops) {
    if (o.op !== 'ins') {
      assert.equal(a.slice(o.aStart, o.aEnd), o.text);
      ra += o.text;
    } else assert.equal(o.aStart, o.aEnd);
    if (o.op !== 'del') {
      assert.equal(b.slice(o.bStart, o.bEnd), o.text);
      rb += o.text;
    } else assert.equal(o.bStart, o.bEnd);
  }
  assert.equal(ra, a);
  assert.equal(rb, b);
  assert.deepEqual(ops.filter((o) => o.op === 'del').map((o) => o.text), ['3']);
  assert.ok(ops.some((o) => o.op === 'ins' && o.text.includes('backoff')));
});

test('wordDiff edge cases: empty sides and identical text', () => {
  assert.deepEqual(wordDiff('', ''), []);
  assert.deepEqual(wordDiff('same', 'same'), [{ op: 'eq', text: 'same', aStart: 0, aEnd: 4, bStart: 0, bEnd: 4 }]);
  assert.deepEqual(wordDiff('', 'new'), [{ op: 'ins', text: 'new', aStart: 0, aEnd: 0, bStart: 0, bEnd: 3 }]);
  assert.deepEqual(wordDiff('old', ''), [{ op: 'del', text: 'old', aStart: 0, aEnd: 3, bStart: 0, bEnd: 0 }]);
});

test('wordDiff falls back to a prefix/suffix diff for huge rewrites without stalling', () => {
  const a = Array.from({ length: 30000 }, (_, i) => `w${i}`).join(' ');
  const b = 'intro ' + Array.from({ length: 30000 }, (_, i) => `v${i}`).join(' ') + ' end';
  const t0 = performance.now();
  const ops = wordDiff(a, b);
  assert.ok(performance.now() - t0 < 5000);
  assert.equal(ops.filter((o) => o.op !== 'ins').map((o) => o.text).join(''), a);
  assert.equal(ops.filter((o) => o.op !== 'del').map((o) => o.text).join(''), b);
});

test('hunkStats reports removed/inserted chars, words and absolute changed ranges', () => {
  const a = 'intro\nRefresh tokens are rotated on every use.\noutro\n';
  const b = 'intro\nRefresh tokens are rotated after a 30 s grace window.\noutro\n';
  const [h] = lineHunks(a, b);
  const s = hunkStats(a, b, h);
  assert.ok(s.removedWords >= 2 && s.insertedWords >= 4);
  for (const [x, y] of s.changedOldRanges) assert.ok(x >= h.oldStartOff && y <= h.oldEndOff && x < y);
  for (const [x, y] of s.changedNewRanges) assert.ok(x >= h.newStartOff && y <= h.newEndOff && x < y);
  assert.equal(s.changedOldRanges.map(([x, y]) => a.slice(x, y)).join('|').includes('every'), true);
  assert.equal(s.changedNewRanges.map(([x, y]) => b.slice(x, y)).join('|').includes('grace'), true);
  assert.equal(s.removedChars, s.changedOldRanges.reduce((n, [x, y]) => n + y - x, 0));
  assert.equal(s.insertedChars, s.changedNewRanges.reduce((n, [x, y]) => n + y - x, 0));
});

test('hunkStats for pure insertions and deletions covers the whole lines', () => {
  const a = 'a\nb\n';
  const ins = lineHunks(a, 'a\nnew words here\nb\n')[0];
  const si = hunkStats(a, 'a\nnew words here\nb\n', ins);
  assert.deepEqual(si.changedNewRanges, [[2, 17]]); // 'new words here\n'
  assert.deepEqual(si.changedOldRanges, []);
  assert.equal(si.insertedWords, 3);
  assert.equal(si.removedChars, 0);
  const del = lineHunks(a, 'a\n')[0];
  const sd = hunkStats(a, 'a\n', del);
  assert.deepEqual(sd.changedOldRanges, [[2, 4]]);
  assert.equal(sd.removedWords, 1);
});

test('rewriteRatio counts removed/replaced old chars only', () => {
  const a = 'aaaa\nbbbb\ncccc\ndddd\n';
  assert.equal(rewriteRatio(a, a, []), 0);
  assert.equal(rewriteRatio(a, a + 'more\nlines\n', lineHunks(a, a + 'more\nlines\n')), 0, 'insertions excluded');
  const b = 'aaaa\nXXXX\ncccc\ndddd\n';
  assert.equal(rewriteRatio(a, b, lineHunks(a, b)), 4 / a.length);
  const all = 'totally\ndifferent\n';
  // every word replaced (the newline tokens themselves still match)
  assert.equal(rewriteRatio(a, all, lineHunks(a, all)), 18 / a.length);
  assert.equal(rewriteRatio('', 'x', lineHunks('', 'x')), 0);
});

test('countWords counts letter/digit runs', () => {
  assert.equal(countWords('Hello, world! 42 snake_case — ok'), 5);
  assert.equal(countWords('*** | ---'), 0);
});
