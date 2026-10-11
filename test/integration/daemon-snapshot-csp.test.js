// @ts-check
// The content origin's policy for snapshot docs (design 2.7), against a real daemon on port 0: a snapshot doc (piped
// text, a fetched web page) gets the strict profile (script-src 'self', form-action 'none', base-uri 'none',
// object-src 'none'); a web page's doc.render.network "block" adds the default-src rule even though the workspace
// allows the network, and "allow" lifts it even where the workspace blocks; a file doc's policy is unchanged. The doc
// list carries a web page's URL (source) for the Home view.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-daemon-csp-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
delete process.env.SPECREVIEW_PORT;

const { Store } = await import('../../src/core/store/store.js');
const { startDaemon } = await import('../../src/daemon/main.js');

/** @type {any} */
let d;
/** @type {any} */
let store;
/** @type {any} */
let blocked;

const AGENT = { kind: 'agent', name: 'test' };

/**
 * @param {any} s
 * @param {any} input createSnapshotDoc input
 * @param {string} text
 */
async function snapshot(s, input, text) {
  const { doc } = await s.createSnapshotDoc({ createdBy: AGENT, ...input });
  await s.commitVersion(doc, { source: Buffer.from(text), manifest: { author: AGENT, summary: 'v1', capturedBy: 'open' } });
  return doc;
}

before(async () => {
  const ws = path.join(TMP, 'ws');
  const ws2 = path.join(TMP, 'ws2');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'spec.md'), '# Spec\n\nText.\n');
  store = await Store.open(ws, { create: true });
  const file = await store.createDoc({ path: 'docs/spec.md' });
  await store.commitVersion(file, { source: fs.readFileSync(path.join(ws, 'docs', 'spec.md')), manifest: { author: AGENT, summary: 'v1', capturedBy: 'open' } });
  await snapshot(store, { title: 'Piped', slug: 'piped', origin: { type: 'stdin', key: null } }, '# Piped\n\nText.\n');
  await snapshot(
    store,
    { title: 'Page', slug: 'page', origin: { type: 'url', key: 'url:https://docs.example.com/spec', url: 'https://docs.example.com/spec' }, render: { network: 'block' } },
    '# Page\n\n![x](https://cdn.example.com/x.png)\n',
  );
  blocked = await Store.open(ws2, { create: true });
  const cfgFile = path.join(blocked.storeDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, render: { ...(cfg.render ?? {}), network: 'block' } }));
  await snapshot(
    blocked,
    { title: 'Open page', slug: 'open-page', origin: { type: 'url', key: 'url:https://docs.example.com/open', url: 'https://docs.example.com/open' }, render: { network: 'allow' } },
    '# Open page\n',
  );
  d = await startDaemon({ uiPort: 0, contentPort: 0, logFile: false, idleMs: 0, pingMs: 60_000 });
});

after(async () => {
  await d?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** @param {number} port @param {string} p @param {Record<string, string>} [headers] */
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** @param {string} wsId @param {string} docId */
const docKey = (wsId, docId) => crypto.createHmac('sha256', d.secret).update(`${wsId}/${docId}`).digest('hex').slice(0, 24);

/** @param {any} s @param {string} id @param {string} rel */
async function csp(s, id, rel) {
  const r = /** @type {any} */ (await get(d.contentPort, `/c/${docKey(s.wsId, id)}/live/${rel}`));
  assert.equal(r.status, 200, `${id}: ${r.text}`);
  return String(r.headers['content-security-policy']);
}

describe('content-origin policy of snapshot docs', () => {
  const ancestors = () => `frame-ancestors http://127.0.0.1:${d.uiPort} http://localhost:${d.uiPort}`;
  const STRICT = "script-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'";
  const BLOCK = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'";

  test('a file doc is unchanged', async () => {
    assert.equal(await csp(store, 'spec', 'docs/spec.md'), ancestors());
  });

  test('piped text gets the strict profile', async () => {
    assert.equal(await csp(store, 'piped', 'text/piped.md'), `${ancestors()}; ${STRICT}`);
  });

  test("a web page's own render.network wins over the workspace's, both ways", async () => {
    assert.equal(await csp(store, 'page', 'web/page.md'), `${ancestors()}; ${BLOCK}; ${STRICT}`);
    assert.equal(await csp(blocked, 'open-page', 'web/open-page.md'), `${ancestors()}; ${STRICT}`);
  });

  test('the doc list names the page URL of a web page', async () => {
    const r = /** @type {any} */ (await get(d.uiPort, '/api/docs', { authorization: `Bearer ${d.token}` }));
    assert.equal(r.status, 200);
    const list = JSON.parse(r.text);
    const page = list.find((/** @type {any} */ x) => x.id === 'page');
    assert.deepEqual([page.kind, page.origin, page.source], ['snapshot', 'url', 'https://docs.example.com/spec']);
    assert.equal(list.find((/** @type {any} */ x) => x.id === 'piped').source, undefined);
  });
});
