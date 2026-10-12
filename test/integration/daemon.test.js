// @ts-check
// Integration tests for the daemon (WP5): security (Host 421, token 401, Origin 403, traversal/dotfiles 404, no
// CORS), the content origin (capability paths, live asset allowlist, version blobs, guest tag, Markdown shell asset
// base, root-absolute Referer fallback, ranges), the UI static surface, the JSON API against a stub engine, and SSE
// (append, Last-Event-ID resume, reset, presence, working.changed, global stream).
// Real store + render on temp workspaces; SPECREVIEW_HOME is a temp dir; ports are random (0).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-daemon-'));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
delete process.env.SPECREVIEW_PORT;

const { Store } = await import('../../src/core/store/store.js');
const { NotFoundError, ConflictError, RefusedError } = await import('../../src/core/store/errors.js');
const { startDaemon } = await import('../../src/daemon/main.js');
const { RENDERER_VERSION, SSE } = await import('../../src/shared/protocol.js');

const ARCH_PNG = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'docs', 'img', 'arch.png'));
const OTHER_PNG = Buffer.concat([ARCH_PNG.subarray(0, 8), Buffer.from('changed-image-bytes')]);
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ------------------------------------------------------------------------------------------------ helpers

/**
 * @typedef {{ status: number, headers: http.IncomingHttpHeaders, body: Buffer, text: string, json: () => any }} Resp
 */

/**
 * Raw HTTP request (raw paths, arbitrary Host/Origin).
 * @param {{ port: number, path: string, method?: string, headers?: Record<string, string>, body?: string | Buffer }} o
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

/**
 * @typedef {{ event: string, id: string | null, data: any, raw: string }} SseEvent
 * @typedef {{ status: number, headers: http.IncomingHttpHeaders, events: SseEvent[], body: string,
 *   waitFor: (pred: (e: SseEvent) => boolean, ms?: number) => Promise<SseEvent>, close: () => void }} SseClient
 */

/**
 * Opens an SSE stream and parses events as they arrive.
 * @param {number} port
 * @param {string} p
 * @param {Record<string, string>} [headers]
 * @returns {Promise<SseClient>}
 */
function openSse(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      let buf = '';
      /** @type {SseClient} */
      const client = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        events: [],
        body: '',
        close: () => req.destroy(),
        waitFor: (pred, ms = 5000) =>
          new Promise((ok, fail) => {
            const started = Date.now();
            const tick = () => {
              const hit = client.events.find(pred);
              if (hit) return ok(hit);
              if (Date.now() - started > ms) return fail(new Error(`timed out; got ${JSON.stringify(client.events.map((e) => e.event))}`));
              setTimeout(tick, 20);
            };
            tick();
          }),
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        client.body += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          /** @type {SseEvent} */
          const ev = { event: 'message', id: null, data: null, raw: block };
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length) {
            ev.data = JSON.parse(dataLines.join('\n'));
            client.events.push(ev);
          } else if (ev.id !== null) {
            client.events.push({ ...ev, event: '(id)' });
          }
        }
      });
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} files
 */
function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * Tracks a doc and records v1 with the given asset snapshots.
 * @param {import('../../src/core/store/store.js').Store} store
 * @param {string} rel
 * @param {string[]} [assets]
 */
async function track(store, rel, assets = []) {
  const doc = await store.createDoc({ path: rel });
  const w = await store.readWorking(doc);
  /** @type {Record<string, null>} */
  const assetFiles = {};
  for (const a of assets) assetFiles[a] = null;
  await store.commitVersion(doc, { source: w.buf, assetFiles, manifest: { author: { kind: 'agent', name: 'test' }, summary: 'v1', capturedBy: 'open' } });
  return doc;
}

// ------------------------------------------------------------------------------------------------ fixture

const SPEC_MD = [
  '# Spec',
  '',
  'Intro text with **bold** words.',
  '',
  '![Architecture](img/arch.png)',
  '',
  '![Logo](../assets/logo.png)',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
].join('\n');

const APP_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head>' +
  '<body><h1>App</h1><p>Hello</p><img src="/docs/img/arch.png"></body></html>\n';

/** @type {any} */
let d;
/** @type {import('../../src/core/store/store.js').Store} */
let store1;
/** @type {import('../../src/core/store/store.js').Store} */
let store2;
/** @type {string} */
let ws1;
/** @type {string} */
let ws2;
/** @type {Array<[string, any]>} */
const calls = [];
let token = '';
let uport = 0;
let cport = 0;

