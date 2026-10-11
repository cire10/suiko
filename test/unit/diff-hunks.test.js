// Unit tests: src/core/diff/hunks.js (lineHunks) and offsets.js (offsetMapper).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredPatch } from 'diff';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { lineHunks, offsetMapper } = await import('../../src/core/diff/index.js');

/** Strip ids/offsets for compact comparisons. */
const shape = (hs) => hs.map((h) => [h.id, h.oldStart, h.oldLines, h.newStart, h.newLines]);

/** Every hunk's char ranges must cover exactly its whole lines, and unchanged text must line up. */
function checkInvariants(a, b, hs) {
  const aLines = a.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bLines = b.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const h of hs) {
    assert.equal(a.slice(h.oldStartOff, h.oldEndOff), aLines.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines).join(''));
    assert.equal(b.slice(h.newStartOff, h.newEndOff), bLines.slice(h.newStart - 1, h.newStart - 1 + h.newLines).join(''));
  }
  // rebuilding b from a by replacing each hunk gives b
  let out = '';
  let last = 0;
  for (const h of hs) {
    out += a.slice(last, h.oldStartOff) + b.slice(h.newStartOff, h.newEndOff);
    last = h.oldEndOff;
  }
  assert.equal(out + a.slice(last), b);
}

test('identical texts have no hunks', () => {
  assert.deepEqual(lineHunks('a\nb\n', 'a\nb\n'), []);
  assert.deepEqual(lineHunks('', ''), []);
});

test('modification, ids in file order, matches jsdiff structuredPatch line counts', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\n';
  const b = 'one\nTWO\nthree\nfour\nFIVE\nsix\n';
  const hs = lineHunks(a, b);
  assert.deepEqual(shape(hs), [['h1', 2, 1, 2, 1], ['h2', 5, 1, 5, 2]]);
  const sp = structuredPatch('a', 'b', a, b, '', '', { context: 0 });
  assert.deepEqual(sp.hunks.map((h) => [h.oldLines, h.newLines]), hs.map((h) => [h.oldLines, h.newLines]));
  checkInvariants(a, b, hs);
  assert.deepEqual(lineHunks(a, b), hs, 'deterministic');
});

test('pure insertion: oldLines 0 and oldStart = the old line it is inserted before', () => {
  const a = 'a\nb\nc\n';
  const b = 'a\nX\nY\nb\nc\n';
  const hs = lineHunks(a, b);
  assert.deepEqual(shape(hs), [['h1', 2, 0, 2, 2]]);
  assert.equal(hs[0].oldStartOff, hs[0].oldEndOff);
  assert.equal(hs[0].oldStartOff, 2);
  checkInvariants(a, b, hs);
  // at the very start and end
  assert.deepEqual(shape(lineHunks('a\n', 'Z\na\n')), [['h1', 1, 0, 1, 1]]);
  assert.deepEqual(shape(lineHunks('a\n', 'a\nZ\n')), [['h1', 2, 0, 2, 1]]);
  assert.deepEqual(shape(lineHunks('', 'x\ny\n')), [['h1', 1, 0, 1, 2]]);
});

test('pure deletion: newLines 0 and newStart = the new line now at the deletion point', () => {
  const a = 'a\nb\nc\nd\n';
  const b = 'a\nd\n';
  const hs = lineHunks(a, b);
  assert.deepEqual(shape(hs), [['h1', 2, 2, 2, 0]]);
  assert.equal(hs[0].newStartOff, hs[0].newEndOff);
  assert.equal(hs[0].newStartOff, 2);
  checkInvariants(a, b, hs);
  assert.deepEqual(shape(lineHunks('a\nb\n', 'a\n')), [['h1', 2, 1, 2, 0]]);
  assert.deepEqual(shape(lineHunks('x\n', '')), [['h1', 1, 1, 1, 0]]);
});

test('EOF without newline: adding or removing the final newline changes the last line', () => {
  const hs = lineHunks('a\nb', 'a\nb\n');
  assert.deepEqual(shape(hs), [['h1', 2, 1, 2, 1]]);
  checkInvariants('a\nb', 'a\nb\n', hs);
  const hs2 = lineHunks('a\nb', 'a\nb\nc');
  assert.deepEqual(shape(hs2), [['h1', 2, 1, 2, 2]]);
  checkInvariants('a\nb', 'a\nb\nc', hs2);
  const hs3 = lineHunks('a\nb\n', 'a\nc');
  assert.equal(hs3[0].oldEndOff, 4);
  assert.equal(hs3[0].newEndOff, 3);
  checkInvariants('a\nb\n', 'a\nc', hs3);
});

