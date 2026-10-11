// @ts-check
// Integration tests for the daemon's snip support:
// - POST /api/docs/:ws/:doc/snip/screen (screen snips, key B): success (stored attachment + data URL + size), a
//   cancelled picker, single-flight (409 busy), no picker (501 unsupported), and the usual auth / Origin / 404 rules;
// - stored attachments on the content origin: GET /c/<docKey>/__att/<file> (DocState.attachmentBase), refused for
//   traversal, other docs' keys, non-image names, symlinks out of the attachments dir and same-origin (doc page)
//   requests;
// - the vendored modern-screenshot module the guest lazy-loads for doc snips (/__sr/<RV>/vendor/...), and the
//   render.network "block" CSP that must still allow that same-origin dynamic import.
// The real review engine and store run on temp workspaces; SPECREVIEW_HOME is a temp dir; ports are random (0).
// The macOS picker is NEVER run: SPECREVIEW_SCREENCAPTURE always points at a fake capture command (below) or at a
// path that does not exist.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-daemon-snip-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
delete process.env.SPECREVIEW_PORT;
// never the real /usr/sbin/screencapture: until a test picks a fake, a command that does not exist
process.env.SPECREVIEW_SCREENCAPTURE = path.join(TMP, 'no-such-capture-command');

const { Store } = await import('../../src/core/store/store.js');
const { startDaemon } = await import('../../src/daemon/main.js');
const { RENDERER_VERSION } = await import('../../src/shared/protocol.js');
const { resolveVendor, VENDOR_DOC } = await import('../../src/shared/vendor.js');

const ARCH_PNG = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'docs', 'img', 'arch.png'));
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** Width / height from a PNG's IHDR chunk. @param {Buffer} png */
const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

// ------------------------------------------------------------------------------------------------ fake picker

const FAKE_DIR = path.join(TMP, 'fake-capture');
const FAKE_LOG = path.join(FAKE_DIR, 'calls.log');
const STARTED = path.join(FAKE_DIR, 'started');
const RELEASE = path.join(FAKE_DIR, 'release');

// Called like screencapture: <cmd> -i -x <out.png>. Modes: ok (writes the fixture PNG), cancel (exits 1 without
// writing, like Esc), slow (writes its pid to STARTED, waits for RELEASE, then writes the PNG). Every call is logged.
const FAKE_JS = `
import fs from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
const out = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ mode, args }) + '\\n');
const png = Buffer.from(${JSON.stringify(ARCH_PNG.toString('base64'))}, 'base64');
if (mode === 'cancel') process.exit(1);
if (mode === 'slow') {
  fs.writeFileSync(${JSON.stringify(STARTED)}, String(process.pid));
  while (!fs.existsSync(${JSON.stringify(RELEASE)})) await new Promise((r) => setTimeout(r, 20));
}
fs.writeFileSync(out, png);
`;

