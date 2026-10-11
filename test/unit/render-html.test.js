// Unit tests: src/core/render/html.js (byte-splice stamping, srcmap, text stream, assets, mermaid detection) and
// charset decoding.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSource, unstamp, decodeSource, elementText } = await import('../../src/core/render/index.js');
const { lineIndex } = await import('../../src/core/text/lines.js');
const { TEXT_EXCLUDE } = await import('../../src/shared/protocol.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const appSpec = readFileSync(path.join(FIXTURES, 'app-spec.html'), 'utf8');

/** @param {string} source @param {object} [opts] */
const render = (source, opts = {}) => renderSource({ format: 'html', source, docPath: 'docs/spec.html', ...opts });

/** Collect [data-srid] values from parsed HTML. */
function sridsInHtml(html) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes ?? []) {
      if (c.attrs) for (const a of c.attrs) if (a.name === 'data-srid') out.push({ srid: Number(a.value), tag: c.tagName, attrs: c.attrs });
      walk(c);
      if (c.content) walk(c.content);
    }
  };
  walk(parse(html));
  return out;
}

const SPLICE_CORPUS = [
  appSpec,
  '<p>a<br/>b<br />c<img src=x.png/><img src="y.png"/><input disabled/><a href=/>root</a></p>',
  '<svg viewBox="0 0 10 10"><circle r=5/><rect width="1"/><path d=M0,0/><g id=g1><text>Hi</text></g></svg>',
  '<math><mi>x</mi><mspace width=1em/></math><p class=foo>z</p><img alt="a>b" src=\'q.png\'>',
  '<!-- leading comment -->\n<P CLASS=Upper>Mixed <B>Case</B></P>\r\n<ul><li>one<li>two</ul>\r\n<table><tr><td>x<td>y</table>',
  '\uFEFF<!doctype html><html><body><template><p>inert</p></template><script>document.write("<p>x</p>")</script><div>d</div></body></html>',
  '<!doctype html>\n<title>t</title>\n<p>no head or body tags</p>\n<div\n  class="multi-line"\n  data-x=\'1\'\n>tag</div>',
  '<html><head><style>p{}</style></head><body><p>unclosed<div>at EOF',
];

test('splice round trip: stripping the inserted attributes restores the original bytes', async () => {
  for (const src of SPLICE_CORPUS) {
    const r = await render(src);
    assert.equal(unstamp(r.html), src, `round trip for ${JSON.stringify(src.slice(0, 40))}`);
    assert.ok(r.srcmap.order.length > 0);
  }
});

test("splice insertion points handle '/>', unquoted values and foreign elements", async () => {
  const r = await render(SPLICE_CORPUS[1]);
  assert.match(r.html, /<br data-srid="\d+"\/>/);
  assert.match(r.html, /<br  data-srid="\d+"\/>/);
  assert.match(r.html, /<img src=x\.png\/ data-srid="\d+">/); // slash belongs to the unquoted value
  assert.match(r.html, /<img src="y\.png" data-srid="\d+"\/>/);
  assert.match(r.html, /<input disabled data-srid="\d+"\/>/);
  assert.match(r.html, /<a href=\/ data-srid="\d+">root<\/a>/);
  // parsed attribute values are unchanged by the insertion
  const img = sridsInHtml(r.html).find((x) => x.tag === 'img');
  assert.equal(img.attrs.find((a) => a.name === 'src').value, 'x.png/');

  const svg = await render(SPLICE_CORPUS[2]);
  assert.match(svg.html, /<circle r=5\/>/, 'foreign element with unquoted slash value is not stamped');
  assert.match(svg.html, /<path d=M0,0\/>/);
  assert.match(svg.html, /<rect width="1" data-srid="\d+"\/>/);
  assert.match(svg.html, /<g id=g1 data-srid="\d+">/);
  const tags = Object.values(svg.srcmap.nodes).map((n) => n.t);
  assert.ok(!tags.includes('circle') && !tags.includes('path'));
  const math = await render(SPLICE_CORPUS[3]);
  assert.match(math.html, /<mspace width=1em\/>/);
});

test('every srcmap srid is stamped exactly once on an element of the same tag', async () => {
  for (const src of SPLICE_CORPUS) {
    const r = await render(src);
    const found = sridsInHtml(r.html);
    const ids = found.map((f) => f.srid);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate data-srid');
    assert.deepEqual([...ids].sort((a, b) => a - b), [...r.srcmap.order].sort((a, b) => a - b));
    for (const f of found) assert.equal(f.tag.toLowerCase(), r.srcmap.nodes[f.srid].t.toLowerCase());
  }
});

test('elements that already carry data-srid are skipped and their numbers are never reused', async () => {
  const src = '<p>a</p><div data-srid="2">pre-stamped</div><p>b</p><p>c</p>';
  const r = await render(src);
  assert.ok(!r.srcmap.order.includes(2));
  assert.deepEqual(r.srcmap.order, [1, 3, 4]);
  const ids = sridsInHtml(r.html).map((f) => f.srid);
  assert.equal(new Set(ids).size, ids.length);
});

