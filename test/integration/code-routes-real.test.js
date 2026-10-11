// @ts-check
// The daemon's code routes (GET D/files, D/files/diff, D/files/source; code-contracts.md 11.2) wired to the REAL ops
// of this build, with no injected engine: a code doc built with the store (two '.diff' rounds, blobs, a binary file)
// goes through every code route, and each answers with the contract's 200 shape or a typed error (404 / 409 / 422
// with {error, code}), never a 500 or a TypeError. Until WP3 lands the code stubs answer 422 'code review is not
// available in this build', which this test accepts like test/unit/review-kind-contract.test.js; the WP3 engine
// keeps it passing with real results, and the shape checks then apply. The query checks (400 on a spec doc, 422 on
// a malformed query) run before the engine and are exact. The poller with the real ops: an SSE client on the code doc
// never gets a malformed working.changed (with the stub engine, none at all).
// Temp SPECREVIEW_HOME and workspace, random ports, no network beyond 127.0.0.1.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as ops from '../../src/core/review/ops.js';
import { CODE_NOT_AVAILABLE } from '../../src/core/code/index.js';
import { SSE } from '../../src/shared/protocol.js';
import { engineCtx, makeWorkspace } from '../helpers/engine.js';

const SPEC = { mode: /** @type {const} */ ('since-base'), base: 'main', context: 3 };
const ORIGIN = { type: 'diff', key: 'diff:since-base:main' };
const POLL_MS = 50;

const OLD_A = 'export function a() {\n  return 1;\n}\n';
const NEW_A1 = 'export function a() {\n  return 2;\n}\n\nexport const b = 3;\n';
const NEW_A2 = '// header\nexport function a() {\n  return 2;\n}\n\nexport const b = 4;\n';
const NEW_C = 'console.log("new");\n';

/**
 * @typedef {{ status: number, text: string, json: () => any }} Resp
 */

/**
 * @param {{ port: number, path: string, method?: string, headers?: Record<string, string> }} o
 * @returns {Promise<Resp>}
 */