/** @param {'ok' | 'cancel' | 'slow'} mode @returns {string} the command path for SPECREVIEW_SCREENCAPTURE */
function fakeCommand(mode) {
  const file = path.join(FAKE_DIR, `capture-${mode}.sh`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FAKE_DIR, 'fake.mjs'))} ${mode} "$@"\n`, { mode: 0o755 });
  }
  return file;
}

/** @param {'ok' | 'cancel' | 'slow'} mode */
function useFake(mode) {
  process.env.SPECREVIEW_SCREENCAPTURE = fakeCommand(mode);
}

/** Number of times the fake picker ran. */
function fakeCalls() {
  return fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
}

// ------------------------------------------------------------------------------------------------ http helpers

/**
 * @typedef {{ status: number, headers: http.IncomingHttpHeaders, body: Buffer, text: string, json: () => any }} Resp
 */

/**
 * @param {{ port: number, path: string, method?: string, headers?: Record<string, string>, body?: string }} o
 * @returns {Promise<Resp>}
 */
function request({ port, path: p, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { connection: 'close', ...headers }, agent: false }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {() => boolean} pred
 * @param {number} [ms]
 */
async function waitUntil(pred, ms = 10_000) {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await sleep(20);
  }
}

/**
 * Tracks a doc and records v1.
 * @param {import('../../src/core/store/store.js').Store} store
 * @param {string} rel
 */
async function track(store, rel) {
  const doc = await store.createDoc({ path: rel });
  const w = await store.readWorking(doc);
  await store.commitVersion(doc, { source: w.buf, assetFiles: {}, manifest: { author: { kind: 'agent', name: 'test' }, summary: 'v1', capturedBy: 'open' } });
  return doc;
}

// ------------------------------------------------------------------------------------------------ fixture

/** @type {any} */
let d;
/** @type {import('../../src/core/store/store.js').Store} */
let store1;
/** @type {import('../../src/core/store/store.js').Store} */
let store2;
let uport = 0;
let cport = 0;

before(async () => {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FAKE_DIR, 'fake.mjs'), FAKE_JS);
  const ws1 = path.join(TMP, 'ws1');
  const ws2 = path.join(TMP, 'ws2');
  fs.mkdirSync(path.join(ws1, 'docs'), { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });
  fs.writeFileSync(path.join(ws1, 'docs', 'spec.md'), '# Spec\n\nIntro text.\n');
  fs.writeFileSync(path.join(ws1, 'docs', 'other.md'), '# Other\n\nMore text.\n');
  fs.writeFileSync(path.join(ws2, 'blocked.md'), '# Blocked\n\nNo network here.\n');
  fs.writeFileSync(path.join(TMP, 'outside.png'), TINY_PNG);

  store1 = await Store.open(ws1, { create: true });
  store2 = await Store.open(ws2, { create: true });
  await track(store1, 'docs/spec.md');
  await track(store1, 'docs/other.md');
  const cfgFile = path.join(store2.storeDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, render: { ...(cfg.render ?? {}), network: 'block' } }));
  await track(store2, 'blocked.md');

  // the real review engine (lazy import of src/core/review/ops.js)
  d = await startDaemon({ uiPort: 0, contentPort: 0, logFile: false, idleMs: 0, pingMs: 60_000 });
  uport = d.uiPort;
  cport = d.contentPort;
});

after(async () => {
  await d?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${d.token}` });
