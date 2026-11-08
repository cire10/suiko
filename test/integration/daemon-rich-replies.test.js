// @ts-check
// Batched edits and rich replies through the REAL daemon and engine (design spec "Sending & context", "Rich
// replies"):
// - POST /api/docs/:ws/:doc/reviews with `edits` (stored; 422 for anything else) and `apply` (409 for a thread that
//   is not planned, 404 for an unknown one, 422 for a malformed list or with an approval; an Apply submits only the
//   drafts `draftIds` names, none without it, so pending drafts stay drafts);
// - reply drafts with `use` (422 for an attachment of another thread);
// - DocState: the agent reply's attachments, review.edits / apply, versions[].lines / textChars;
// - the content origin serving agent attachments: PNG as before, SVG with the no-script sandboxed CSP, HTML previews
//   with the `sandbox allow-scripts` preview CSP (https: only when render.network is "allow"), frame-ancestors = the
//   UI origins, never to the doc's own origin (Sec-Fetch-Site: same-origin).
// SPECREVIEW_HOME is a temp dir; ports are random (0); the agent's side runs the engine ops in this process.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rich-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
delete process.env.SPECREVIEW_PORT;

const { startDaemon } = await import('../../src/daemon/main.js');
const ops = await import('../../src/core/review/index.js');
const { createContext } = await import('../../src/core/review/context.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>\n';
const HTML = '<!doctype html><html><body><div id="chart"></div><script>document.getElementById("chart").textContent = "42";</script></body></html>\n';

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

/** @type {any} */
let d;
let uport = 0;
let cport = 0;
/** @type {any} */
let ctx1;
/** @type {any} */
let ctx2;
const ws1 = path.join(TMP, 'ws1');
const ws2 = path.join(TMP, 'ws2');

before(async () => {
  fs.mkdirSync(path.join(ws1, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws1, 'out'), { recursive: true });
  fs.mkdirSync(path.join(ws1, '.git'));
  fs.mkdirSync(ws2, { recursive: true });
  fs.mkdirSync(path.join(ws2, '.git'));
  fs.writeFileSync(path.join(ws1, 'docs', 'spec.md'), '# Spec\n\nIntro text.\n\nMore text here.\n');
  fs.writeFileSync(path.join(ws2, 'blocked.md'), '# Blocked\n\nNo network here.\n');
  fs.writeFileSync(path.join(ws1, 'out', 'chart.png'), PNG);
  fs.writeFileSync(path.join(ws1, 'out', 'chart.svg'), SVG);
  fs.writeFileSync(path.join(ws1, 'out', 'chart.html'), HTML);
  fs.writeFileSync(path.join(ws2, 'preview.html'), HTML);
  ctx1 = await createContext({ root: ws1, cwd: ws1, agent: 'claude', reviewer: 'Eric', createStore: true });
  ctx2 = await createContext({ root: ws2, cwd: ws2, agent: 'claude', reviewer: 'Eric', createStore: true });
  const cfgFile = path.join(ctx2.store.storeDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, render: { ...(cfg.render ?? {}), network: 'block' } }));
  await ops.openDoc(ctx1, { path: 'docs/spec.md' });
  await ops.openDoc(ctx2, { path: 'blocked.md' });
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
/** @param {string} p */
const getState = async (p) => {
  const r = await request({ port: uport, path: p, headers: { host: `127.0.0.1:${uport}`, ...auth() } });
  assert.equal(r.status, 200, r.text);
  return r.json();
};
/** @param {string} p @param {any} body @param {string} [method] */
const api = (p, body, method = 'POST') =>
  request({
    port: uport,
    path: p,
    method,
    headers: { host: `127.0.0.1:${uport}`, origin: `http://127.0.0.1:${uport}`, 'content-type': 'application/json', ...auth() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const D1 = () => `/api/docs/${ctx1.wsId}/spec`;
const uiOrigins = () => `http://127.0.0.1:${uport} http://localhost:${uport}`;

describe('batched edits and rich replies through the daemon', () => {
  test('reviews take edits; the agent plans with attachments; DocState shows them with the versions\' lines and textChars', async () => {
    let r = await api(`${D1()}/drafts`, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Add a chart of the latency.' });
    assert.equal(r.status, 200, r.text);
    r = await api(`${D1()}/drafts`, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'Which region?' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await api(`${D1()}/reviews`, { verdict: 'comment', edits: 'later' })).status, 422);
    r = await api(`${D1()}/reviews`, { verdict: 'comment', edits: 'batch', reviewedVersion: 1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().edits, 'batch');
    assert.deepEqual(r.json().newThreads, ['t1', 't2']);

    // the agent (its own process: the engine ops) answers now: a plan with a chart, and an answer
    await ops.feedback(ctx1, 'spec', {});
    await ops.reply(ctx1, 'spec', 't1', { body: 'I will add this chart under "More text here".', status: 'planned', attachments: ['out/chart.png', 'out/chart.svg', 'out/chart.html'] });
    await ops.reply(ctx1, 'spec', 't2', { body: 'eu-west-1.', status: 'answered' });

    const st = await getState(D1());
    const t1 = st.threads.find((/** @type {any} */ t) => t.id === 't1');
    assert.equal(t1.status, 'planned');
    assert.deepEqual(t1.comments.at(-1).attachments, [
      { path: 'attachments/a1.png', name: 'chart.png', kind: 'image' },
      { path: 'attachments/a2.svg', name: 'chart.svg', kind: 'image' },
      { path: 'attachments/a3.html', name: 'chart.html', kind: 'html' },
    ]);
    assert.equal(st.reviews[0].edits, 'batch');
    assert.deepEqual([st.versions[0].lines, st.versions[0].textChars], [5, 'Spec Intro text. More text here.'.length]);
    assert.equal(st.attachmentBase, `http://127.0.0.1:${cport}/c/${docKey(ctx1.wsId, 'spec')}/__att/`);
  });

  test('the content origin serves the attachments: PNG as before, SVG inert, HTML previews sandboxed; never to the doc itself', async () => {
    const base = `/c/${docKey(ctx1.wsId, 'spec')}/__att/`;
    const fromUi = { 'sec-fetch-site': 'same-site' };

    const png = await content(`${base}a1.png`, { ...fromUi, 'sec-fetch-dest': 'image' });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.ok(png.body.equals(PNG));
    assert.match(String(png.headers['content-security-policy']), /frame-ancestors /);
    assert.doesNotMatch(String(png.headers['content-security-policy']), /sandbox/);

    const svg = await content(`${base}a2.svg`, { ...fromUi, 'sec-fetch-dest': 'image' });
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(svg.headers['content-security-policy'], `default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors ${uiOrigins()}`);
    assert.equal(svg.headers['x-content-type-options'], 'nosniff');
    assert.equal(svg.headers['referrer-policy'], 'no-referrer');
    assert.equal(svg.text, SVG);

    const html = await content(`${base}a3.html`, { ...fromUi, 'sec-fetch-dest': 'iframe' });
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(html.headers['x-content-type-options'], 'nosniff');
    assert.equal(html.headers['referrer-policy'], 'no-referrer');
    assert.match(String(html.headers['cache-control']), /no-cache/);
    assert.equal(html.text, HTML);
    const csp = String(html.headers['content-security-policy']).split(';').map((s) => s.trim());
    assert.equal(csp[0], 'sandbox allow-scripts', 'always an opaque origin, even opened as a page');
    assert.ok(!csp.some((s) => /allow-same-origin/.test(s)));
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'unsafe-inline' 'unsafe-eval' https:"), csp.join('; '));
    assert.ok(csp.includes("style-src 'unsafe-inline' https:"));
    assert.ok(csp.includes('connect-src https:'), 'network "allow": https: only, never the daemon');
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(csp.includes(`frame-ancestors ${uiOrigins()}`), 'only the UI may frame it');

    // the doc's own (same-origin) script can read none of them, nor frame a preview
    for (const name of ['a1.png', 'a2.svg', 'a3.html']) {
      const r = await content(`${base}${name}`, { 'sec-fetch-site': 'same-origin' });
      assert.equal(r.status, 404, name);
    }
    // the stored file itself only: a symlink to an attachment is not served
    fs.symlinkSync(path.join(ctx1.store.docDir('spec'), 'attachments', 'a3.html'), path.join(ctx1.store.docDir('spec'), 'attachments', 'a9.html'));
    assert.equal((await content(`${base}a9.html`, fromUi)).status, 404);
  });

  test('render.network "block": an HTML preview loads nothing from the web', async () => {
    await ops.saveDraft(ctx2, 'blocked', { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Show me.' });
    await ops.submitReview(ctx2, 'blocked', { verdict: 'comment' });
    await ops.reply(ctx2, 'blocked', 't1', { body: 'Here.', status: 'answered', attachments: ['preview.html'] });
    const r = await content(`/c/${docKey(ctx2.wsId, 'blocked')}/__att/a1.html`, { 'sec-fetch-site': 'same-site' });
    assert.equal(r.status, 200);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /^sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; /);
    assert.doesNotMatch(csp, /https:|connect-src/);
  });

  test('apply: only planned threads (409 / 404 / 422); an Apply alone keeps pending drafts; use drafts only take attachments of their thread', async () => {
    const p = `${D1()}/reviews`;
    let r = await api(p, { verdict: 'comment', draftIds: [], apply: ['t2'] });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json().error, /^apply: t2 is answered, not planned/);
    assert.equal((await api(p, { verdict: 'comment', draftIds: [], apply: ['t9'] })).status, 404);
    assert.equal((await api(p, { verdict: 'comment', draftIds: [], apply: ['x1'] })).status, 422);
    assert.equal((await api(p, { verdict: 'comment', draftIds: [], apply: 't1' })).status, 422);
    assert.equal((await api(p, { verdict: 'approved', apply: ['t1'] })).status, 422);

    // "Use in doc" on the agent's HTML preview (only an attachment of that thread)
    r = await api(`${D1()}/drafts`, { kind: 'reply', thread: 't2', body: 'Use it.', use: ['attachments/a3.html'] });
    assert.equal(r.status, 422, r.text);
    r = await api(`${D1()}/drafts`, { kind: 'reply', thread: 't1', body: 'Put this in the doc.', use: ['attachments/a3.html'] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json().use, ['attachments/a3.html']);
    const useDraft = r.json().id;
    await api(`${D1()}/drafts`, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Still drafting this one.' });

    r = await api(p, { verdict: 'comment', draftIds: [useDraft], apply: ['t1'], edits: 'batch', reviewedVersion: 1 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json().apply, ['t1']);
    const st = await getState(D1());
    assert.equal(st.drafts.items.length, 1, 'the other draft is still a draft');
    const t1 = st.threads.find((/** @type {any} */ t) => t.id === 't1');
    assert.equal(t1.status, 'open');
    assert.deepEqual(t1.comments.slice(-2).map((/** @type {any} */ c) => [c.body, c.use ?? null, c.apply ?? false]), [
      ['Put this in the doc.', ['attachments/a3.html'], false],
      ['Apply this change.', null, true],
    ]);

    // the agent's packet: APPLY, the plan quoted, the preview's absolute path on a use: line
    const w = await ops.feedback(ctx1, 'spec', { peek: true });
    const text = ops.formatPacket(w);
    assert.match(text, /^APPLY: make every planned change below in one pass/m);
    assert.match(text, /^\[t1\] APPLY · comment · GENERAL$/m);
    assert.ok(text.includes(`  use: ${ctx1.store.attachmentPath('spec', 'attachments/a3.html')} (chart.html) — put this into the doc`), text);
  });

  test('an Apply sent without draftIds submits no draft: the reviewer\'s pending drafts stay drafts', async () => {
    await ops.reply(ctx1, 'spec', 't1', { body: 'I will put the chart under "More text here".', status: 'planned' });
    let st = await getState(D1());
    const pending = st.drafts.items.map((/** @type {any} */ x) => x.id);
    assert.equal(pending.length, 1, 'one unsent draft');
    const r = await api(`${D1()}/reviews`, { verdict: 'comment', apply: ['t1'], reviewedVersion: 1 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json().apply, r.json().newThreads, r.json().replies], [['t1'], [], []]);
    st = await getState(D1());
    assert.deepEqual(st.drafts.items.map((/** @type {any} */ x) => x.id), pending, 'the draft did not go out with the Apply');
    assert.equal(st.threads.find((/** @type {any} */ t) => t.id === 't1').status, 'open');
  });
});
