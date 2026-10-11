// @ts-check
// Focused tests of the daemon's building blocks (WP5): request-target parsing, the router, byte ranges, error
// mapping, the JSONL tail, the engine loader (503 / 501 / recovery) and the guest bundle cache (dev rebuilds).
// No servers are started here.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-daemon-units-'));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');

const { parseTarget, encodeRelPath, tokenEquals } = await import('../../src/daemon/security.js');
const { Router } = await import('../../src/daemon/router.js');
const { parseRange, errorResponse, HttpError } = await import('../../src/daemon/http-util.js');
const { JsonlTail } = await import('../../src/daemon/watch.js');
const { Engine } = await import('../../src/daemon/engine.js');
const { WorkspaceIndex, docKeyOf } = await import('../../src/daemon/workspaces.js');
const { GuestBundleCache } = await import('../../src/daemon/guest-bundle.js');
const { withImportMap, inlineScriptHashes, cspHash, UiStatic } = await import('../../src/daemon/ui-index.js');
const { isDocumentType, contentTypeOf } = await import('../../src/daemon/mime.js');
const { setUiHeaders, UI_DEFAULT_CSP } = await import('../../src/daemon/security.js');
const { NotFoundError, ConflictError, RefusedError, UsageError, LockTimeoutError } = await import('../../src/core/store/errors.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseTarget decodes segments once and rejects traversal instead of normalising it', () => {
  assert.deepEqual(parseTarget('/')?.segments, []);
  assert.deepEqual(parseTarget('/a/b%20c/d.md?x=1&k=2')?.segments, ['a', 'b c', 'd.md']);
  assert.equal(parseTarget('/a/b%20c?x=1')?.query.get('x'), '1');
  for (const bad of ['/a/../b', '/a/./b', '/a//b', '/a/', '/%2e%2e/x', '/a%2fb', '/a%5cb', '/a\\b', '/a%00b', '/%E0%A4%A', 'a/b', '']) {
    assert.equal(parseTarget(bad), null, bad);
  }
  assert.equal(encodeRelPath('docs/my spec#1.md'), 'docs/my%20spec%231.md');
  assert.equal(tokenEquals('abc', 'abc'), true);
  assert.equal(tokenEquals('abd', 'abc'), false);
  assert.equal(tokenEquals('', 'abc'), false);
  assert.equal(tokenEquals(null, 'abc'), false);
});