test('ineligible elements: head content, html/head/body, script/style/template/noscript/title, template content', async () => {
  const src = '<!doctype html><html><head><title>T</title><meta name="a" content="b"><link rel="stylesheet" href="s.css"></head>' +
    '<body><noscript><p>ns</p></noscript><template><p>tpl</p></template><script>1</script><style>p{}</style><p>ok</p></body></html>';
  const r = await render(src);
  const tags = r.srcmap.order.map((id) => r.srcmap.nodes[id].t);
  assert.deepEqual(tags, ['p']);
  assert.equal(r.text.text, 'ok');
  assert.equal(unstamp(r.html), src);
});

test('guestInsertAt: after <head>, else <html>, else doctype, else 0 / after BOM', async () => {
  const cases = [
    ['<!doctype html><html><head><title>x</title></head><body><p>a</p></body></html>', '<!doctype html><html><head>'],
    ['<!doctype html><html lang="en"><body><p>a</p></body></html>', '<!doctype html><html lang="en">'],
    ['<!DOCTYPE html>\n<p>a</p>', '<!DOCTYPE html>'],
    ['<p>a</p>', ''],
    ['\uFEFF<p>a</p>', '\uFEFF'],
  ];
  for (const [src, before] of cases) {
    const r = await render(src);
    assert.equal(r.html.slice(0, r.guestInsertAt), before, JSON.stringify(src));
  }
});

test('app-spec fixture: srcmap ranges, lines and kinds', async () => {
  const r = await render(appSpec, { docPath: 'docs/app-spec.html' });
  const li = lineIndex(appSpec);
  for (const id of r.srcmap.order) {
    const n = r.srcmap.nodes[id];
    assert.equal(n.ls, li.lineOf(n.s));
    assert.equal(n.le, li.lineOf(n.e - 1));
    const slice = appSpec.slice(n.s, n.e);
    assert.ok(slice.toLowerCase().startsWith(`<${n.t.toLowerCase()}`), `${n.t} range starts at its tag: ${slice.slice(0, 20)}`);
    if (n.p) {
      const p = r.srcmap.nodes[n.p];
      assert.ok(p.s <= n.s && n.e <= p.e, 'child range inside parent range');
    }
  }
  const byKind = (k) => r.srcmap.order.map((id) => r.srcmap.nodes[id]).filter((n) => n.k === k);
  for (const k of ['heading', 'img', 'svg', 'table', 'tr', 'cell', 'mermaid']) assert.ok(byKind(k).length > 0, `kind ${k}`);
  const svg = byKind('svg')[0];
  assert.equal(svg.a.id, 'flow-diagram');
  assert.equal(svg.ls, li.lineOf(appSpec.indexOf('<svg')));
  assert.equal(svg.le, li.lineOf(appSpec.indexOf('</svg>')));
  const mermaid = byKind('mermaid')[0];
  assert.equal(appSpec.slice(mermaid.c.contentStart, mermaid.c.contentEnd).trim().split('\n')[0], 'sequenceDiagram');
  assert.equal(mermaid.c.firstLine, li.lineOf(appSpec.indexOf('sequenceDiagram')));
  const canvas = r.srcmap.order.map((id) => r.srcmap.nodes[id]).find((n) => n.t === 'canvas');
  assert.equal(canvas.a.id, 'latency-chart');
  const g = r.srcmap.order.map((id) => r.srcmap.nodes[id]).filter((n) => n.t === 'g').map((n) => n.a.id);
  assert.deepEqual(g, ['node-gateway', 'node-checkout', 'node-payments']);
  assert.deepEqual(r.outline.map((o) => o.text), ['Checkout Service', '1. Overview', '2. Request flow', '3. Pricing rules', '4. API']);
  assert.equal(r.outline[0].id, 'title');
  assert.equal(r.title, 'Checkout Service — App Spec');
});

test('app-spec fixture: text stream excludes head, scripts, styles and mermaid source; spans nest', async () => {
  const r = await render(appSpec);
  const t = r.text.text;
  assert.ok(!t.includes('App Spec'), 'title excluded');
  assert.ok(!t.includes('getElementById'), 'script excluded');
  assert.ok(!t.includes('--accent'), 'style excluded');
  assert.ok(!t.includes('sequenceDiagram'), 'mermaid source excluded (kind mermaid)');
  assert.ok(t.includes('Gateway') && t.includes('volume_discount'), 'svg text and table text included');
  assert.ok(t.includes('pricing, tax & payment orchestration'), 'entities decoded');
  for (const id of r.srcmap.order) {
    const [a, b] = r.text.spans[id];
    assert.ok(a <= b && b <= t.length);
    const p = r.srcmap.nodes[id].p;
    if (p) {
      const [pa, pb] = r.text.spans[p];
      assert.ok(pa <= a && b <= pb, 'child span inside parent span');
    }
  }
  const cell = r.srcmap.order.find((id) => r.srcmap.nodes[id].k === 'cell' && elementText(r, id) === 'coupon');
  assert.ok(cell, 'cell text available through elementText');
  assert.ok(TEXT_EXCLUDE.tags.includes('script'));
});

