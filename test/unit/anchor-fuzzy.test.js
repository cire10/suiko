// Text relocation primitives (src/core/anchor/fuzzy.js; design 7.4 steps 3-4): exactFind scoring by context and
// proximity, fuzzyFind thresholds, the long-needle head/tail strategy, ranges and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextSim, exactFind, fuzzyFind, UNIQUE_MIN_CHARS } from '../../src/core/anchor/fuzzy.js';

const HAY = 'alpha token beta. gamma token delta. epsilon token zeta.';

test('exactFind: context picks the occurrence; ties go to the hint, then the earliest', () => {
  const m = exactFind(HAY, 'token', { prefix: 'gamma ', suffix: ' delta' });
  assert.deepEqual(m, { start: 24, end: 29, score: 1, quoteSim: 1, errors: 0, count: 3 });
  assert.equal(exactFind(HAY, 'token', {})?.start, 6, 'no context, no hint: the first occurrence');
  assert.equal(exactFind(HAY, 'token', { hint: 40 })?.start, 45, 'nearest the hint');
});

test('exactFind: rejects a short needle whose context does not match, accepts a distinctive unique one', () => {
  assert.equal(exactFind(HAY, 'token', { prefix: 'xxxxxxxxxx', suffix: 'yyyyyyyyy' }), null);
  const needle = 'gamma token delta. epsilon token';
  assert.ok(needle.replace(/\s+/g, '').length >= UNIQUE_MIN_CHARS);
  const m = exactFind(HAY, needle, { prefix: 'qqqqqqqqqqqq', suffix: 'zzzzzzzzzzz' });
  assert.equal(m?.start, 18);
  assert.equal(m?.count, 1);
  assert.equal(exactFind(HAY, needle, { prefix: 'qqqqqqqqqqqq', suffix: 'zzzzzzzzzzz', allowUnique: false }), null,
    'a needle that was not unique before must be confirmed by its context');
  assert.equal(exactFind(HAY, 'absent', {}), null);
  assert.equal(exactFind(HAY, '', {}), null);
});

test('exactFind / fuzzyFind honour range while scoring context outside it', () => {
  assert.equal(exactFind(HAY, 'token', { prefix: 'alpha ' })?.start, 6);
  assert.equal(exactFind(HAY, 'token', { range: [20, HAY.length], prefix: 'alpha ' })?.start, 24,
    'the best-scored occurrence is outside the range');
  assert.equal(exactFind(HAY, 'token', { range: [20, HAY.length], prefix: 'xxxxxxxxxxxx', suffix: 'yyyyyyyyyy' }), null);
  assert.deepEqual(fuzzyFind('aaa token bbb token ccc', 'token', { range: [10, 23] }), { start: 14, end: 19, score: 1, quoteSim: 1, errors: 0 });
});

test('fuzzyFind: a reworded sentence is found with its error count; minQuoteSim and minScore gate it', () => {
  const needle = 'The service rotates refresh tokens on every use and invalidates the previous token immediately.';
  const hay = 'Intro text here.\n\nThe service rotates refresh credentials on each use and invalidates the prior token at once.\n\nOutro.';
  const m = fuzzyFind(hay, needle, { prefix: 'Intro text here.\n\n', suffix: '\n\nOutro.' });
  assert.ok(m);
  assert.equal(hay.slice(m.start, m.end), 'The service rotates refresh credentials on each use and invalidates the prior token at once.');
  assert.ok(m.quoteSim > 0.6 && m.quoteSim < 0.9);
  assert.equal(m.quoteSim, 1 - m.errors / needle.length);
  assert.equal(fuzzyFind(hay, needle, { prefix: 'Intro text here.\n\n', suffix: '\n\nOutro.', minQuoteSim: 0.9 }), null);
  assert.equal(fuzzyFind(hay, needle, { prefix: 'Intro text here.\n\n', suffix: '\n\nOutro.', minScore: 0.99 }), null);
  assert.equal(fuzzyFind('completely unrelated content goes here', needle, {}), null);
});

test('fuzzyFind: typos inside a word; match edges never cut a word', () => {
  const hay = 'one two three. the quikc brown fox. four';
  const m = fuzzyFind(hay, 'quick brown', {});
  assert.equal(hay.slice(m?.start, m?.end), 'quikc brown');
  assert.equal(m?.errors, 2);
  const glued = 'xx Thequick brown fox jumps';
  const g = fuzzyFind(glued, 'quick brown fox', {});
  assert.equal(glued.slice(g?.start, g?.end), 'Thequick brown fox', 'widened to the word boundary');
  const kept = fuzzyFind(glued, 'quick brown fox', { prefix: 'xx The' });
  assert.equal(glued.slice(kept?.start, kept?.end), 'quick brown fox', 'kept when the context continues the word');
});

test('fuzzyFind: needles longer than 256 chars use head/tail joins and align the whole span', () => {
  const long = Array.from({ length: 40 }, (_, i) => `sentence number ${i} talks about tokens`).join('. ');
  assert.ok(long.length > 256);
  const hay = `HEADER\n${long.replace('number 20 talks', 'number twenty discusses')}\nFOOTER`;
  const m = fuzzyFind(hay, long, { prefix: 'HEADER\n', suffix: '\nFOOTER' });
  assert.ok(m);
  assert.equal(m.start, 7);
  assert.equal(m.end, hay.length - '\nFOOTER'.length);
  assert.ok(m.errors > 0 && m.errors < 30);
  assert.equal(fuzzyFind(`HEADER\n${'z'.repeat(2000)}\nFOOTER`, long, {}), null);
});

test('fuzzyFind: prefers the hint window, then searches the whole text', () => {
  const block = 'the grace window is thirty seconds';
  const filler = 'lorem ipsum dolor sit amet. '.repeat(400);
  const hay = `${block}\n${filler}\n${block.replace('thirty', 'thirty-one')}`;
  const near = fuzzyFind(hay, 'the grace window is thirty-one seconds', { hint: hay.length - 40 });
  assert.ok(near && near.start > filler.length);
  const far = fuzzyFind(hay, 'the grace window is thirty-one seconds', { hint: 0 });
  assert.ok(far, 'found even though the hint window holds a worse candidate');
});

test('contextSim is 1 - levenshtein / maxLen and treats two empty strings as equal', () => {
  assert.equal(contextSim('abc', 'abc'), 1);
  assert.equal(contextSim('', ''), 1);
  assert.equal(contextSim('abcd', 'wxyz'), 0);
  assert.equal(contextSim('abcd', 'abcx'), 0.75);
  assert.equal(contextSim('x'.repeat(100) + 'abc', 'abc', 3), 1, 'only the last n chars count');
});

test('results are deterministic', () => {
  const hay = 'token a token b token c token';
  assert.deepEqual(fuzzyFind(hay, 'tokem', {}), fuzzyFind(hay, 'tokem', {}));
  assert.equal(fuzzyFind(hay, 'tokem', {})?.start, 0);
  assert.equal(fuzzyFind(hay, 'tokem', { hint: 15 })?.start, 16);
});
