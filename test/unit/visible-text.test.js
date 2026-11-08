// @ts-check
// src/shared/visible-text.js: what a reader reads, as source ranges (the measure of the revision guards and the
// pre-write hook). HTML: markup, comments, scripts, styles, JSON data blobs and data: URIs are hidden, text and
// character references are not, a literal '<' is text; comments, CDATA and self-closing raw-text tags end where
// Chrome ends them; prose-like string literals of an inline script or JSON blob (up to 256 KB) are text, its data,
// code, comments and a bigger script are not; Markdown: only base64 data: URIs and raw script/style blocks outside
// fences are hidden; the visible text keeps words apart and maps back to the source; blocks and the change ratio of
// the hook; the hidden tags cover TEXT_EXCLUDE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TEXT_EXCLUDE } from '../../src/shared/protocol.js';
import {
  HIDDEN_CONTENT_TAGS, MAX_SCRIPT_SCAN, countVisible, hiddenRanges, visibleBlocks, visibleChangeRatio, visibleText,
} from '../../src/shared/visible-text.js';

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Study</title><style>body { color: red }</style></head>',
  '<body><h1 class="hero" data-x=\'a > b\'>Hello <b>bold</b> world</h1>',
  '<p>a &lt; b and a < b, <img alt="x" src="data:image/png;base64,AAAA"> done.</p>',
  '<script type="application/json" id="d">{"a":[1,2,3],"html":"</p><p>not text"}</script>',
  '<script>const t = "<b>"; if (1 < 2) draw();</script>',
  '<!-- a comment --><svg viewBox="0 0 10 10"><style>.a{}</style><text x="1">Tick 1</text></svg>',
  '<ul><li>one</li><li>two</li></ul><template><p>inert</p></template><noscript>enable js</noscript></body></html>',
  '',
].join('\n');

/** @param {string} format @param {string} src */
const visible = (format, src) => visibleText(src, hiddenRanges(format, src)).text;

test('HTML: only text a reader reads is visible', () => {
  const text = visible('html', PAGE);
  for (const seen of ['Hello', 'bold', 'world', 'a &lt; b and a < b,', 'done.', 'Tick 1', 'one', 'two']) assert.ok(text.includes(seen), seen);
  for (const hidden of ['Study', 'color', 'hero', 'a > b', 'base64', '"a"', 'not text', 'draw', 'comment', 'viewBox', '.a{}', 'inert', 'enable js']) {
    assert.ok(!text.includes(hidden), hidden);
  }
  // words separated by markup stay apart
  assert.match(visible('html', '<li>one</li><li>two</li>'), /^one\s+two$/);
  assert.equal(visible('html', 'x <b>y</b> z'), 'x y z');
});

test('HTML: a map back to the source, slices, and unterminated constructs', () => {
  const src = '<p>Alpha</p><script>var D = [1, 2];</script><p>Beta</p>';
  const hidden = hiddenRanges('html', src);
  const v = visibleText(src, hidden);
  assert.equal(v.text, 'Alpha\nBeta');
  for (let i = 0; i < v.text.length; i++) if (v.map[i] >= 0) assert.equal(src[v.map[i]], v.text[i]);
  assert.equal(visibleText(src, hidden, src.indexOf('Beta'), src.length).text, 'Beta');
  assert.equal(countVisible(src, hidden, 0, src.length, true), 9);
  // an unterminated script hides the rest; an unterminated tag is text
  assert.equal(visible('html', '<p>Text</p><script>var a = 1;'), 'Text');
  assert.equal(visible('html', 'Text <p class="x'), 'Text <p class="x');
});

test('Markdown: only data: URIs and raw script/style blocks are hidden, never fenced code', () => {
  const b64 = 'iVBORw0KGgo'.repeat(10);
  const md = [
    '# Title', '', `Some text ![chart](data:image/png;base64,${b64}) end.`, '',
    '```html', '<script>example()</script>', `data:image/png;base64,${b64}`, '```', '',
    '<script>', 'track();', '</script>', '<style>p { color: red }</style>', 'after **bold** <b>html</b>', '',
  ].join('\n');
  const text = visible('markdown', md);
  assert.ok(text.includes('Some text ![chart](') && text.includes(') end.'));
  assert.ok(!text.includes(`${b64}) end`), 'the inline data: URI is hidden');
  assert.ok(text.includes('<script>example()</script>') && text.includes(`data:image/png;base64,${b64}\n`), 'fenced code is text');
  assert.ok(!text.includes('track()') && !text.includes('color: red'), 'raw script/style blocks are hidden');
  assert.ok(text.includes('after **bold** <b>html</b>'), 'Markdown markup and inline HTML count as before');
  assert.deepEqual(hiddenRanges('markdown', '# Plain prose\n\nNothing hidden <here>.\n'), []);
});

test('blocks: Markdown lines; HTML text between block tags and line breaks, inline tags joined', () => {
  assert.deepEqual(visibleBlocks('markdown', '# A\n\n  b  c \n'), ['# A', 'b c']);
  assert.deepEqual(visibleBlocks('html', PAGE), ['Hello bold world', 'a &lt; b and a < b, done.', 'Tick 1', 'one', 'two']);
});