/** @type {Record<string, any>} */
const ops = {
  async docState(/** @type {any} */ ctx, /** @type {string} */ docId) {
    calls.push(['docState', docId]);
    return { ws: ctx.wsId, doc: await ctx.store.getDoc(docId), threads: [], locks: [], reviews: [] };
  },
  async domTargets(/** @type {any} */ _ctx, /** @type {string} */ docId, /** @type {any} */ v) {
    calls.push(['domTargets', { docId, v }]);
    return { threads: [{ id: 't1', kind: 'text' }], locks: [] };
  },
  async resolveCapture(/** @type {any} */ _ctx, /** @type {string} */ _docId, /** @type {any} */ input) {
    calls.push(['resolveCapture', input]);
    return { anchor: { kind: input.capture.kind }, preview: { label: 'x' } };
  },
  async saveDraft(/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ item) {
    calls.push(['saveDraft', item]);
    const drafts = await ctx.store.getDrafts(docId);
    const saved = { ...item, id: item.id ?? `d${drafts.items.length + 1}`, updatedAt: 'now' };
    drafts.items = [...drafts.items.filter((/** @type {any} */ x) => x.id !== saved.id), saved];
    await ctx.store.saveDrafts(docId, drafts);
    return saved;
  },
  async deleteDraft(/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {string} */ id) {
    const drafts = await ctx.store.getDrafts(docId);
    if (!drafts.items.some((/** @type {any} */ x) => x.id === id)) throw new NotFoundError(`draft ${id} not found`);
    drafts.items = drafts.items.filter((/** @type {any} */ x) => x.id !== id);
    await ctx.store.saveDrafts(docId, drafts);
  },
  async submitReview(/** @type {any} */ _ctx, /** @type {string} */ docId, /** @type {any} */ input) {
    calls.push(['submitReview', input]);
    return { id: 'rv1', doc: docId, verdict: input.verdict };
  },
  async resolveThread() {
    throw new ConflictError('thread t1 changed concurrently');
  },
  async applySuggestionAsReviewer() {
    throw new RefusedError('the working copy has unrecorded changes');
  },
  async threadMiniDiff(/** @type {any} */ _ctx, /** @type {string} */ _docId, /** @type {string} */ tid) {
    throw new NotFoundError(`thread ${tid} not found`);
  },
  async saveAttachment(/** @type {any} */ _ctx, /** @type {string} */ _docId, /** @type {any} */ input) {
    calls.push(['saveAttachment', input.dataUrl.slice(0, 22)]);
    return 'attachments/a1.png';
  },
  async closeSession() {
    return { closed: true };
  },
  async changes(/** @type {any} */ _ctx, /** @type {string} */ _docId, /** @type {any} */ range) {
    calls.push(['changes', range]);
    return { from: range.from, to: range.to, stats: {}, hunks: [] };
  },
};

before(async () => {
  ws1 = path.join(TMP, 'ws1');
  ws2 = path.join(TMP, 'ws2');
  writeFiles(ws1, {
    'docs/spec.md': SPEC_MD,
    'docs/app.html': APP_HTML,
    'docs/img/arch.png': ARCH_PNG,
    'docs/notes.txt': 'notes\n',
    'docs/run.sh': 'echo hi\n',
    'docs/.env': 'SECRET=1\n',
    'docs/id_rsa': 'PRIVATE\n',
    'docs/server.key': 'PRIVATE\n',
    'docs/media.mp4': Buffer.from('0123456789abcdef'),
    'assets/logo.png': TINY_PNG,
    'assets/unref.png': TINY_PNG,
    '.git/config': '[core]\n',
  });
  fs.writeFileSync(path.join(TMP, 'outside.png'), TINY_PNG);
  fs.symlinkSync(path.join(TMP, 'outside.png'), path.join(ws1, 'docs', 'escape.png'));
  fs.symlinkSync(path.join(ws1, '.git', 'config'), path.join(ws1, 'docs', 'gitcfg.txt'));
  writeFiles(ws2, { 'other.md': '# Other\n\nText.\n', 'secret.png': TINY_PNG });

  store1 = await Store.open(ws1, { create: true });
  store2 = await Store.open(ws2, { create: true });
  await track(store1, 'docs/spec.md', ['docs/img/arch.png', 'assets/logo.png']);
  await track(store1, 'docs/app.html', ['docs/img/arch.png']);
  // ws2 blocks network access for its docs
  const cfgFile = path.join(store2.storeDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, render: { ...(cfg.render ?? {}), network: 'block' } }));
  await track(store2, 'other.md');
  // the live image now differs from the v1 snapshot
  fs.writeFileSync(path.join(ws1, 'docs', 'img', 'arch.png'), OTHER_PNG);

  d = await startDaemon({
    uiPort: 0,
    contentPort: 0,
    ops,
    logFile: false,
    idleMs: 0,
    pingMs: 60_000,
    timing: { pollMs: 40, debounceMs: 40, presenceMs: 80, workingPollMs: 150, globalMs: 80 },
  });
  token = d.token;
  uport = d.uiPort;
  cport = d.contentPort;
});

