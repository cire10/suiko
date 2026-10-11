// Unit tests: src/core/text/lines.js and normalize.js (line index + whitespace normalisation).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { lineIndex, linesOfRange } = await import('../../src/core/text/lines.js');
const { normalizeWs, collapseWs, squeezeWs } = await import('../../src/core/text/normalize.js');

test('lineIndex: basic LF text', () => {
  const src = 'alpha\nbeta\ngamma';
  const li = lineIndex(src);
  assert.equal(li.count, 3);
  assert.equal(li.lineOf(0), 1);
  assert.equal(li.lineOf(5), 1); // the '\n' belongs to line 1
  assert.equal(li.lineOf(6), 2);
  assert.equal(li.lineOf(src.length), 3);
  assert.equal(li.startOf(2), 6);
  assert.equal(li.endOf(2), 10);
  assert.equal(li.nextStartOf(2), 11);
  assert.equal(li.nextStartOf(3), src.length);
  assert.equal(li.lineText(3), 'gamma');
  assert.equal(li.colOf(8), 2);
});

test('lineIndex: trailing newline does not open a line; empty source has one line', () => {
  assert.equal(lineIndex('a\nb\n').count, 2);
  assert.equal(lineIndex('a\nb\n').lineOf(4), 2);
  assert.equal(lineIndex('').count, 1);
  assert.equal(lineIndex('').lineOf(0), 1);
  assert.equal(lineIndex('\n').count, 1);
});

test('lineIndex: CRLF terminators are excluded from endOf and clamping works', () => {
  const src = 'one\r\ntwo\r\nthree';
  const li = lineIndex(src);
  assert.equal(li.count, 3);
  assert.equal(li.endOf(1), 3);
  assert.equal(li.lineText(2), 'two');
  assert.equal(li.lineOf(4), 1); // '\n' of the CRLF
  assert.equal(li.startOf(99), li.startOf(3));
  assert.equal(li.startOf(0), 0);
  assert.equal(li.lineOf(-5), 1);
});

test('linesOfRange uses the last character for the end line', () => {
  const li = lineIndex('a\nb\nc\n');
  assert.deepEqual(linesOfRange(li, 0, 4), { startLine: 1, endLine: 2 }); // "a\nb\n"
  assert.deepEqual(linesOfRange(li, 2, 2), { startLine: 2, endLine: 2 });
});

test('normalizeWs collapses, trims and maps back to raw offsets', () => {
  const raw = '  Refresh\n  tokens\tare   rotated ';
  const { text, map } = normalizeWs(raw);
  assert.equal(text, 'Refresh tokens are rotated');
  assert.equal(map.length, text.length);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') assert.equal(raw[map[i]], text[i]);
    else assert.match(raw[map[i]], /\s/);
  }
  const i = text.indexOf('tokens');
  assert.equal(raw.slice(map[i], map[i + 'tokens are'.length - 1] + 1), 'tokens\tare');
});

test('normalizeWs treats NBSP and other unicode spaces as whitespace', () => {
  assert.equal(normalizeWs('a\u00a0\u2003b').text, 'a b');
  assert.equal(normalizeWs('   ').text, '');
});

test('collapseWs keeps boundary spaces; squeezeWs removes all whitespace with a map', () => {
  assert.equal(collapseWs(' a \n b '), ' a b ');
  const sq = squeezeWs('a b\nc');
  assert.equal(sq.text, 'abc');
  assert.deepEqual(sq.map, [0, 2, 4]);
});