/** @param {string} wsId @param {string} docId */
const docKey = (wsId, docId) => crypto.createHmac('sha256', d.secret).update(`${wsId}/${docId}`).digest('hex').slice(0, 24);
/** @param {string} p @param {Record<string, string>} [headers] */
const content = (p, headers = {}) => request({ port: cport, path: p, headers: { host: `127.0.0.1:${cport}`, ...headers } });
/** @param {string} p @param {Record<string, string>} [headers] */
const ui = (p, headers = {}) => request({ port: uport, path: p, headers: { host: `127.0.0.1:${uport}`, ...headers } });
/** @param {string} p @param {any} [body] @param {string} [method] @param {Record<string, string>} [headers] */
const api = (p, body, method = 'POST', headers = {}) =>
  request({
    port: uport,
    path: p,
    method,
    headers: { host: `127.0.0.1:${uport}`, origin: `http://127.0.0.1:${uport}`, 'content-type': 'application/json', ...auth(), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const snipPath = (wsId = store1.wsId, docId = 'spec') => `/api/docs/${wsId}/${docId}/snip/screen`;
const attachmentsDir = (docId = 'spec') => path.join(store1.docDir(docId), 'attachments');
const attachmentFiles = (docId = 'spec') => (fs.existsSync(attachmentsDir(docId)) ? fs.readdirSync(attachmentsDir(docId)).sort() : []);

// ------------------------------------------------------------------------------------------------ screen snips

describe('POST /api/docs/:ws/:doc/snip/screen', () => {
  test('stores the picked region as an attachment and answers {path, dataUrl, width, height}', async () => {
    useFake('ok');
    const before = fakeCalls();
    const r = await api(snipPath());
    assert.equal(r.status, 200, r.text);
    const body = r.json();
    assert.deepEqual(Object.keys(body).sort(), ['dataUrl', 'height', 'path', 'width']);
    assert.match(body.path, /^attachments\/a\d+\.png$/);
    assert.equal(body.dataUrl, `data:image/png;base64,${ARCH_PNG.toString('base64')}`);
    assert.deepEqual({ width: body.width, height: body.height }, pngSize(ARCH_PNG));
    assert.equal(fakeCalls(), before + 1);
    const stored = path.join(attachmentsDir(), path.basename(body.path));
    assert.ok(fs.readFileSync(stored).equals(ARCH_PNG), 'the stored attachment holds the captured bytes');
    // the picker was invoked like screencapture: -i (interactive region) -x (no sound) <file>
    const call = JSON.parse(fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').pop() ?? '{}');
    assert.deepEqual(call.args.slice(0, 2), ['-i', '-x']);
    assert.equal(call.args.length, 3);
    assert.ok(!fs.existsSync(call.args[2]), 'the temp capture file is removed');
  });

  test('a cancelled picker (Esc) answers {cancelled:true} and stores nothing', async () => {
    useFake('cancel');
    const files = attachmentFiles();
    const r = await api(snipPath());
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { cancelled: true });
    assert.deepEqual(attachmentFiles(), files);
  });

  test('only one picker runs at a time: a second snip is 409 busy, and the next one works again', async () => {
    useFake('slow');
    fs.rmSync(STARTED, { force: true });
    fs.rmSync(RELEASE, { force: true });
    const first = api(snipPath());
    await waitUntil(() => fs.existsSync(STARTED));
    const calls = fakeCalls();
    // single-flight is per daemon, not per doc
    const second = await api(snipPath(store1.wsId, 'other'));
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json().code, 'busy');
    assert.equal(typeof second.json().error, 'string');
    assert.equal(fakeCalls(), calls, 'the busy request did not open a second picker');
    fs.writeFileSync(RELEASE, '1');
    const r1 = await first;
    assert.equal(r1.status, 200, r1.text);
    assert.match(r1.json().path, /^attachments\/a\d+\.png$/);
    useFake('cancel');
    const again = await api(snipPath());
    assert.equal(again.status, 200);
    assert.deepEqual(again.json(), { cancelled: true });
  });

  test('a client that goes away closes the picker, stores nothing and frees the daemon', async () => {
    useFake('slow');
    fs.rmSync(STARTED, { force: true });
    fs.rmSync(RELEASE, { force: true });
    const files = attachmentFiles();
    const req = http.request({
      host: '127.0.0.1',
      port: uport,
      path: snipPath(),
      method: 'POST',
      headers: { host: `127.0.0.1:${uport}`, origin: `http://127.0.0.1:${uport}`, ...auth() },
      agent: false,
    });
    req.on('error', () => {});
    req.end();
    await waitUntil(() => fs.existsSync(STARTED) && fs.readFileSync(STARTED, 'utf8') !== '');
    const pid = Number(fs.readFileSync(STARTED, 'utf8'));
    req.destroy();
    // the daemon kills the picker...
    await waitUntil(() => !pidAlive(pid));
    // ...and is free again
    useFake('cancel');
    /** @type {Resp | null} */
    let next = null;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      next = await api(snipPath());
      if (next.status !== 409) break;
      await sleep(50);
    }
    assert.equal(next?.status, 200, next?.text);
    assert.deepEqual(next?.json(), { cancelled: true });
    assert.deepEqual(attachmentFiles(), files);
  });

  test('no picker on this machine is 501 unsupported (and does not leave the daemon busy)', async () => {
    process.env.SPECREVIEW_SCREENCAPTURE = path.join(TMP, 'missing', 'screencapture');
    const r = await api(snipPath());
    assert.equal(r.status, 501, r.text);
    assert.equal(r.json().code, 'unsupported');
    assert.equal(typeof r.json().error, 'string');
    useFake('cancel');
    const next = await api(snipPath());
    assert.equal(next.status, 200);
  });

  test('needs the token and a same-origin Origin; unknown docs are 404 without opening the picker', async () => {
    useFake('ok');
    const calls = fakeCalls();
    const noToken = await request({
      port: uport,
      path: snipPath(),
      method: 'POST',
      headers: { host: `127.0.0.1:${uport}`, origin: `http://127.0.0.1:${uport}` },
    });
    assert.equal(noToken.status, 401);
    const badToken = await api(snipPath(), undefined, 'POST', { authorization: 'Bearer nope' });
    assert.equal(badToken.status, 401);
    const crossOrigin = await api(snipPath(), undefined, 'POST', { origin: 'http://evil.example' });
    assert.equal(crossOrigin.status, 403);
    const contentOrigin = await api(snipPath(), undefined, 'POST', { origin: `http://127.0.0.1:${cport}` });
    assert.equal(contentOrigin.status, 403);
    assert.equal((await api(snipPath(store1.wsId, 'nope'))).status, 404);
    assert.equal((await api(snipPath('0000abcd', 'spec'))).status, 404);
    assert.equal((await api(snipPath(), '{oops')).status, 400);
    const get = await ui(snipPath(), auth());
    assert.equal(get.status, 405);
    assert.equal(fakeCalls(), calls, 'no refused request ran the picker');
  });
});

// ------------------------------------------------------------------------------------------------ attachments

describe('attachments on the content origin', () => {
  /** @type {string} */
  let name = '';

  before(async () => {
    useFake('ok');
    const r = await api(snipPath());
    assert.equal(r.status, 200, r.text);
    name = path.basename(r.json().path);
  });

  test('DocState.attachmentBase + the file name serves the stored image', async () => {
    const st = await ui(`/api/docs/${store1.wsId}/spec`, auth());
    assert.equal(st.status, 200, st.text);
    const { contentBase, attachmentBase } = st.json();
    assert.equal(attachmentBase, `${contentBase}/__att/`);
    assert.equal(attachmentBase, `http://127.0.0.1:${cport}/c/${docKey(store1.wsId, 'spec')}/__att/`);
    const url = new URL(`${attachmentBase}${name}`);
    // what the UI's <img> sends: a same-site request from the UI origin
    const r = await content(url.pathname, { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'image' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(String(r.headers['cache-control']), /no-cache/);
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors/);
    assert.ok(r.body.equals(ARCH_PNG));
    // direct navigation (Sec-Fetch-Site: none) and non-browser clients work too; HEAD and revalidation as usual
    assert.equal((await content(url.pathname, { 'sec-fetch-site': 'none' })).status, 200);
    const head = await request({ port: cport, path: url.pathname, method: 'HEAD', headers: { host: `127.0.0.1:${cport}` } });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(ARCH_PNG.length));
    const etag = String(r.headers.etag);
    assert.equal((await content(url.pathname, { 'if-none-match': etag })).status, 304);
  });

  test('a page on the content origin (the doc itself) cannot read attachments', async () => {
    const p = `/c/${docKey(store1.wsId, 'spec')}/__att/${name}`;
    assert.equal((await content(p, { 'sec-fetch-site': 'same-origin' })).status, 404);
    assert.equal((await content(p, { 'sec-fetch-site': 'Same-Origin' })).status, 404);
  });

  test('only image files of that doc: traversal, other docs, other names and symlinks are 404', async () => {
    const key = docKey(store1.wsId, 'spec');
    const otherKey = docKey(store1.wsId, 'other');
    const dir = attachmentsDir();
    fs.writeFileSync(path.join(dir, 'a90.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(dir, '.hidden.png'), TINY_PNG);
    fs.symlinkSync(path.join(TMP, 'outside.png'), path.join(dir, 'a91.png'));
    fs.symlinkSync(path.join(store1.docDir('spec'), 'doc.json'), path.join(dir, 'a92.png'));
    fs.symlinkSync(path.join(dir, 'a90.svg'), path.join(dir, 'a94.png'));
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'a93.png'), TINY_PNG);
    for (const p of [
      `/c/${otherKey}/__att/${name}`, // another doc's key: that doc has no such attachment
      `/c/${'0'.repeat(24)}/__att/${name}`, // unknown key
      `/c/${key.slice(0, 23)}/__att/${name}`, // malformed key
      `/c/${key}/__att`,
      `/c/${key}/__att/`,
      `/c/${key}/__att/sub/a93.png`,
      `/c/${key}/__att/a90.svg`,
      `/c/${key}/__att/notes.txt`,
      `/c/${key}/__att/.hidden.png`,
      `/c/${key}/__att/a91.png`, // symlink out of the store
      `/c/${key}/__att/a92.png`, // symlink to doc.json inside the store
      `/c/${key}/__att/a94.png`, // symlink to the .svg next to it: never served (as SVG or otherwise)
      `/c/${key}/__att/a404.png`,
      `/c/${key}/__att/../doc.json`,
      `/c/${key}/__att/%2e%2e/doc.json`,
      `/c/${key}/__att/..%2fdoc.json`,
      `/c/${key}/__att/%2e%2e%2f%2e%2e%2fconfig.json`,
      `/c/${key}/__att/..%5c..%5cconfig.json`,
      `/c/${key}/live/.specreview/docs/spec/attachments/${name}`, // never through the doc's asset rules either
      `/__att/${name}`,
    ]) {
      const r = await content(p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.equals(ARCH_PNG) && !r.body.equals(TINY_PNG), p);
    }
    // the right key still works
    assert.equal((await content(`/c/${key}/__att/${name}`)).status, 200);
  });

  test('the content origin stays read-only for attachments', async () => {
    const p = `/c/${docKey(store1.wsId, 'spec')}/__att/${name}`;
    const r = await request({ port: cport, path: p, method: 'PUT', headers: { host: `127.0.0.1:${cport}` }, body: 'x' });
    assert.equal(r.status, 405);
    assert.ok(fs.readFileSync(path.join(attachmentsDir(), name)).equals(ARCH_PNG));
  });
});

// ------------------------------------------------------------------------------------------------ vendor module

describe('vendored modern-screenshot (doc snips)', () => {
  const vendorPath = `/__sr/${RENDERER_VERSION}/vendor/modern-screenshot/index.mjs`;

  test('is served as an immutable JavaScript module', async () => {
    const r = await content(vendorPath);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const file = resolveVendor(VENDOR_DOC, 'modern-screenshot/index.mjs');
    assert.ok(file, 'modern-screenshot is installed');
    assert.ok(r.body.equals(fs.readFileSync(/** @type {string} */ (file))));
    assert.match(r.text, /\bexport\s*\{[^}]*\bdomToPng\b/);
    // a self-contained module: no static imports the browser would have to resolve
    assert.doesNotMatch(r.text, /^\s*import\s[^(]/m);
    assert.equal((await content(`/__sr/${RENDERER_VERSION}/vendor/modern-screenshot/../package.json`)).status, 404);
    assert.equal((await content(`/__sr/0/vendor/modern-screenshot/index.mjs`)).status, 404);
  });

  test('a render.network "block" doc may still import it (same origin as the doc and the guest)', async () => {
    const key = docKey(store2.wsId, 'blocked');
    const page = await content(`/c/${key}/live/blocked.md`);
    assert.equal(page.status, 200, page.text);
    const csp = String(page.headers['content-security-policy']);
    const defaultSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('default-src '));
    assert.ok(defaultSrc, csp);
    // no script-src override, so scripts (including dynamic import()) fall back to default-src, which allows 'self'
    assert.ok(!/(^|;)\s*script-src(-elem)?\s/.test(csp), csp);
    assert.ok(defaultSrc.split(/\s+/).includes("'self'"), csp);
    // the guest tag (whose src the guest derives its asset base from) is on the doc's own origin
    const m = /<script src="([^"]+\/guest\.js)"/.exec(page.text);
    assert.ok(m, 'guest tag present');
    const guestUrl = new URL(m[1]);
    assert.equal(guestUrl.origin, `http://127.0.0.1:${cport}`);
    const moduleUrl = new URL(`vendor/modern-screenshot/index.mjs`, guestUrl);
    assert.match(moduleUrl.pathname, new RegExp(`^/__sr/${RENDERER_VERSION}-[0-9a-f]{12}/vendor/modern-screenshot/index\\.mjs$`));
    assert.equal((await content(moduleUrl.pathname)).status, 200);
  });
});