test('features.mermaid only when .mermaid elements exist and no script mentions mermaid', async () => {
  assert.equal((await render(appSpec)).features.mermaid, true);
  const own = appSpec.replace('</body>', '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></body>');
  assert.equal((await render(own)).features.mermaid, false);
  const inline = '<div class="mermaid">graph TD; A-->B</div><script>mermaid.initialize({})</script>';
  assert.equal((await render(inline)).features.mermaid, false);
  assert.equal((await render('<p>no diagrams</p>')).features.mermaid, false);
});

test('assets and externals: local refs resolve workspace-relative, externals are absolute http(s)', async () => {
  const src = `<!doctype html><html><head>
<link rel="stylesheet" href="css/site.css"><link rel="canonical" href="https://example.com/x">
<script src="/js/app.js"></script><script src="https://cdn.example.com/lib.js"></script>
<style>.a{background:url('img/bg.png')} @import "theme.css";</style></head><body>
<img src="img/a.png?v=2#frag" srcset="img/a@2x.png 2x, img/a@3x.png 3x">
<picture><source srcset="img/b.webp"><img src="img/b.png"></picture>
<video src="media/demo.mp4" poster="media/poster.jpg"></video><audio src="media/a.mp3"></audio>
<object data="files/x.pdf"></object><embed src="files/y.svg"><iframe src="//player.example.com/v"></iframe>
<div style="background-image: url(img/c.png)"></div>
<img src="data:image/png;base64,AAAA"><img src="../../root.png"><img src="../../../escapes.png"><img src="#frag"><a href="other.html">link</a>
<img src="img/my%20pic.png">
</body></html>`;
  const r = await render(src, { docPath: 'docs/specs/spec.html' });
  assert.deepEqual(r.assets, [
    'docs/specs/css/site.css', 'js/app.js', 'docs/specs/img/bg.png', 'docs/specs/theme.css', 'docs/specs/img/a.png',
    'docs/specs/img/a@2x.png', 'docs/specs/img/a@3x.png', 'docs/specs/img/b.webp', 'docs/specs/img/b.png',
    'docs/specs/media/demo.mp4', 'docs/specs/media/poster.jpg', 'docs/specs/media/a.mp3', 'docs/specs/files/x.pdf',
    'docs/specs/files/y.svg', 'docs/specs/img/c.png', 'root.png', 'docs/specs/img/my pic.png',
  ]);
  assert.deepEqual(r.externals, ['https://cdn.example.com/lib.js', 'http://player.example.com/v']);
});

test('<base href> changes how relative references resolve', async () => {
  const local = await render('<head><base href="assets/"></head><body><img src="a.png"></body>', { docPath: 'docs/x.html' });
  assert.deepEqual(local.assets, ['docs/assets/a.png']);
  const remote = await render('<head><base href="https://cdn.example.com/site/"></head><body><img src="a.png"></body>');
  assert.deepEqual(remote.assets, []);
  assert.deepEqual(remote.externals, ['https://cdn.example.com/site/a.png']);
});

test('stamp:false leaves the bytes untouched but still builds the srcmap', async () => {
  const r = await render(appSpec, { stamp: false });
  assert.equal(r.html, appSpec);
  assert.ok(r.srcmap.order.length > 20);
});

test('decodeSource: BOM, meta charset prescan, utf-8 default', () => {
  const latin = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);
  assert.equal(decodeSource(latin, 'html').text, '<meta charset="windows-1252"><p>café</p>');
  assert.equal(decodeSource(latin, 'html').charset, 'windows-1252');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x</p>')]);
  const d = decodeSource(bom, 'html');
  assert.equal(d.text, '<p>x</p>', 'BOM consumed, like the store decodeText');
  assert.equal(d.bom, true);
  const http = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=utf-16"><p>é</p>');
  assert.equal(decodeSource(http, 'html').charset, 'utf-8');
  assert.equal(decodeSource(Buffer.from('<meta charset="no-such-charset">x'), 'html').charset, 'utf-8');
  assert.equal(decodeSource('already a string', 'html').text, 'already a string');
});

test('renderSource accepts a Buffer source and decodes it with the charset rules', async () => {
  const latin = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>na'), Buffer.from([0xef]), Buffer.from('ve</p>')]);
  const r = await renderSource({ format: 'html', source: latin, docPath: 'a.html' });
  assert.equal(r.text.text, 'naïve');
});
