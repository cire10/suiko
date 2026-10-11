// Unit tests: src/core/text/quote.js (findQuote, sourceToPlainText, similarity) and plain.js / entities.js.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { findQuote, sourceToPlainText, similarity, normalizeWs, balanceMarkdown, toWordBounds, widenQuote } = await import('../../src/core/text/quote.js');
const { toPlain } = await import('../../src/core/text/plain.js');
const { decodeEntities } = await import('../../src/core/text/entities.js');

/** @param {string} hay @param {ReturnType<typeof findQuote>} res */
const slices = (hay, res) => res.map((r) => hay.slice(r.start, r.end));

test('findQuote: exact matches come first, best first by context', () => {
  const hay = 'The token is rotated. Later, the token is revoked.';
  const res = findQuote(hay, 'the token', { prefix: 'Later, ' });
  assert.equal(res.length, 1); // case-sensitive exact
  const res2 = findQuote(hay, 'token is', { suffix: ' revoked' });
  assert.equal(res2.length, 2);
  assert.equal(res2[0].mode, 'exact');
  assert.equal(hay.slice(res2[0].start, res2[0].end + 8), 'token is revoked');
  assert.ok(res2[0].score > res2[1].score);
});

test('findQuote: hint breaks ties by proximity; range limits candidates', () => {
  const hay = 'x foo y foo z foo';
  const res = findQuote(hay, 'foo', { hint: 14 });
  assert.equal(res[0].start, 14);
  const ranged = findQuote(hay, 'foo', { range: [5, 12] });
  assert.deepEqual(ranged.map((r) => r.start), [8]);
});

test('findQuote: whitespace-normalised mode spans line breaks and indentation', () => {
  const hay = 'Refresh tokens are rotated on every\n  use, and the previous token';
  const res = findQuote(hay, 'rotated on every use', {});
  assert.equal(res.length, 1);
  assert.equal(res[0].mode, 'ws');
  assert.equal(slices(hay, res)[0], 'rotated on every\n  use');
});

test('findQuote: markup-tolerant across **bold**, [links](x), `code`, entities and line breaks', () => {
  const hay = [
    'Refresh tokens are **rotated** on [every use](https://x.test/a "t"), see `token_store`.',
    'Payments &amp; refunds are\n> handled by the *ledger*.',
  ].join('\n');
  const cases = [
    ['rotated on every use', '**rotated** on [every use](https://x.test/a "t")'],
    ['see token_store.', 'see `token_store`.'],
    ['Payments & refunds', 'Payments &amp; refunds'],
    ['refunds are handled by the ledger', 'refunds are\n> handled by the *ledger*'],
  ];
  for (const [needle, expected] of cases) {
    assert.deepEqual(findQuote(hay, needle, {}), [], `no plain match for ${needle}`);
    const res = findQuote(hay, needle, { markupTolerant: true });
    assert.ok(res.length >= 1, `markup match for ${needle}`);
    assert.equal(res[0].mode, 'markup');
    assert.equal(hay.slice(res[0].start, res[0].end), expected);
  }
});

test('findQuote: markup-tolerant on HTML source (tags, entities)', () => {
  const hay = '<p>The <strong>checkout</strong> service owns pricing, tax &amp; payment.</p>';
  const res = findQuote(hay, 'checkout service owns pricing, tax & payment', { markupTolerant: true, format: 'html' });
  assert.equal(res.length, 1);
  assert.equal(hay.slice(res[0].start, res[0].end), '<strong>checkout</strong> service owns pricing, tax &amp; payment');
});

test('findQuote: prefix/suffix pick the right occurrence among duplicates in markup mode', () => {
  const hay = 'A: the **cache** expires.\nB: the **cache** persists.';
  const res = findQuote(hay, 'the cache', { markupTolerant: true, suffix: ' persists.' });
  assert.equal(res.length, 2);
  assert.ok(hay.slice(res[0].end).startsWith(' persists') || hay.slice(res[0].end).startsWith('** persists'));
});

test('findQuote: empty / missing needles return []', () => {
  assert.deepEqual(findQuote('abc', ''), []);
  assert.deepEqual(findQuote('abc', '   '), []);
  assert.deepEqual(findQuote('abc', 'zzz', { markupTolerant: true }), []);
});

test('balanceMarkdown completes emphasis and links cut by a match', () => {
  const hay = 'say **bold** and [a link](u) now';
  const s = hay.indexOf('bold');
  assert.deepEqual(balanceMarkdown(hay, s, hay.indexOf(' and')), [hay.indexOf('**'), hay.indexOf(' and')]);
  const ls = hay.indexOf('a link');
  const [bs, be] = balanceMarkdown(hay, ls, ls + 'a link'.length + 1);
  assert.equal(hay.slice(bs, be), '[a link](u)');
});