test('CRLF: \\r belongs to its line; offsets cover the CRLF terminators', () => {
  const a = 'one\r\ntwo\r\nthree\r\n';
  const b = 'one\r\n2\r\nthree\r\n';
  const hs = lineHunks(a, b);
  assert.deepEqual(shape(hs), [['h1', 2, 1, 2, 1]]);
  assert.equal(a.slice(hs[0].oldStartOff, hs[0].oldEndOff), 'two\r\n');
  checkInvariants(a, b, hs);
  // switching line endings changes every line
  assert.deepEqual(shape(lineHunks('a\nb\n', 'a\r\nb\r\n')), [['h1', 1, 2, 1, 2]]);
});

test('offsetMapper: unchanged regions shift, offsets inside hunks map to the hunk start', () => {
  const a = 'keep\nold line\nkeep2\ntail\n';
  const b = 'keep\nnew longer line\nadded\nkeep2\ntail\n';
  const hs = lineHunks(a, b);
  const m = offsetMapper(a, b, hs);
  assert.deepEqual(m.mapOffset(0), { off: 0, hunk: null });
  const k2 = a.indexOf('keep2');
  assert.deepEqual(m.mapOffset(k2), { off: b.indexOf('keep2'), hunk: null });
  const inside = m.mapOffset(a.indexOf('line'));
  assert.equal(inside.off, b.indexOf('new longer'));
  assert.equal(inside.hunk.id, 'h1');
  assert.equal(m.mapOffset(a.length).off, b.length);
  assert.deepEqual(m.mapLine(1), { line: 1, hunk: null });
  assert.equal(m.mapLine(2).hunk.id, 'h1');
  assert.equal(m.mapLine(2).line, 2);
  assert.deepEqual(m.mapLine(3), { line: 4, hunk: null });
  assert.deepEqual(m.mapLine(4), { line: 5, hunk: null });
});

test('offsetMapper: pure insertions push the following text down; pure deletions pull it up', () => {
  const a = 'a\nb\nc\n';
  const ins = 'a\nX\nb\nc\n';
  const mi = offsetMapper(a, ins);
  assert.deepEqual(mi.mapOffset(2), { off: 4, hunk: null }); // 'b' now after the inserted line
  assert.deepEqual(mi.mapOffset(1), { off: 1, hunk: null });
  assert.deepEqual(mi.mapLine(2), { line: 3, hunk: null });
  assert.deepEqual(mi.mapLine(1), { line: 1, hunk: null });

  const del = 'a\nc\n';
  const md = offsetMapper(a, del);
  const r = md.mapOffset(2); // inside the deleted 'b' line
  assert.equal(r.off, 2);
  assert.equal(r.hunk.id, 'h1');
  assert.deepEqual(md.mapOffset(4), { off: 2, hunk: null }); // 'c'
  assert.deepEqual(md.mapLine(3), { line: 2, hunk: null });
  assert.equal(md.mapLine(2).hunk.id, 'h1');
});

test('offsetMapper: verifies text identity for every unchanged offset on a larger edit', () => {
  const a = Array.from({ length: 60 }, (_, i) => `line ${i} text`).join('\n') + '\n';
  const lines = a.split('\n');
  lines.splice(10, 2, 'replaced 10');
  lines.splice(30, 0, 'inserted A', 'inserted B');
  lines.splice(45, 3);
  const b = lines.join('\n');
  const hs = lineHunks(a, b);
  checkInvariants(a, b, hs);
  const m = offsetMapper(a, b, hs);
  for (let off = 0; off < a.length; off++) {
    const r = m.mapOffset(off);
    if (!r.hunk) assert.equal(b[r.off], a[off], `offset ${off}`);
  }
  for (let line = 1; line <= 60; line++) {
    const r = m.mapLine(line);
    if (!r.hunk) assert.equal(b.split('\n')[r.line - 1], a.split('\n')[line - 1]);
  }
});