test('Router: params, wildcards, 405 vs 404, HEAD falls back to GET', () => {
  const r = new Router();
  const h = () => {};
  r.get('/api/docs/:ws/:doc', h).post('/api/docs/:ws/:doc/reviews', h).get('/ui/*', h).get('/', h);
  const m = r.match('GET', ['api', 'docs', 'abc', 'spec']);
  assert.ok(m && 'handler' in m);
  assert.deepEqual(m.params, { ws: 'abc', doc: 'spec' });
  const w = r.match('GET', ['ui', 'components', 'App.js']);
  assert.ok(w && 'handler' in w);
  assert.deepEqual(w.rest, ['components', 'App.js']);
  assert.equal(w.params['*'], 'components/App.js');
  const head = r.match('HEAD', ['api', 'docs', 'abc', 'spec']);
  assert.ok(head && 'handler' in head);
  assert.deepEqual(r.match('DELETE', ['api', 'docs', 'abc', 'spec']), { allowed: ['GET', 'HEAD'] });
  assert.deepEqual(r.match('GET', ['api', 'docs', 'abc', 'spec', 'reviews']), { allowed: ['POST'] });
  assert.equal(r.match('GET', ['api', 'nope']), null);
  const root = r.match('GET', []);
  assert.ok(root && 'handler' in root);
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=4-2', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null, 'multi-range: whole file');
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test('errorResponse maps store/engine errors to HTTP statuses', () => {
  assert.equal(errorResponse(new NotFoundError('x')).status, 404);
  assert.equal(errorResponse(new ConflictError('x')).status, 409);
  assert.equal(errorResponse(new RefusedError('x')).status, 409);
  assert.equal(errorResponse(new UsageError('x')).status, 422);
  const lt = errorResponse(new LockTimeoutError('x'));
  assert.equal(lt.status, 503);
  assert.equal(lt.headers['Retry-After'], '1');
  assert.equal(errorResponse(new RangeError('bad version')).status, 422);
  assert.equal(errorResponse(new HttpError(413, 'big')).status, 413);
  assert.equal(errorResponse(Object.assign(new Error('gone'), { code: 'ENOENT' })).status, 404);
  const internal = errorResponse(new Error('boom'));
  assert.equal(internal.status, 500);
  assert.deepEqual(internal.body, { error: 'boom', code: 'INTERNAL' });
  const details = errorResponse(new NotFoundError('doc', { details: { doc: 'a' } }));
  assert.deepEqual(details.body, { error: 'doc', code: 'NOT_FOUND', details: { doc: 'a' } });
});

test('JsonlTail reads appended complete lines, waits for torn ones, and notices truncation', async () => {
  const file = path.join(TMP, 'events.jsonl');
  fs.writeFileSync(file, '{"seq":1,"type":"a"}\n');
  const tail = new JsonlTail(file);
  await tail.seekEnd();
  assert.deepEqual(await tail.read(), { records: [], truncated: false });
  fs.appendFileSync(file, '{"seq":2,"type":"b"}\n{"seq":3,');
  assert.deepEqual((await tail.read()).records, [{ seq: 2, type: 'b' }]);
  fs.appendFileSync(file, '"type":"c"}\nnot json\n');
  assert.deepEqual((await tail.read()).records, [{ seq: 3, type: 'c' }]);
  fs.writeFileSync(file, '{"seq":1,"type":"z"}\n');
  const t = await tail.read();
  assert.equal(t.truncated, true);
  assert.deepEqual(t.records, [{ seq: 1, type: 'z' }]);
  fs.rmSync(file);
  assert.deepEqual(await tail.read(), { records: [], truncated: true });
  fs.writeFileSync(file, '{"seq":1,"type":"new"}\n');
  assert.deepEqual((await tail.read()).records, [{ seq: 1, type: 'new' }]);
});

test('Engine: 503 while the engine cannot be loaded, recovery after the back-off, 501 for a missing op', async () => {
  const index = new WorkspaceIndex({ secret: 'ab'.repeat(32) });
  let attempts = 0;
  const engine = new Engine({
    index,
    load: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Cannot find module 'src/core/review/ops.js'");
      return { ops: { ping: async () => 'pong' }, createContext: null };
    },
  });
  await assert.rejects(engine.call('ping', 'deadbeef'), (err) => {
    assert.equal(/** @type {any} */ (err).status, 503);
    assert.equal(/** @type {any} */ (err).code, 'ENGINE_UNAVAILABLE');
    assert.match(/** @type {Error} */ (err).message, /Cannot find module/);
    return true;
  });
  await assert.rejects(engine.engine(), /not available/, 'no retry within the back-off window');
  assert.equal(attempts, 1);
  engine.lastFailureAt = 0; // back-off elapsed
  const loaded = await engine.engine();
  assert.equal(typeof loaded.ops.ping, 'function');
  assert.equal(await engine.has('ping'), true);
  assert.equal(await engine.has('nope'), false);
  await assert.rejects(engine.call('nope', 'deadbeef'), (err) => /** @type {any} */ (err).status === 501);
  // contexts need a registered workspace
  await assert.rejects(engine.call('ping', 'deadbeef'), (err) => /** @type {any} */ (err).status === 404);
});

test('docKeyOf is the amendments HMAC prefix', () => {
  const key = docKeyOf('s3cret', '0a6323ef', 'spec');
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.notEqual(key, docKeyOf('s3cret', '0a6323ef', 'spec2'));
  assert.notEqual(key, docKeyOf('other', '0a6323ef', 'spec'));
});

test('GuestBundleCache: built once in production, rebuilt on change in dev, 503 when unavailable', async () => {
  const build = await import('../../src/guest/build.js');
  const dir = path.join(TMP, 'guest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'parts.json'), JSON.stringify(['a.js']));
  fs.writeFileSync(path.join(dir, 'a.js'), 'var a = 1;\n');
  const builder = {
    GUEST_PARTS_DIR: dir,
    guestParts: build.guestParts,
    buildGuestBundle: () => build.buildGuestBundle({ dir }),
  };
  const prod = new GuestBundleCache({ dev: false, load: async () => builder });
  const dev = new GuestBundleCache({ dev: true, load: async () => builder });
  const p1 = await prod.get();
  const d1 = await dev.get();
  assert.match(p1.body.toString(), /var a = 1;/);
  assert.equal(p1.etag, d1.etag);
  fs.writeFileSync(path.join(dir, 'a.js'), 'var a = 2;\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'a.js'), future, future);
  await sleep(300);
  assert.match((await dev.get()).body.toString(), /var a = 2;/);
  assert.match((await prod.get()).body.toString(), /var a = 1;/, 'production keeps the first build');

  const missing = new GuestBundleCache({ load: async () => { throw new Error('no build.js'); } });
  await assert.rejects(missing.get(), (err) => /** @type {any} */ (err).status === 503 && /no build\.js/.test(String(/** @type {Error} */ (err).message)));

  const real = new GuestBundleCache();
  assert.ok((await real.get()).body.toString().startsWith("(function(){'use strict';"));
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'guest', 'parts.json')));
});