test('sourceToPlainText: markdown block and inline markup', () => {
  const md = [
    '## Heading *two*',
    '',
    '- [x] done **item**',
    '> quoted `code` and [link](http://x) ![img](a.png)',
    '',
    '| a | b \\| c |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'const **x** = 1;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    'snake_case and 2 * 3 &copy; \\*not em\\*',
  ].join('\n');
  const plain = normalizeWs(sourceToPlainText('markdown', md)).text;
  assert.equal(plain, 'Heading two done item quoted code and link a b | c 1 2 const **x** = 1; snake_case and 2 * 3 © *not em*');
});

test('sourceToPlainText: slices cut through emphasis drop the dangling delimiters', () => {
  assert.equal(sourceToPlainText('markdown', '**exponential'), 'exponential');
  assert.equal(sourceToPlainText('markdown', 'backoff** with'), 'backoff with');
  assert.equal(sourceToPlainText('markdown', '- item', { lineStart: false }), '- item');
  assert.equal(sourceToPlainText('markdown', '- item'), 'item');
});

test('sourceToPlainText: HTML strips tags, comments, scripts and excluded elements', () => {
  const html = '<p class="x">Hello &amp; <b>world</b><!-- c --><script>if (a<b) x()</script><style>p{}</style>' +
    '<pre class="mermaid">graph TD</pre><span data-sr-ignore>hidden</span><span class="katex-mathml">m</span>!</p>';
  assert.equal(sourceToPlainText('html', html), 'Hello & world!');
  assert.equal(sourceToPlainText('html', 'a < b && c'), 'a < b && c');
});

test('toPlain maps every output char back to its source range', () => {
  const src = 'x **bold** &amp; `c`';
  const p = toPlain('markdown', src);
  assert.equal(p.text, 'x bold & c');
  const amp = p.text.indexOf('&');
  assert.equal(src.slice(p.map[amp], p.mapEnd[amp]), '&amp;');
  const b = p.text.indexOf('b');
  assert.equal(src[p.map[b]], 'b');
});

test('decodeEntities handles named, numeric and legacy references', () => {
  assert.equal(decodeEntities('&lt;a&gt; &mdash; &#x2014; &#8212; &copy &notit; &bogus;'), '<a> — — — © ¬it; &bogus;');
  assert.equal(decodeEntities('&copy x', { requireSemicolon: true }), '&copy x');
});

test('similarity is 1 for equal strings and decreases with edits', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('abc', ''), 0);
  const s = similarity('rotated on every use', 'rotated on each use');
  assert.ok(s > 0.6 && s < 1);
  // only the first 64 chars count
  assert.equal(similarity('a'.repeat(64) + 'x', 'a'.repeat(64) + 'y'), 1);
});

test('toWordBounds: a selection cut mid-word is widened to whole words for display', () => {
  assert.equal(toWordBounds('eploy to stagin', '1. **Week 1:** D', 'g; route'), 'Deploy to staging');
  assert.equal(toWordBounds('st, validates it', 'accepts the reque', ''), 'request, validates it');
  // already on word boundaries (or punctuation at the edges): unchanged
  assert.equal(toWordBounds('all channels.', 'One API for ', ' Next'), 'all channels.');
  assert.equal(toWordBounds('`x`', 'a', 'b'), '`x`');
  assert.equal(toWordBounds('über', 'gr', 'ß'), 'grüberß');
  // scripts without spaces between words are never widened (a "word" run would be the whole clause)
  assert.equal(toWordBounds('語の中', '日本', '文章です'), '語の中');
  assert.equal(toWordBounds('ステム', 'シ', 'です'), 'ステム');
  // '_' is Markdown emphasis, not part of a word
  assert.equal(toWordBounds('bar', 'foo _', '_ baz'), 'bar');
  // a piece longer than 24 characters is not taken
  assert.equal(toWordBounds('end', 'a'.repeat(40), ''), `${'a'.repeat(24)}end`);
  assert.equal(toWordBounds('abc', null, undefined), 'abc');
  assert.equal(toWordBounds('', 'a', 'b'), '');
});

test('widenQuote: widens only where the source shows a split word and both contexts agree', () => {
  // the source cuts 'Deploy': widen with the rendered context
  assert.equal(widenQuote({ exact: 'eploy to stagin', prefix: 'Week 1: D', suffix: 'g; route' }, { text: 'eploy to stagin', prefix: '**Week 1:** D', suffix: 'g; route' }), 'Deploy to staging');
  // rendered context runs blocks together; the source shows the block boundary
  assert.equal(widenQuote({ exact: 'Measured', prefix: 'Footnotes', suffix: ' monthly' }, { text: 'Measured', prefix: '## Footnotes\n\n', suffix: ' monthly' }), 'Measured');
  // stale rendered context (a generated anchor after an edit): no widening on that side
  assert.equal(widenQuote({ exact: 'ploy', prefix: 'De', suffix: 'ment' }, { text: 'ploy', prefix: 'Re', suffix: 'ment' }), 'ployment');
  assert.equal(widenQuote({ exact: 'abc', prefix: 'x', suffix: 'y' }, null), 'abc');
  assert.equal(widenQuote(null, { text: 'a' }), '');
});

