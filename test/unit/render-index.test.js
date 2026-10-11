// Unit tests: src/core/render/index.js (renderSource API, query helpers, finalizeHtml, getRender caching) and
// fragment.js (sanitised fragments).
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(tmpdir(), 'sr-home-'));
process.env.SPECREVIEW_HOME = HOME;

const render = await import('../../src/core/render/index.js');
const { RENDERER_VERSION } = await import('../../src/shared/protocol.js');
const {
  renderSource, elementText, deepestBlockAt, elementsIntersecting, sectionAt, finalizeHtml, getRender,
  renderFragment, clearRenderMemoryCache, normalizeFormat,
} = render;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const kitchen = readFileSync(path.join(FIXTURES, 'kitchen-sink.md'), 'utf8');
const appSpec = readFileSync(path.join(FIXTURES, 'app-spec.html'), 'utf8');

test('renderSource returns the frozen RenderResult shape', async () => {
  const r = await renderSource({ format: 'markdown', source: kitchen, docPath: 'docs/k.md' });
  for (const key of ['html', 'guestInsertAt', 'srcmap', 'text', 'outline', 'assets', 'externals', 'title', 'features']) {
    assert.ok(key in r, key);
  }
  assert.deepEqual(Object.keys(r.srcmap).sort(), ['nodes', 'order']);
  assert.deepEqual(Object.keys(r.text).sort(), ['spans', 'text']);
  assert.equal(r.format, 'markdown');
  // JSON round trip (the render cache stores it as JSON)
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('normalizeFormat accepts aliases and falls back to the extension', () => {
  assert.equal(normalizeFormat('md'), 'markdown');
  assert.equal(normalizeFormat('HTML'), 'html');
  assert.equal(normalizeFormat(undefined, 'a/b.htm'), 'html');
  assert.equal(normalizeFormat('', 'a/b.markdown'), 'markdown');
  assert.throws(() => normalizeFormat('rtf', 'x.rtf'), TypeError);
});

test('deepestBlockAt / elementsIntersecting / elementText / sectionAt', async () => {
  const r = await renderSource({ format: 'markdown', source: kitchen, docPath: 'docs/k.md' });
  const at = (needle) => kitchen.indexOf(needle);
  // inside a table cell -> the cell
  const s = at('30 d');
  const cell = deepestBlockAt(r, s, s + 4);
  assert.equal(r.srcmap.nodes[cell].k, 'cell');
  assert.equal(elementText(r, cell).trim(), '30 d');
  // inside emphasis in a list item -> the li (em is inline)
  const e = at('access tokens');
  const liSrid = deepestBlockAt(r, e, e + 6);
  assert.equal(r.srcmap.nodes[liSrid].t, 'li');
  // a range spanning two paragraphs -> their common block ancestor (none at top level)
  assert.equal(deepestBlockAt(r, at('This spec describes'), at('## 1 Goals') + 3), null);
  // intersecting leaf blocks across a list: the outer item has intersecting block descendants, so only the
  // nested items are leaves; a range inside the outer item's own text yields the outer item
  const leaves = elementsIntersecting(r, at('- Rotate refresh'), at('Revoke the whole'), { leafBlocks: true });
  assert.deepEqual(leaves.map((id) => elementText(r, id).trim()), ['Detect reuse of a rotated token.', 'Revoke the whole token family on reuse.']);
  const own = elementsIntersecting(r, at('Rotate refresh'), at('Rotate refresh') + 6, { leafBlocks: true });
  assert.deepEqual(own.map((id) => elementText(r, id).split('\n')[0]), ['Rotate refresh tokens safely.']);
  const all = elementsIntersecting(r, e, e + 1);
  assert.deepEqual(all.map((id) => r.srcmap.nodes[id].t), ['ul', 'li', 'em']);
  assert.deepEqual(elementsIntersecting(r, e, e + 1, { blocksOnly: true }).map((id) => r.srcmap.nodes[id].t), ['ul', 'li']);
  // empty ranges intersect the element containing the point
  assert.deepEqual(elementsIntersecting(r, e, e, { leafBlocks: true }).map((id) => r.srcmap.nodes[id].t), ['li']);
  assert.deepEqual(sectionAt(r, at('Refresh tokens are rotated')), ['Token Service Implementation Spec', '3 Tokens', '3.2 Token refresh']);
  assert.deepEqual(sectionAt(r, at('Last revised')), ['Token Service Implementation Spec', '4 Rollout checklist']);
  assert.deepEqual(sectionAt(r, 0), []);
  assert.equal(elementText(r, 999999), '');
});

test('finalizeHtml (markdown): guest after <head>, asset base replaced everywhere', async () => {
  const r = await renderSource({ format: 'markdown', source: kitchen, docPath: 'docs/k.md' });
  const guest = '<script src="http://127.0.0.1:5801/__sr/r1/guest.js" data-sr-ignore></script>';
  const html = finalizeHtml(r, { assetBase: 'http://127.0.0.1:5801/__sr/r1', guestTag: guest });
  assert.ok(html.startsWith('<!doctype html><html lang="en"><head>' + guest));
  assert.ok(!html.includes('__SR_ASSET_BASE__'));
  assert.match(html, /href="http:\/\/127\.0\.0\.1:5801\/__sr\/r1\/static\/shell\.css"/);
  assert.equal(r.html.includes('__SR_ASSET_BASE__'), true, 'render result itself is not mutated');
});

test('finalizeHtml (html): vendored mermaid appended before </body> only when needed; stripCsp', async () => {
  const r = await renderSource({ format: 'html', source: appSpec, docPath: 'docs/app-spec.html' });
  const html = finalizeHtml(r, { assetBase: 'http://127.0.0.1:5801/__sr/r1', guestTag: '<script data-sr-ignore src="g.js"></script>' });
  assert.match(html, /<head><script data-sr-ignore src="g\.js"><\/script>\n<meta charset="utf-8">/);
  assert.match(html, /<script src="http:\/\/127\.0\.0\.1:5801\/__sr\/r1\/vendor\/mermaid\/mermaid\.min\.js"><\/script><script src="http:\/\/127\.0\.0\.1:5801\/__sr\/r1\/static\/mermaid-init\.js"><\/script><\/body>/);

  const own = appSpec.replace('</body>', '<script src="https://cdn.example.com/mermaid.min.js"></script>\n</body>');
  const r2 = await renderSource({ format: 'html', source: own, docPath: 'docs/app-spec.html' });
  assert.ok(!finalizeHtml(r2, { assetBase: 'X' }).includes('mermaid-init.js'));

  const csp = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><p>x</p></body></html>';
  const r3 = await renderSource({ format: 'html', source: csp, docPath: 'c.html' });
  assert.ok(finalizeHtml(r3, { stripCsp: true }).indexOf('Content-Security-Policy') < 0);
  assert.ok(finalizeHtml(r3, {}).includes('Content-Security-Policy'));
});

/** In-memory fake of the Store contract used by getRender. */
function fakeStore(root, files) {
  const calls = { readVersion: 0, readWorking: 0 };
  return {
    calls,
    files,
    cacheDir: (...parts) => path.join(root, 'cache', ...parts),
    async readVersion(docId, v) {
      calls.readVersion++;
      const source = files.versions[v];
      if (source == null) throw Object.assign(new Error('no such version'), { code: 'ENOENT' });
      return { manifest: { v, sha256: createHash('sha256').update(source).digest('hex') }, source };
    },
    async readWorking() {
      calls.readWorking++;
      return { text: files.working, sha256: createHash('sha256').update(files.working).digest('hex') };
    },
  };
}

test('getRender: versions are cached on disk (RENDERER_VERSION + sha8) and in memory; live by sha256', async () => {
  const root = mkdtempSync(path.join(HOME, 'ws-'));
  const store = fakeStore(root, { versions: { 1: '# One\n\nfirst\n', 2: '# Two\n\nsecond\n' }, working: '# Live\n\nnow\n' });
  const doc = { id: 'spec', path: 'docs/spec.md', format: 'markdown' };
  clearRenderMemoryCache();

  const v1 = await getRender(store, doc, 1);
  assert.equal(v1.title, 'One');
  const dir = path.join(root, 'cache', 'render', 'spec');
  const sha8 = createHash('sha256').update('# One\n\nfirst\n').digest('hex').slice(0, 8);
  const file = path.join(dir, `v0001-${RENDERER_VERSION}-${sha8}.json`);
  assert.ok(existsSync(file), 'cache file written');
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'no temp files left');
  assert.equal(await getRender(store, doc, 1), v1, 'memory hit returns the same object');
  assert.equal((await getRender(store, doc, 'v2')).title, 'Two');

  clearRenderMemoryCache();
  const cached = await getRender(store, doc, 1);
  assert.deepEqual(cached, JSON.parse(readFileSync(file, 'utf8')), 'served from disk after memory eviction');

  writeFileSync(file, '{ not json');
  clearRenderMemoryCache();
  assert.equal((await getRender(store, doc, 1)).title, 'One', 'corrupt cache is recomputed');

  const noStamp = await getRender(store, doc, 1, { stamp: false });
  assert.ok(!noStamp.html.includes('data-srid'));
  assert.ok(existsSync(path.join(dir, `v0001-${RENDERER_VERSION}-${sha8}-nostamp.json`)));

  const live1 = await getRender(store, doc, 'live');
  assert.equal(live1.title, 'Live');
  assert.equal(await getRender(store, doc, 'live'), live1, 'unchanged working copy -> same render');
  store.files.working = '# Changed\n';
  assert.equal((await getRender(store, doc, 'live')).title, 'Changed');
  assert.equal(store.calls.readWorking, 3);

  await assert.rejects(getRender(store, doc, 0), RangeError);
  await assert.rejects(getRender(store, doc, 9));
});

test('getRender works with a store exposing runtimeDir only, or no cache dir at all', async () => {
  const root = mkdtempSync(path.join(HOME, 'ws-'));
  const base = fakeStore(root, { versions: { 1: '<p>hi</p>' }, working: '' });
  const store = { readVersion: base.readVersion, readWorking: base.readWorking, runtimeDir: (...p) => path.join(root, 'rt', ...p) };
  clearRenderMemoryCache();
  const r = await getRender(store, { id: 'd', path: 'd.html', format: 'html' }, 1);
  assert.equal(r.text.text, 'hi');
  assert.ok(readdirSync(path.join(root, 'rt', 'cache', 'render', 'd')).length === 1);
  const bare = { readVersion: base.readVersion, readWorking: base.readWorking };
  clearRenderMemoryCache();
  assert.equal((await getRender(bare, { id: 'd', path: 'd.html', format: 'html' }, 1)).text.text, 'hi');
});

test('renderFragment strips scripts, event handlers and javascript: URLs', async () => {
  const md = '## Removed section\n\nSome **bold** <script>alert(1)</script> [x](javascript:alert(1)) ' +
    '<img src="a.png" onerror="alert(1)"> <a href="https://ok.example">ok</a> $x^2$\n';
  const html = await renderFragment({ format: 'markdown', source: md });
  assert.match(html, /<h2>Removed section<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.ok(!/script/i.test(html));
  assert.ok(!/onerror/i.test(html));
  assert.ok(!/javascript:/i.test(html));
  assert.match(html, /href="https:\/\/ok\.example"/);
  assert.match(html, /class="katex"/);
  assert.ok(!html.includes('data-srid'));

  const h = await renderFragment({ format: 'html', source: '<p onclick="x()">Hi <a href=" jav&#x09;ascript:x">a</a><iframe src="x"></iframe><b style="color:red">b</b></p><script>bad()</script>' });
  assert.equal(h, '<p>Hi <a>a</a><b style="color:red">b</b></p>');
  assert.equal(await renderFragment({ format: 'markdown', source: '   ' }), '');
});