test('UI index: the import map is kept or inserted, and every inline script is hashed', () => {
  const kept = withImportMap('<html><head><script type="importmap">{"imports":{}}</script></head></html>', { imports: { a: '/a.js' } });
  assert.equal(kept.mapText, '{"imports":{}}');
  const inserted = withImportMap('<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/ui/main.js"></script></head></html>', { imports: { a: '/a.js' } });
  assert.ok(inserted.html.startsWith('<!doctype html><html><head><script type="importmap">{"imports":{"a":"/a.js"}}</script><meta'));
  assert.deepEqual(inlineScriptHashes(inserted.html), [cspHash('{"imports":{"a":"/a.js"}}')]);
  assert.deepEqual(inlineScriptHashes('<script src="/x.js"></script>'), []);
});

test('UI static: /ui/* and /vendor/* refuse document types, so the SPA is only ever served with its CSP (SEC-1)', async () => {
  for (const f of ['a.html', 'a.HTM', 'a.xhtml', 'a.svg', 'a.xml']) assert.equal(isDocumentType(contentTypeOf(f)), true, f);
  for (const t of ['text/xml', 'text/html', 'TEXT/HTML ; charset=utf-8', 'application/xslt+xml']) assert.equal(isDocumentType(t), true, t);
  for (const f of ['a.js', 'a.mjs', 'a.css', 'a.json', 'a.map', 'a.png', 'a.woff2', 'a.txt', 'a.unknown', 'a']) {
    assert.equal(isDocumentType(contentTypeOf(f)), false, f);
  }
  assert.equal(isDocumentType('text/htmlx'), false);

  const dir = path.join(TMP, 'ui-static');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  for (const f of ['index.html', 'page.htm', 'page.xhtml', 'icon.svg', 'feed.xml', 'sub/frame.html', 'main.js']) {
    fs.writeFileSync(path.join(dir, f), '<html><script>1</script></html>');
  }
  fs.symlinkSync(path.join(dir, 'index.html'), path.join(dir, 'alias.js'));
  const st = new UiStatic({ uiDir: dir, contentPort: () => 1 });
  const req = /** @type {any} */ ({ method: 'GET', headers: {} });
  /** a response that fails the test if anything is written to it */
  const res = /** @type {any} */ (
    new Proxy({}, { get: (_t, prop) => { throw new Error(`nothing may be sent (res.${String(prop)})`); } })
  );
  const is404 = (/** @type {any} */ err) => err?.status === 404;
  for (const rel of ['index.html', 'INDEX.HTML', 'page.htm', 'page.xhtml', 'icon.svg', 'feed.xml', 'sub/frame.html', 'alias.js']) {
    await assert.rejects(st.ui(req, res, rel.split('/')), is404, rel);
  }
  for (const rel of ['htm/index.html', 'htm/x.svg', 'dompurify/x.xml']) {
    await assert.rejects(st.vendor(req, res, rel.split('/')), is404, rel);
  }

  // every UI-origin response starts with anti-framing headers (a route such as the SPA page may replace the CSP)
  /** @type {Record<string, string>} */
  const set = {};
  setUiHeaders(/** @type {any} */ ({ setHeader: (/** @type {string} */ k, /** @type {string} */ v) => (set[k.toLowerCase()] = v) }));
  assert.equal(set['x-frame-options'], 'DENY');
  assert.equal(set['content-security-policy'], UI_DEFAULT_CSP);
  assert.match(UI_DEFAULT_CSP, /frame-ancestors 'none'/);
  assert.equal(set['cross-origin-resource-policy'], 'same-origin');
  assert.equal(set['referrer-policy'], 'no-referrer');
  assert.equal(set['x-content-type-options'], 'nosniff');
});