after(async () => {
  await d?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Authorization header. */
const auth = () => ({ authorization: `Bearer ${token}` });
/** @param {string} wsId @param {string} docId */
const docKey = (wsId, docId) => crypto.createHmac('sha256', d.secret).update(`${wsId}/${docId}`).digest('hex').slice(0, 24);
/** @param {string} p @param {Record<string, string>} [headers] */
const ui = (p, headers = {}) => request({ port: uport, path: p, headers: { host: `127.0.0.1:${uport}`, ...headers } });
/** @param {string} p @param {Record<string, string>} [headers] */
const content = (p, headers = {}) => request({ port: cport, path: p, headers: { host: `127.0.0.1:${cport}`, ...headers } });
/** @param {string} p @param {any} body @param {string} [method] @param {Record<string, string>} [headers] */
const api = (p, body, method = 'POST', headers = {}) =>
  request({
    port: uport,
    path: p,
    method,
    headers: { host: `127.0.0.1:${uport}`, origin: `http://127.0.0.1:${uport}`, 'content-type': 'application/json', ...auth(), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

// ------------------------------------------------------------------------------------------------ security

describe('security', () => {
  test('a wrong Host header is refused with 421 on both origins', async () => {
    const r1 = await ui('/api/health', { host: 'evil.example' });
    assert.equal(r1.status, 421);
    const r2 = await ui('/api/health', { host: `127.0.0.1:${uport + 7}` });
    assert.equal(r2.status, 421);
    const r3 = await content(`/__sr/${RENDERER_VERSION}/guest.js`, { host: `attacker.test:${cport}` });
    assert.equal(r3.status, 421);
    const ok = await ui('/api/health', { host: `localhost:${uport}` });
    assert.equal(ok.status, 200);
  });

  test('/api/* needs the Bearer token, except /api/health', async () => {
    const health = await ui('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.json()).sort(), ['build', 'name', 'ok', 'pid', 'version']);
    assert.equal(health.json().name, 'specreview', 'the protocol name stays specreview after the rename to suiko, so CLIs and daemons of both names recognise each other');
    assert.match(health.json().build, /^[0-9a-f]{16}$/, 'the code identity is an opaque hash, never a path');
    assert.ok(!health.text.includes(token) && !health.text.includes(d.secret));

    const missing = await ui('/api/docs');
    assert.equal(missing.status, 401);
    assert.equal(missing.json().code, 'UNAUTHORIZED');
    assert.match(String(missing.headers['www-authenticate']), /Bearer/);
    assert.equal((await ui('/api/docs', { authorization: 'Bearer nope' })).status, 401);
    // ?k= is only accepted by the SSE endpoint
    assert.equal((await ui(`/api/docs?k=${token}`)).status, 401);
    assert.equal((await ui('/api/docs', auth())).status, 200);
  });

  test('a cross-origin POST is refused with 403, same-origin passes', async () => {
    const p = `/api/docs/${store1.wsId}/spec/reviews`;
    const evil = await api(p, { verdict: 'comment' }, 'POST', { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.json().code, 'FORBIDDEN_ORIGIN');
    const contentOrigin = await api(p, { verdict: 'comment' }, 'POST', { origin: `http://127.0.0.1:${cport}` });
    assert.equal(contentOrigin.status, 403);
    const nullOrigin = await api(p, { verdict: 'comment' }, 'POST', { origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    // Origin of the other loopback name does not match the Host used
    const mixed = await api(p, { verdict: 'comment' }, 'POST', { origin: `http://localhost:${uport}` });
    assert.equal(mixed.status, 403);
    const same = await api(p, { verdict: 'comment' });
    assert.equal(same.status, 200);
  });

  test('no CORS headers, and preflights fail', async () => {
    const r = await request({
      port: uport,
      path: '/api/docs',
      method: 'OPTIONS',
      headers: { host: `127.0.0.1:${uport}`, origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.ok(r.status >= 400);
    for (const resp of [r, await ui('/api/health', { origin: 'http://evil.example' }), await ui('/api/docs', auth())]) {
      assert.equal(Object.keys(resp.headers).filter((h) => h.startsWith('access-control-')).length, 0);
    }
  });

  test('traversal and dotfiles are 404 on the UI origin', async () => {
    for (const p of [
      '/ui/../package.json',
      '/ui/%2e%2e/%2e%2e/package.json',
      '/ui/..%2f..%2fpackage.json',
      '/vendor/htm/../../package.json',
      '/vendor/htm/%2e%2e/%2e%2e/%2e%2e/package.json',
      '/ui/.hidden',
      '/ui//index.html',
      '/ui/..\\..\\package.json',
    ]) {
      const r = await ui(p);
      assert.equal(r.status, 404, p);
    }
  });

  test('nothing on the UI origin can be framed (SEC-1)', async () => {
    // Docs run on the content origin, which is same-site with the UI origin: a framed UI page would share the
    // reviewer's sessionStorage token and could be clickjacked. Every UI-origin response, whatever its route or
    // status, must forbid framing.
    const sse = await openSse(uport, `/api/events?ws=${store1.wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}` });
    sse.close();
    /** @type {Array<[string, { status: number, headers: http.IncomingHttpHeaders }]>} */
    const cases = [
      ['/', await ui('/')],
      ['/d/:ws/:doc', await ui(`/d/${store1.wsId}/spec`)],
      ['HEAD /', await request({ port: uport, path: '/', method: 'HEAD', headers: { host: `127.0.0.1:${uport}` } })],
      ['/ui/main.js', await ui('/ui/main.js')],
      ['/ui/styles/base.css', await ui('/ui/styles/base.css')],
      ['/vendor/preact', await ui('/vendor/htm/preact/standalone.module.js')],
      ['/ui-shared/protocol.js', await ui('/ui-shared/protocol.js')],
      ['/api/health', await ui('/api/health')],
      ['/api/docs', await ui('/api/docs', auth())],
      ['/api/docs 401', await ui('/api/docs')],
      ['/api/events', sse],
      ['POST 403', await api(`/api/docs/${store1.wsId}/spec/reviews`, { verdict: 'comment' }, 'POST', { origin: `http://127.0.0.1:${cport}` })],
      ['404', await ui('/nope')],
      ['/ui/index.html 404', await ui('/ui/index.html')],
      ['421', await ui('/', { host: 'evil.example' })],
    ];
    for (const [name, r] of cases) {
      assert.ok(r.status > 0, name);
      assert.equal(r.headers['x-frame-options'], 'DENY', name);
      const csp = r.headers['content-security-policy'];
      assert.equal(typeof csp, 'string', `${name}: exactly one CSP header`);
      assert.equal(String(csp).match(/frame-ancestors/g)?.length, 1, `${name}: ${csp}`);
      assert.match(String(csp), /(^|;\s*)frame-ancestors 'none'(;|$)/, name);
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', name);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', name);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
    }
    // the SPA page keeps its full UI CSP (it replaces the default one rather than being merged with it)
    for (const [name, r] of cases.slice(0, 3)) {
      const csp = String(r.headers['content-security-policy']);
      assert.ok(csp.startsWith("default-src 'self'; script-src 'self' 'sha256-"), `${name}: ${csp}`);
      assert.ok(csp.includes(`frame-src http://127.0.0.1:${cport}`), name);
    }
    // everything else gets the locked-down default
    for (const [name, r] of cases.slice(3)) {
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", name);
    }
  });

  test('the SPA page cannot be loaded from /ui/* or /vendor/* (no CSP-less copy to frame or to feed ?k=)', async () => {
    for (const p of [
      '/ui/index.html',
      `/ui/index.html?k=${'0'.repeat(32)}`,
      '/ui/index%2Ehtml',
      '/ui/INDEX.HTML',
      '/ui/Index.Html',
      '/vendor/htm/index.html',
      '/vendor/htm/x.svg',
      '/vendor/htm/x.xhtml',
    ]) {
      const r = await ui(p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes('<script'), p);
    }
    const head = await request({ port: uport, path: '/ui/index.html', method: 'HEAD', headers: { host: `127.0.0.1:${uport}` } });
    assert.equal(head.status, 404);
  });

  test('traversal, dotfiles, key files and symlink escapes are 404 on the content origin', async () => {
    const k = docKey(store1.wsId, 'spec');
    for (const p of [
      `/c/${k}/live/../../package.json`,
      `/c/${k}/live/docs/%2e%2e/%2e%2e/outside.png`,
      `/c/${k}/live/docs/.env`,
      `/c/${k}/live/.git/config`,
      `/c/${k}/live/docs/id_rsa`,
      `/c/${k}/live/docs/server.key`,
      `/c/${k}/live/docs/escape.png`,
      `/c/${k}/live/docs/gitcfg.txt`,
      `/c/${k}/live/.specreview/config.json`,
      `/c/${k}/v1/docs/.env`,
      `/__sr/${RENDERER_VERSION}/static/../index.js`,
      `/__sr/${RENDERER_VERSION}/vendor/katex/../../package.json`,
    ]) {
      const r = await content(p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes('SECRET') && !r.text.includes('PRIVATE') && !r.text.includes('[core]'), p);
    }
  });

  test('the content origin has no API and no state-changing routes', async () => {
    assert.equal((await content('/api/health')).status, 404);
    assert.equal((await content('/api/docs', auth())).status, 404);
    const post = await request({ port: cport, path: '/api/shutdown', method: 'POST', headers: { host: `127.0.0.1:${cport}`, ...auth() } });
    assert.equal(post.status, 405);
    const del = await request({ port: cport, path: `/c/${docKey(store1.wsId, 'spec')}/live/docs/spec.md`, method: 'DELETE', headers: { host: `127.0.0.1:${cport}` } });
    assert.equal(del.status, 405);
    // still alive
    assert.equal((await ui('/api/health')).status, 200);
  });

  test('SSE accepts the token as ?k= and refuses a missing or wrong one', async () => {
    const bad = await ui(`/api/events?ws=${store1.wsId}&doc=spec&k=wrong`);
    assert.equal(bad.status, 401);
    const none = await ui(`/api/events?ws=${store1.wsId}&doc=spec`);
    assert.equal(none.status, 401);
  });
});

// ------------------------------------------------------------------------------------------------ content origin

describe('content origin', () => {
  test('the guest tag is inserted right after <head> (Markdown shell)', async () => {
    const k = docKey(store1.wsId, 'spec');
    const r = await content(`/c/${k}/live/docs/spec.md`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], `frame-ancestors http://127.0.0.1:${uport} http://localhost:${uport}`);
    const assetTag = /\/__sr\/([^/]+)\/guest\.js/.exec(r.text)?.[1] ?? '';
    assert.match(assetTag, new RegExp(`^${RENDERER_VERSION}-[0-9a-f]{12}$`), 'asset URLs carry a content hash');
    const tag = `<script src="http://127.0.0.1:${cport}/__sr/${assetTag}/guest.js" data-sr-ui="http://127.0.0.1:${uport} http://localhost:${uport}" data-sr-target="${store1.wsId}/spec/live" data-sr-ignore></script>`;
    const headAt = r.text.indexOf('<head>');
    assert.ok(headAt >= 0);
    assert.equal(r.text.indexOf(tag), headAt + '<head>'.length);
    assert.equal(r.text.split(tag).length, 2, 'exactly one guest tag');
    assert.match(r.text, /data-srid="\d+"/);
  });

  test('the guest tag is inserted right after <head> (HTML doc, version)', async () => {
    const k = docKey(store1.wsId, 'app');
    const r = await content(`/c/${k}/v1/docs/app.html`);
    assert.equal(r.status, 200);
    const expected = '<!doctype html><html lang="en"><head><script src=';
    assert.ok(r.text.startsWith(expected), r.text.slice(0, 120));
    assert.ok(r.text.includes(`data-sr-target="${store1.wsId}/app/v1"`));
    assert.ok(r.text.includes('<meta charset="utf-8"><title>App</title>'));
  });

  test('the Markdown shell asset base is replaced and its assets are served immutable', async () => {
    const k = docKey(store1.wsId, 'spec');
    const r = await content(`/c/${k}/v1/docs/spec.md`);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('__SR_ASSET_BASE__'));
    const assetTag = /\/__sr\/([^/"]+)\//.exec(r.text)?.[1] ?? '';
    assert.match(assetTag, new RegExp(`^${RENDERER_VERSION}-[0-9a-f]{12}$`));
    const base = `http://127.0.0.1:${cport}/__sr/${assetTag}`;
    const urls = [...r.text.matchAll(/(?:href|src)="(http:\/\/127\.0\.0\.1:\d+\/__sr\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(urls.includes(`${base}/vendor/github-markdown-css/github-markdown-light.css`), urls.join('\n'));
    assert.ok(urls.includes(`${base}/static/shell.css`));
    assert.ok(urls.includes(`${base}/vendor/mermaid/mermaid.min.js`), 'mermaid is loaded for the diagram');
    assert.ok(urls.includes(`${base}/static/mermaid-init.js`));
    for (const u of urls) {
      const p = new URL(u).pathname;
      const res = await content(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', p);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      if (p.endsWith('.css')) assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
      if (p.endsWith('.js')) assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    }
    const guest = await content(`/__sr/${RENDERER_VERSION}/guest.js`);
    assert.equal(guest.status, 200);
    assert.equal(guest.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.ok(guest.text.startsWith("(function(){'use strict';"));
    assert.equal((await content('/__sr/r0/guest.js')).status, 404, 'other renderer versions are not served');
    assert.equal((await content(`/__sr/${RENDERER_VERSION}-nothex/guest.js`)).status, 404, 'malformed asset tags are not served');
    assert.equal((await content(`/__sr/${assetTag}/guest.js`)).status, 200);
    const fonts = await content(`/__sr/${RENDERER_VERSION}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`);
    assert.equal(fonts.status, 200);
    assert.equal(fonts.headers['content-type'], 'font/woff2');
  });

  test('a docKey only opens its own doc', async () => {
    const forged = 'ab'.repeat(12);
    assert.equal((await content(`/c/${forged}/live/docs/spec.md`)).status, 404);
    assert.equal((await content(`/c/not-a-key/live/docs/spec.md`)).status, 404);
    const k1 = docKey(store1.wsId, 'spec');
    const k2 = docKey(store2.wsId, 'other');
    // a ws2 key cannot read ws1 files, and the reverse
    assert.equal((await content(`/c/${k2}/live/docs/spec.md`)).status, 404);
    assert.equal((await content(`/c/${k2}/live/docs/img/arch.png`)).status, 404);
    assert.equal((await content(`/c/${k1}/live/other.md`)).status, 404);
    assert.equal((await content(`/c/${k1}/live/secret.png`)).status, 404);
    // a key for a doc that does not exist
    assert.equal((await content(`/c/${docKey(store1.wsId, 'nope')}/live/docs/spec.md`)).status, 404);
    // bad versions
    for (const v of ['v0', 'v99', 'latest', '1', 'v1x']) {
      assert.equal((await content(`/c/${k1}/${v}/docs/spec.md`)).status, 404, v);
    }
    assert.equal((await content(`/c/${k2}/live/other.md`)).status, 200);
  });

  test('live asset allowlist', async () => {
    const k = docKey(store1.wsId, 'spec');
    /** @type {Array<[string, number]>} */
    const cases = [
      ['docs/img/arch.png', 200], // referenced + under the doc dir
      ['assets/logo.png', 200], // referenced, outside the doc dir
      ['assets/unref.png', 404], // outside the doc dir and not referenced
      ['docs/notes.txt', 200], // under the doc dir, allowed extension
      ['docs/media.mp4', 200],
      ['docs/run.sh', 404], // not an allowed extension
      ['docs/missing.png', 404],
      ['docs/app.html', 200], // another page next to the doc: served raw, without the guest
    ];
    for (const [rel, status] of cases) {
      const r = await content(`/c/${k}/live/${rel}`);
      assert.equal(r.status, status, rel);
    }
    const png = await content(`/c/${k}/live/docs/img/arch.png`);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.deepEqual(png.body, OTHER_PNG);
    const raw = await content(`/c/${k}/live/docs/app.html`);
    assert.ok(!raw.text.includes('guest.js'), 'raw pages get no guest');
    assert.equal(raw.text, APP_HTML);
    assert.equal(raw.headers['content-security-policy'], `frame-ancestors http://127.0.0.1:${uport} http://localhost:${uport}`);
  });

  test('version assets come from the manifest blobs; unlisted ones fall back to the live rules', async () => {
    const k = docKey(store1.wsId, 'spec');
    const v1 = await content(`/c/${k}/v1/docs/img/arch.png`);
    assert.equal(v1.status, 200);
    assert.deepEqual(v1.body, ARCH_PNG, 'v1 serves the snapshot');
    assert.match(String(v1.headers.etag), /^"[0-9a-f]{32}"$/);
    const live = await content(`/c/${k}/live/docs/img/arch.png`);
    assert.deepEqual(live.body, OTHER_PNG, 'live serves the working file');
    const logo = await content(`/c/${k}/v1/assets/logo.png`);
    assert.equal(logo.status, 200);
    assert.deepEqual(logo.body, TINY_PNG);
    assert.equal((await content(`/c/${k}/v1/docs/notes.txt`)).status, 200);
    assert.equal((await content(`/c/${k}/v1/assets/unref.png`)).status, 404);
    // conditional GET
    const again = await content(`/c/${k}/v1/docs/img/arch.png`, { 'if-none-match': String(v1.headers.etag) });
    assert.equal(again.status, 304);
  });

  test('root-absolute URLs resolve through the Referer', async () => {
    const k = docKey(store1.wsId, 'app');
    const referer = `http://127.0.0.1:${cport}/c/${k}/v1/docs/app.html`;
    const r = await content('/docs/img/arch.png?x=1', { referer });
    assert.equal(r.status, 307);
    assert.equal(r.headers.location, `/c/${k}/v1/docs/img/arch.png?x=1`);
    const followed = await content(String(r.headers.location));
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body, ARCH_PNG);
    assert.equal((await content('/docs/img/arch.png')).status, 404, 'no Referer');
    assert.equal((await content('/docs/img/arch.png', { referer: `http://evil.example/c/${k}/v1/docs/app.html` })).status, 404);
    assert.equal((await content('/docs/img/arch.png', { referer: `http://127.0.0.1:${cport}/elsewhere` })).status, 404);
  });

  test('media supports byte ranges', async () => {
    const k = docKey(store1.wsId, 'spec');
    const r = await content(`/c/${k}/live/docs/media.mp4`, { range: 'bytes=2-5' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 2-5/16');
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.text, '2345');
    const tail = await content(`/c/${k}/live/docs/media.mp4`, { range: 'bytes=-3' });
    assert.equal(tail.text, 'def');
    const bad = await content(`/c/${k}/live/docs/media.mp4`, { range: 'bytes=100-' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], 'bytes */16');
  });

  test('render.network "block" adds a default-src policy', async () => {
    const r = await content(`/c/${docKey(store2.wsId, 'other')}/live/other.md`);
    assert.equal(r.status, 200);
    assert.equal(
      r.headers['content-security-policy'],
      `frame-ancestors http://127.0.0.1:${uport} http://localhost:${uport}; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'`,
    );
  });

  test('the capability root redirects to the doc', async () => {
    const k = docKey(store1.wsId, 'spec');
    const r = await content(`/c/${k}/live`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `/c/${k}/live/docs/spec.md`);
  });
});

// ------------------------------------------------------------------------------------------------ UI static

describe('UI origin static files', () => {
  test('index pages carry the CSP with the import map hash', async () => {
    for (const p of ['/', `/d/${store1.wsId}/spec`]) {
      const r = await ui(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      const csp = String(r.headers['content-security-policy']);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.ok(csp.includes(`frame-src http://127.0.0.1:${cport}`));
      assert.ok(csp.includes(`img-src 'self' data: blob: http://127.0.0.1:${cport}`));
      const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(r.text);
      assert.ok(m, 'an inline import map is present');
      const hash = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
      const map = JSON.parse(m[1]);
      assert.equal(map.imports['preact-htm'], '/vendor/htm/preact/standalone.module.js');
    }
  });

  test('/vendor, /ui-shared/protocol.js and /ui/* are served with the right types', async () => {
    const preact = await ui('/vendor/htm/preact/standalone.module.js');
    assert.equal(preact.status, 200);
    assert.equal(preact.headers['content-type'], 'text/javascript; charset=utf-8');
    const proto = await ui('/ui-shared/protocol.js');
    assert.equal(proto.status, 200);
    assert.equal(proto.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.ok(proto.text.includes('RENDERER_VERSION'));
    assert.equal((await ui('/vendor/mermaid/mermaid.min.js')).status, 404, 'doc vendors are not on the UI origin');
    assert.equal((await ui('/vendor/nope/x.js')).status, 404);
    assert.equal((await ui('/ui/main.js')).status, 200);
    assert.equal((await ui('/ui/styles/base.css')).headers['content-type'], 'text/css; charset=utf-8');
    // the SPA page exists only at / and /d/:ws/:doc (with its CSP); /ui/* serves subresources only
    assert.equal((await ui('/ui/index.html')).status, 404);
    assert.equal((await ui('/ui/does-not-exist.js')).status, 404);
  });
});

// ------------------------------------------------------------------------------------------------ API (stub engine)

describe('API', () => {
  test('GET /api/docs lists the docs of every workspace', async () => {
    const r = await ui('/api/docs', auth());
    assert.equal(r.status, 200);
    const list = r.json();
    const ids = list.map((/** @type {any} */ x) => `${x.ws}/${x.id}`).sort();
    assert.deepEqual(ids, [`${store1.wsId}/app`, `${store1.wsId}/spec`, `${store2.wsId}/other`].sort());
    const spec = list.find((/** @type {any} */ x) => x.id === 'spec');
    assert.equal(spec.path, 'docs/spec.md');
    assert.equal(spec.head, 1);
    assert.equal(spec.state, 'in_review');
    assert.equal(spec.openThreads, 0);
    assert.equal(spec.undelivered, 0);
    assert.equal(spec.listening, false);
    assert.equal(spec.final, null);
  });

  test('DocState gets contentBase, and the doc URL built from it works', async () => {
    const r = await ui(`/api/docs/${store1.wsId}/spec`, auth());
    assert.equal(r.status, 200);
    const st = r.json();
    assert.equal(st.ws, store1.wsId);
    assert.equal(st.doc.id, 'spec');
    assert.equal(st.contentBase, `http://127.0.0.1:${cport}/c/${docKey(store1.wsId, 'spec')}`);
    const page = await content(`${new URL(st.contentBase).pathname}/v1/${st.doc.path}`);
    assert.equal(page.status, 200);
  });

  test('unknown workspaces, docs and malformed ids are 404', async () => {
    assert.equal((await ui('/api/docs/deadbeef/spec', auth())).status, 404);
    assert.equal((await ui(`/api/docs/${store1.wsId}/nope`, auth())).status, 404);
    assert.equal((await ui(`/api/docs/${store1.wsId}/Bad..Id`, auth())).status, 404);
    assert.equal((await ui(`/api/docs/not-a-ws/spec`, auth())).status, 404);
    assert.equal((await api(`/api/docs/${store1.wsId}/spec/threads/1bad/resolve`, {})).status, 404);
    const r = await ui('/api/nothing-here', auth());
    assert.equal(r.status, 404);
    assert.equal(r.json().code, 'NOT_FOUND');
  });

  test('targets include drafts and the outline of the version', async () => {
    const r = await ui(`/api/docs/${store1.wsId}/spec/versions/v1/targets`, auth());
    assert.equal(r.status, 200);
    const t = r.json();
    assert.deepEqual(t.threads, [{ id: 't1', kind: 'text' }]);
    assert.deepEqual(t.locks, []);
    assert.deepEqual(t.drafts, []);
    assert.equal(t.outline[0].text, 'Spec');
    assert.deepEqual(calls.find((c) => c[0] === 'domTargets')?.[1], { docId: 'spec', v: 1 });
    assert.equal((await ui(`/api/docs/${store1.wsId}/spec/versions/live/targets`, auth())).status, 200);
    assert.equal((await ui(`/api/docs/${store1.wsId}/spec/versions/zz/targets`, auth())).status, 422);
  });

  test('source lines', async () => {
    const r = await ui(`/api/docs/${store1.wsId}/spec/source?v=1&from=1&to=3`, auth());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { v: 1, startLine: 1, lines: ['# Spec', '', 'Intro text with **bold** words.'], total: SPEC_MD.split('\n').length - 1 });
    const live = await ui(`/api/docs/${store1.wsId}/spec/source?v=live&from=11`, auth());
    assert.deepEqual(live.json().lines, ['```']);
    assert.equal((await ui(`/api/docs/${store1.wsId}/spec/source?v=1&from=0`, auth())).status, 422);
    assert.equal((await ui(`/api/docs/${store1.wsId}/spec/source?v=7`, auth())).status, 404);
  });

  test('anchors/resolve validates the capture and defaults the version to head', async () => {
    const p = `/api/docs/${store1.wsId}/spec/anchors/resolve`;
    assert.equal((await api(p, { version: 1 })).status, 422);
    const r = await api(p, { capture: { kind: 'doc' }, widen: true });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.findLast((c) => c[0] === 'resolveCapture')?.[1], { version: 1, capture: { kind: 'doc' }, widen: true });
  });

  test('drafts: create, patch (merged through saveDraft), list, delete', async () => {
    const base = `/api/docs/${store1.wsId}/spec/drafts`;
    const created = await api(base, { id: 'forged', kind: 'thread', type: 'comment', severity: 'normal', body: 'one' });
    assert.equal(created.status, 200);
    const item = created.json();
    assert.equal(item.id, 'd1', 'a client-supplied id is ignored');
    const patched = await api(`${base}/${item.id}`, { body: 'two' }, 'PATCH');
    assert.equal(patched.status, 200);
    assert.equal(patched.json().body, 'two');
    assert.equal(patched.json().type, 'comment');
    const list = (await ui(base, auth())).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].body, 'two');
    assert.equal((await api(`${base}/d9`, { body: 'x' }, 'PATCH')).status, 404);
    assert.equal((await api(`${base}/${item.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await api(`${base}/${item.id}`, undefined, 'DELETE')).status, 404);
  });

  test('reviews are validated and submitted as the reviewer', async () => {
    const p = `/api/docs/${store1.wsId}/spec/reviews`;
    assert.equal((await api(p, { verdict: 'lgtm' })).status, 422);
    assert.equal((await api(p, { verdict: 'comment', draftIds: 'd1' })).status, 422);
    assert.equal((await api(p, { verdict: 'comment', markFinal: 'yes' })).status, 422);
    assert.equal((await api(p, '{not json')).status, 400);
    const r = await api(p, { verdict: 'approved', body: 'ok', markFinal: true, draftIds: ['d2'] });
    assert.equal(r.status, 200);
    const input = calls.findLast((c) => c[0] === 'submitReview')?.[1];
    assert.equal(input.verdict, 'approved');
    assert.equal(input.markFinal, true);
    assert.equal(input.resolveAddressed, false);
    assert.deepEqual(input.draftIds, ['d2']);
    assert.equal(typeof input.by, 'string', 'by is the reviewer name');
    assert.ok(input.by.length > 0);
    assert.equal(input.expectHead, undefined, 'no version given: no head check');
    // The version on screen goes to the engine as expectHead (it refuses an approve of another head with 409).
    assert.equal((await api(p, { verdict: 'approved', reviewedVersion: 'v2' })).status, 422);
    assert.equal((await api(p, { verdict: 'approved', reviewedVersion: 0 })).status, 422);
    assert.equal((await api(p, { verdict: 'approved', expectHead: 1.5 })).status, 422);
    assert.equal((await api(p, { verdict: 'approved', reviewedVersion: 3 })).status, 200);
    assert.equal(calls.findLast((c) => c[0] === 'submitReview')?.[1].expectHead, 3);
    assert.equal((await api(p, { verdict: 'approved', expectHead: 4, reviewedVersion: 3 })).status, 200);
    assert.equal(calls.findLast((c) => c[0] === 'submitReview')?.[1].expectHead, 4);
  });

  test('engine errors map to HTTP statuses', async () => {
    const base = `/api/docs/${store1.wsId}/spec`;
    const conflict = await api(`${base}/threads/t1/resolve`, { decision: 'x' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json().code, 'CONFLICT');
    const refused = await api(`${base}/threads/t1/apply`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, 'REFUSED');
    const missing = await ui(`${base}/threads/t9/minidiff`, auth());
    assert.equal(missing.status, 404);
    assert.match(missing.json().error, /t9/);
    const notImpl = await api(`${base}/locks/L1/relock`, {});
    assert.equal(notImpl.status, 501);
    assert.equal(notImpl.json().code, 'NOT_IMPLEMENTED');
    const wrongMethod = await api(`${base}/drafts`, undefined, 'DELETE');
    assert.equal(wrongMethod.status, 405);
  });

  test('diff defaults: to = head, from = previous version', async () => {
    const r = await ui(`/api/docs/${store1.wsId}/spec/diff?to=live`, auth());
    assert.equal(r.status, 200);
    assert.deepEqual(calls.findLast((c) => c[0] === 'changes')?.[1], { from: 1, to: 'live' });
    await ui(`/api/docs/${store1.wsId}/spec/diff?from=v1&to=1`, auth());
    assert.deepEqual(calls.findLast((c) => c[0] === 'changes')?.[1], { from: 1, to: 1 });
  });

  test('attachments accept only PNG/JPEG data URLs up to 5 MB', async () => {
    const p = `/api/docs/${store1.wsId}/spec/attachments`;
    assert.equal((await api(p, { dataUrl: 'data:text/html;base64,PGI+' })).status, 422);
    assert.equal((await api(p, { dataUrl: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` })).status, 422);
    assert.equal((await api(p, { dataUrl: `data:image/jpeg;base64,${TINY_PNG.toString('base64')}` })).status, 422);
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal((await api(p, { dataUrl: `data:image/png;base64,${big.toString('base64')}` })).status, 413);
    const ok = await api(p, { dataUrl: `data:image/png;base64,${TINY_PNG.toString('base64')}` });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { path: 'attachments/a1.png' });
  });

  test('fragment previews render the doc format; close returns ok', async () => {
    const r = await api(`/api/docs/${store1.wsId}/spec/fragment`, { source: 'Some **bold** <script>alert(1)</script>' });
    assert.equal(r.status, 200);
    assert.match(r.json().html, /<strong>bold<\/strong>/);
    assert.ok(!r.json().html.includes('<script'));
    assert.equal((await api(`/api/docs/${store1.wsId}/spec/fragment`, { source: 3 })).status, 422);
    const c = await api(`/api/docs/${store1.wsId}/spec/close`, {});
    assert.deepEqual(c.json(), { closed: true, ok: true });
  });
});

// ------------------------------------------------------------------------------------------------ SSE

describe('SSE', () => {
  test('delivers appended events and resumes with Last-Event-ID', async () => {
    const wsId = store1.wsId;
    const s1 = await openSse(uport, `/api/events?ws=${wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}` });
    assert.equal(s1.status, 200);
    assert.equal(s1.headers['content-type'], 'text/event-stream; charset=utf-8');
    const start = await s1.waitFor((e) => e.event === '(id)');
    const base = Number(start.id);
    await s1.waitFor((e) => e.event === SSE.PRESENCE);
    await s1.waitFor((e) => e.event === SSE.WORKING_CHANGED);

    const seq = await store1.appendEvent('spec', { type: SSE.THREAD_UPDATED, thread: 't1' });
    assert.equal(seq, base + 1);
    const got = await s1.waitFor((e) => e.event === SSE.THREAD_UPDATED);
    assert.equal(got.id, String(seq));
    assert.equal(got.data.thread, 't1');
    assert.equal(got.data.ws, wsId);
    assert.equal(got.data.doc, 'spec');
    s1.close();

    const s2seq = await store1.appendEvent('spec', { type: SSE.REVIEW_SUBMITTED, review: 'rv1', verdict: 'comment' });
    const s3seq = await store1.appendEvent('spec', { type: SSE.VERSION_CREATED, v: 2 });
    const s2 = await openSse(uport, `/api/events?ws=${wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}`, 'last-event-id': String(seq) });
    const a = await s2.waitFor((e) => e.event === SSE.REVIEW_SUBMITTED);
    const b = await s2.waitFor((e) => e.event === SSE.VERSION_CREATED);
    assert.equal(a.id, String(s2seq));
    assert.equal(b.id, String(s3seq));
    await sleep(150);
    assert.equal(s2.events.filter((e) => e.event === SSE.THREAD_UPDATED).length, 0, 'nothing older is replayed');
    assert.equal(s2.events.filter((e) => e.event === SSE.REVIEW_SUBMITTED).length, 1, 'no duplicates');
    s2.close();

    // query-param form used by the UI when it recreates the stream
    const s3 = await openSse(uport, `/api/events?ws=${wsId}&doc=spec&k=${token}&lastEventId=${s2seq}`, { host: `127.0.0.1:${uport}` });
    await s3.waitFor((e) => e.event === SSE.VERSION_CREATED);
    assert.equal(s3.events.filter((e) => e.event === SSE.REVIEW_SUBMITTED).length, 0);
    s3.close();
  });

  test('an unknown Last-Event-ID gets reset', async () => {
    const s = await openSse(uport, `/api/events?ws=${store1.wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}`, 'last-event-id': '99999' });
    const reset = await s.waitFor((e) => e.event === SSE.RESET);
    assert.equal(reset.id, String(await store1.lastSeq('spec')));
    s.close();
    const s2 = await openSse(uport, `/api/events?ws=${store1.wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}`, 'last-event-id': 'garbage' });
    await s2.waitFor((e) => e.event === SSE.RESET);
    s2.close();
  });

  test('presence follows live waiters; working.changed follows the working file', async () => {
    const s = await openSse(uport, `/api/events?ws=${store1.wsId}&doc=app&k=${token}`, { host: `127.0.0.1:${uport}` });
    const initial = await s.waitFor((e) => e.event === SSE.PRESENCE);
    assert.deepEqual(initial.data.waiters, []);
    const firstWorking = await s.waitFor((e) => e.event === SSE.WORKING_CHANGED);
    assert.equal(firstWorking.data.dirty, false);

    const handle = await store1.registerWaiter('app', { agent: 'claude' });
    const joined = await s.waitFor((e) => e.event === SSE.PRESENCE && e.data.waiters.length === 1);
    assert.equal(joined.data.waiters[0].agent, 'claude');
    assert.equal(joined.data.waiters[0].pid, process.pid);
    await handle.remove();
    await s.waitFor((e) => e.event === SSE.PRESENCE && e.data.waiters.length === 0 && e !== initial);

    fs.writeFileSync(path.join(ws1, 'docs', 'app.html'), APP_HTML.replace('Hello', 'Hello again'));
    const dirty = await s.waitFor((e) => e.event === SSE.WORKING_CHANGED && e.data.dirty === true);
    assert.match(dirty.data.sha256, /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(ws1, 'docs', 'app.html'), APP_HTML);
    await s.waitFor((e) => e.event === SSE.WORKING_CHANGED && e.data.dirty === false && e !== firstWorking);
    s.close();
  });

  test('the global stream carries events of every doc', async () => {
    const s = await openSse(uport, `/api/events?k=${token}`, { host: `127.0.0.1:${uport}` });
    assert.equal(s.status, 200);
    await sleep(200); // first scan
    await store2.appendEvent('other', { type: SSE.DRAFTS_CHANGED });
    const ev = await s.waitFor((e) => e.event === SSE.DRAFTS_CHANGED);
    assert.equal(ev.data.ws, store2.wsId);
    assert.equal(ev.data.doc, 'other');
    assert.equal(ev.id, null, 'global events carry no id');
    s.close();
    const unknownWs = await ui(`/api/events?ws=deadbeef&k=${token}`);
    assert.equal(unknownWs.status, 404);
    const badDoc = await ui(`/api/events?ws=${store1.wsId}&doc=nope&k=${token}`);
    assert.equal(badDoc.status, 404);
  });

  test('closing a stream releases its watcher', async () => {
    const before = d.uiPort; // daemon still serving
    const s = await openSse(uport, `/api/events?ws=${store1.wsId}&doc=spec&k=${token}`, { host: `127.0.0.1:${uport}` });
    await s.waitFor((e) => e.event === SSE.PRESENCE);
    s.close();
    await sleep(100);
    assert.equal(before, uport);
    assert.equal((await ui('/api/health')).status, 200);
  });
});