function request({ port, path: p, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A 200 checked by `shape`, or a typed error status with a JSON {error, code} body; never a 500 or a JS error.
 * @param {string} name @param {Resp} r @param {(body: any) => void} shape
 * @returns {'ok'|'unavailable'|'error'}
 */
function check(name, r, shape) {
  assert.doesNotMatch(r.text, /TypeError|Cannot read propert|is not a function|undefined \(reading/, name);
  if (r.status === 200) {
    shape(r.json());
    return 'ok';
  }
  assert.ok([404, 409, 422].includes(r.status), `${name}: ${r.status} ${r.text}`);
  const body = r.json();
  assert.equal(typeof body.error, 'string', name);
  assert.equal(typeof body.code, 'string', name);
  return body.error === CODE_NOT_AVAILABLE ? 'unavailable' : 'error';
}

/** @param {any} h a DisplayHunk & {threads} */
function assertDisplayHunk(h) {
  assert.equal(typeof h.id, 'string');
  assert.match(h.header, /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
  assert.ok(Array.isArray(h.hunkIds));
  assert.ok(Array.isArray(h.threads));
  for (const row of h.rows) {
    assert.ok([' ', '-', '+'].includes(row.op));
    assert.equal(typeof row.text, 'string');
    assert.ok(Array.isArray(row.words));
  }
}

describe('daemon code routes with the real ops', () => {
  /** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
  let ws;
  /** @type {any} */
  let d;
  /** @type {string} */
  let wsId;
  /** @type {string} */
  let codeId;
  /** @type {string} */
  let specId;

  before(async () => {
    ws = await makeWorkspace({ files: ['kitchen-sink.md'] });
    const ctx = await engineCtx(ws.root);
    wsId = ctx.store.wsId;
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Feat', slug: 'cr-feat', origin: ORIGIN, code: SPEC });
    codeId = doc.id;
    const blob = (/** @type {string} */ s) => ctx.store.putDocBlob(doc.id, s);
    const code = async (/** @type {string} */ newA) => ({
      root: ws.root, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), newSha: null, newTree: null, newSide: 'worktree', baseMoved: null,
      files: [
        { path: 'img/logo.png', status: 'A', binary: true, added: 0, removed: 0 },
        { path: 'src/a.js', status: 'M', old: await blob(OLD_A), new: await blob(newA), added: 3, removed: 1 },
        { path: 'src/c.js', status: 'A', new: await blob(NEW_C), added: 1, removed: 0 },
      ],
      skipped: [{ path: '.env', reason: 'excluded' }],
      stat: {},
    });
    const author = { kind: 'agent', name: 'claude' };
    await ctx.store.commitVersion(doc.id, {
      source: 'diff --git a/src/a.js b/src/a.js\n@@ -2 +2 @@\n-  return 1;\n+  return 2;\n',
      manifest: { author, summary: 'round 1', respondsTo: null, capturedBy: 'open', code: await code(NEW_A1), hunks: [] },
    });
    await ctx.store.commitVersion(doc.id, {
      source: 'diff --git a/src/a.js b/src/a.js\n@@ -1,0 +1 @@\n+// header\n',
      manifest: {
        author, summary: 'round 2', respondsTo: null, capturedBy: 'round', code: await code(NEW_A2),
        hunks: [{ id: 'src/a.js#h1', file: 'src/a.js', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, threads: [], linkedBy: null, other: 'header' }],
      },
    });
    const spec = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
    specId = /** @type {any} */ (spec).doc?.id ?? /** @type {any} */ (spec).id;
    delete process.env.SPECREVIEW_PORT;
    const { startDaemon } = await import('../../src/daemon/main.js');
    d = await startDaemon({ uiPort: 0, contentPort: 0, logFile: false, idleMs: 0, pingMs: 60_000, timing: { codePollMs: POLL_MS } });
  });

  after(async () => {
    await d?.close?.();
    await ws?.cleanup();
  });

  /** @param {string} p */
  const get = (p) => request({ port: d.uiPort, path: p, headers: { host: `127.0.0.1:${d.uiPort}`, authorization: `Bearer ${d.token}` } });
  const D = () => `/api/docs/${wsId}/${codeId}`;

  test('D/files of a round and between rounds: the contract shape or a typed error', async () => {
    check('files?v=2', await get(`${D()}/files?v=2`), (b) => {
      assert.equal(b.v, 2);
      assert.deepEqual(b.files.map((/** @type {any} */ f) => f.path), ['img/logo.png', 'src/a.js', 'src/c.js']);
      const a = b.files.find((/** @type {any} */ f) => f.path === 'src/a.js');
      assert.equal(a.status, 'M');
      assert.ok(Array.isArray(a.threads));
      assert.equal(b.files.find((/** @type {any} */ f) => f.path === 'img/logo.png').binary, true);
      assert.ok(Array.isArray(b.skipped));
    });
    // no v: the head round
    check('files', await get(`${D()}/files`), (b) => assert.equal(b.v, 2));
    check('files?from=1&to=2', await get(`${D()}/files?from=1&to=2`), (b) => {
      assert.deepEqual([b.from, b.to], [1, 2]);
      for (const f of b.files) {
        assert.ok(['changed', 'added', 'dropped', 'renamed'].includes(f.change), f.path);
        assert.ok(Array.isArray(f.threads));
      }
      assert.ok(b.files.some((/** @type {any} */ f) => f.path === 'src/a.js'));
    });
  });

  test('D/files/diff and D/files/source: the contract shape or a typed error', async () => {
    check('files/diff v2', await get(`${D()}/files/diff?path=src%2Fa.js&v=2`), (b) => {
      assert.equal(b.path, 'src/a.js');
      assert.equal(b.v, 2);
      assert.ok(b.hunks.length > 0);
      b.hunks.forEach(assertDisplayHunk);
    });
    check('files/diff binary', await get(`${D()}/files/diff?path=img%2Flogo.png&v=2`), (b) => {
      assert.equal(b.stub, 'binary');
      assert.deepEqual(b.hunks, []);
    });
    check('files/diff 1..2', await get(`${D()}/files/diff?path=src%2Fa.js&from=1&to=2&context=1`), (b) => {
      assert.deepEqual([b.path, b.from, b.to], ['src/a.js', 1, 2]);
      b.hunks.forEach(assertDisplayHunk);
      const added = b.hunks.flatMap((/** @type {any} */ h) => h.rows).filter((/** @type {any} */ r) => r.op === '+').map((/** @type {any} */ r) => r.text);
      assert.ok(added.includes('// header'));
    });
    check('files/source new', await get(`${D()}/files/source?path=src%2Fa.js&v=2&side=new`), (b) => {
      assert.deepEqual([b.path, b.side, b.v], ['src/a.js', 'new', 2]);
      assert.equal(b.text, NEW_A2);
    });
    check('files/source old', await get(`${D()}/files/source?path=src%2Fa.js&v=1&side=old`), (b) => {
      assert.equal(b.text, OLD_A);
    });
    // a path that is not in the round: 404 from the engine (or the stub's 422)
    const r = await get(`${D()}/files/diff?path=nope.js&v=2`);
    const res = check('files/diff unknown path', r, () => assert.fail('a path not in the round has no diff'));
    if (res !== 'unavailable') assert.equal(r.status, 404, r.text);
  });

  test('the query is checked before the engine: 400 on a spec doc, 422 on a malformed query', async () => {
    const spec = await get(`/api/docs/${wsId}/${specId}/files?v=1`);
    assert.equal(spec.status, 400, spec.text);
    assert.deepEqual(spec.json(), { error: 'not a code review', code: 'BAD_REQUEST' });
    for (const p of [
      '/files?v=abc', '/files?v=1&from=1&to=2', '/files?v=live',
      '/files/diff?v=1', '/files/diff?path=src%2Fa.js&v=1&context=-1',
      '/files/source?path=src%2Fa.js&v=1&side=left', '/files/source?path=src%2Fa.js&from=1&to=2',
    ]) {
      const r = await get(`${D()}${p}`);
      assert.equal(r.status, 422, `${p}: ${r.status} ${r.text}`);
      assert.equal(r.json().code, 'VALIDATION', `${p}: ${r.text}`);
    }
    assert.equal((await get(`/api/docs/${wsId}/nope/files?v=1`)).status, 404);
  });

  test('the poller with the real ops never sends a malformed working.changed', async () => {
    const headers = { host: `127.0.0.1:${d.uiPort}`, accept: 'text/event-stream' };
    /** @type {Array<{ event: string, data: any }>} */
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: d.uiPort, path: `/api/events?ws=${wsId}&doc=${codeId}&k=${d.token}`, headers, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
        }
      });
    });
    try {
      await new Promise((ok) => setTimeout(ok, POLL_MS * 6));
      for (const e of events.filter((x) => x.event === SSE.WORKING_CHANGED)) {
        assert.equal(typeof e.data.dirty, 'boolean');
        assert.equal(e.data.missing, false);
        assert.ok(Array.isArray(e.data.changedFiles));
      }
    } finally {
      req.destroy();
    }
  });
});