test('the hook measure: hidden changes are free, visible ones cost the words they lost', () => {
  const page = (/** @type {string} */ data, /** @type {string} */ p2) => `<h1>Report</h1>\n<p>First paragraph stays.</p>\n<p>${p2}</p>\n<script>var D=${data};</script>\n`;
  assert.equal(visibleChangeRatio('html', page('[1,2]', 'Second one.'), page('[3,4,5]', 'Second one.')), 0);
  const r = visibleChangeRatio('html', page('[1]', 'Second one.'), page('[1]', 'Changed.'));
  assert.equal(r, 'Secondone.'.length / ('Report'.length + 'Firstparagraphstays.'.length + 'Secondone.'.length));
  assert.equal(visibleChangeRatio('html', '<p>a</p><p>b</p>', '<p>b</p><p>a</p>'), 0, 'moves are free');
  assert.equal(visibleChangeRatio('html', '', '<p>new</p>'), 0);
  // one term renamed in every paragraph costs that term, not the paragraphs (as the guards' word diff counts it)
  const doc = (/** @type {string} */ term) => Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i} on funding ${term} in the second quarter.</p>`).join('\n');
  const renamed = visibleChangeRatio('html', doc('stress'), doc('pressure'));
  assert.ok(renamed > 0.1 && renamed < 0.2, String(renamed));
  // a deleted block costs all its words
  assert.equal(visibleChangeRatio('html', '<p>keep this</p><p>drop that</p>', '<p>keep this</p>'), 8 / 16);
});

test('every TEXT_EXCLUDE tag hides its content', () => {
  for (const tag of TEXT_EXCLUDE.tags) assert.ok(HIDDEN_CONTENT_TAGS.includes(tag), tag);
});

/** @param {string} html */
const shown = (html) => visible('html', html).replace(/\s+/g, ' ').trim();

test('comments, CDATA and self-closing raw-text tags end where Chrome ends them', () => {
  // each expected string is Chrome's document.body.innerText for the same markup (svg/math text included)
  const cases = [
    ['<body><h1>T</h1><!-->\n<p>Prose after an empty comment.</p>\n<!-- end --></body>', 'T Prose after an empty comment.'],
    ['<body><h1>T</h1><!--->\n<p>Prose after a dash comment.</p>\n<!-- end --></body>', 'T Prose after a dash comment.'],
    ['<body><h1>T</h1><!---->\n<p>Prose after four dashes.</p>\n<!-- end --></body>', 'T Prose after four dashes.'],
    ['<body><h1>T</h1><!-- note --!>\n<p>Prose after a bang close.</p>\n<!-- end --></body>', 'T Prose after a bang close.'],
    ['<body><h1>T</h1><!--!>\n<p>Hidden prose.</p>\n--></body>', 'T'],
    ['<body><![CDATA[ x ]>\n<p>Prose after a CDATA in HTML.</p>\n]]></body>', 'Prose after a CDATA in HTML. ]]>'],
    ['<body><svg width="400" height="40"><text x="0" y="20"><![CDATA[Prose in svg cdata.]]></text></svg><p>After the svg.</p></body>', 'Prose in svg cdata. After the svg.'],
    ['<body><svg width="10" height="10"></svg><![CDATA[ x ]>\n<p>Prose after a CDATA after svg.</p>\n]]></body>', 'Prose after a CDATA after svg. ]]>'],
    ['<body><math><mi><![CDATA[x]]></mi></math><p>After math.</p></body>', 'x After math.'],
    ['<body><svg/><![CDATA[ x ]>\n<p>After svg/.</p>\n]]></body>', 'After svg/. ]]>'],
    ['<body><script src="data:text/javascript,1"/>\n<p>Prose after script/.</p>\n</script><p>tail</p></body>', 'tail'],
    ['<body><style/>\n<p>Prose after style/.</p>\n</style><p>tail</p></body>', 'tail'],
    ['<body><textarea/>\nIn a textarea.\n</textarea><p>tail</p></body>', 'tail'],
    ['<body><svg width="10" height="10"><script href="x.js"/><text>In svg.</text></svg><p>tail</p></body>', 'In svg. tail'],
    ['<body><svg width="100" height="20"><style/><text x="0" y="15">In svg text.</text></svg><p>tail</p></body>', 'In svg text. tail'],
  ];
  for (const [html, chrome] of cases) assert.equal(shown(html), chrome, html);
});

test('prose a page renders from its own script or JSON blob is text; its data, code, comments and markup are not', () => {
  const blob = JSON.stringify({
    title: 'Funding stress in the second quarter',
    paragraphs: ['Stress days come in runs of two to four sessions around month ends.', 'The spread widens on those days and narrows within a week.'],
    days: [{ date: '2024-01-03', value: 31.4, label: 'EUR', note: 'n/a' }],
    'a long key that reads like a sentence of prose': 1,
    html: '<p class="lead">The lead paragraph says what the study found.</p>',
    lines: 'First line of the note.\nSecond line of the note.',
  });
  const page = [
    `<script type="application/json" id="d">${blob}</script>`,
    '<script>',
    '// a comment that reads like a sentence of prose, not shown to anyone',
    '/* another comment that reads like a sentence of prose */',
    "const re = /[\"']/g; const cls = 'card card-body'; const t = 'Single quoted prose that the page shows.';",
    'el.textContent = "Double quoted prose that the page shows to the reader.";',
    'el.innerHTML = `<h2>${title}</h2><p>Template prose with ${n} values in the middle of it.</p>`;',
    '</script>',
    '<script type="text/template"><p>A template for some library, written in prose words.</p></script>',
  ].join('\n');
  const text = visible('html', page);
  for (const seen of ['Funding stress in the second quarter', 'Stress days come in runs of two to four sessions around month ends.',
    'The spread widens on those days', 'The lead paragraph says what the study found.', 'First line of the note.',
    'Second line of the note.', 'Single quoted prose that the page shows.', 'Double quoted prose that the page shows to the reader.',
    'Template prose with', 'values in the middle of it.']) {
    assert.ok(text.includes(seen), seen);
  }
  for (const hidden of ['2024-01-03', '31.4', 'EUR', 'n/a', 'a long key', 'comment', 'card-body', 'class="lead"', '<p', '\\n', 'title}',
    'el.', 'A template for some library']) {
    assert.ok(!text.includes(hidden), hidden);
  }
  // blocks (the hook's unit): each literal is its own block, the markup in it aside; a \n escape cuts like a line break
  const blocks = visibleBlocks('html', page);
  for (const b of ['The lead paragraph says what the study found.', 'First line of the note.', 'Second line of the note.']) {
    assert.ok(blocks.includes(b), JSON.stringify(blocks));
  }
});

test('the hook measure on a page whose prose lives in a JSON blob: a rewrite counts, new data and a big inlined library do not', () => {
  const lib = (/** @type {string} */ tag) =>
    `<script>${Array.from({ length: 3000 }, (_, i) => `function f${i}(x){ if (!x) throw new Error("the value ${tag} of parameter number ${i} must be a finite number"); return x * ${i}; }`).join('\n')}</script>`;
  assert.ok(lib('a').length > MAX_SCRIPT_SCAN);
  const page = (/** @type {string[]} */ paras, /** @type {number} */ seed, /** @type {string} */ tag) => [
    '<h1>Quarterly report</h1><main id="m"></main>',
    `<script type="application/json" id="text">${JSON.stringify(paras)}</script>`,
    `<script type="application/json" id="data">${JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ d: `2024-02-${String((i % 28) + 1).padStart(2, '0')}`, v: (i * seed) % 97, label: `S${i % 7}` })))}</script>`,
    '<script>document.getElementById("m").innerHTML = JSON.parse(document.getElementById("text").textContent).map((p) => "<p>" + p + "</p>").join("");</script>',
    lib(tag),
  ].join('\n');
  const paras = Array.from({ length: 30 }, (_, i) => `Finding ${i}: the margin of segment ${i} moved with the leverage of the market for most sessions.`);
  assert.equal(visibleChangeRatio('html', page(paras, 1, 'a'), page(paras, 7, 'b')), 0, 'new data and a changed library');
  const rewritten = paras.map((_, i) => `Rewritten ${i}: entirely new claims nobody asked for, replacing the finding that was here before.`);
  assert.ok(visibleChangeRatio('html', page(paras, 1, 'a'), page(rewritten, 1, 'a')) > 0.8);
  // the scan is linear: a 2 MB page with a 200 KB blob and the 300 KB library is measured quickly
  const big = page(Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} of the long report says something about segment ${i}.`), 3, 'c');
  const t0 = performance.now();
  hiddenRanges('html', big);
  assert.ok(performance.now() - t0 < 1000, `${Math.round(performance.now() - t0)} ms`);
});

test('a script tokenizer that loses its way never makes code text: broken quotes, odd regexes, deep templates', () => {
  const page = [
    '<script>',
    "if (a / b > 1) x = 'it\\'s a quote inside a long single quoted prose string';",
    "const unterminated = 'this quote never ends on its line and so is not a literal at all",
    'const r = /\\/"[^"]*"/; const next = "after the regex the tokenizer still finds this prose string";',
    `const deep = ${'`${'.repeat(30)}x${'}`'.repeat(30)};`,
    'const ok = "and this prose string after the deep template is still read as text";',
    '</script>',
  ].join('\n');
  const text = visible('html', page);
  assert.ok(text.includes("it\\'s a quote inside a long single quoted prose string"), text);
  assert.ok(text.includes('after the regex the tokenizer still finds this prose string'), text);
  assert.ok(!text.includes('never ends'), 'an unclosed quote is no literal');
  assert.ok(!text.includes('const'), text);
});
