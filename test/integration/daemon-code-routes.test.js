// @ts-check
// The code-review routes and the code poller of the daemon (WP4; code-contracts.md 11.2 and 11.3) against an
// explicit stub engine (the real ops, with the code ops replaced):
//   - GET D/files (?v= | ?from=&to=), D/files/diff (?path=&v= | &from=&to=, &context=), D/files/source
//     (?path=&v=&side=): the file path decoded from the query ('a/b c.js'), the query reaching the engine, the shapes;
//   - 400 {error:'not a code review', code:'BAD_REQUEST'} on a spec or snapshot doc, 404 for an unknown path (the
//     engine's NotFoundError) or doc, 422 for a malformed v / from / to / context / side / path, 422 with the stub
//     engine's CODE_NOT_AVAILABLE;
//   - the same security as every API route: Host (421), Bearer token (401), GET only;
//   - the poller: a subscribed code doc gets working.changed {dirty, missing:false, sha256, changedFiles} within two
//     poll intervals of a change; nothing polls a doc nobody watches, and polling stops when the last client leaves.
// Temp SPECREVIEW_HOME and workspace, random ports, no network beyond 127.0.0.1.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NotFoundError, UsageError } from '../../src/core/store/errors.js';
import * as realOps from '../../src/core/review/ops.js';
import { CODE_NOT_AVAILABLE } from '../../src/core/code/index.js';
import { SSE } from '../../src/shared/protocol.js';
import { engineCtx, makeWorkspace } from '../helpers/engine.js';

const SPEC = { mode: /** @type {const} */ ('since-base'), base: 'main', context: 3 };
const ORIGIN = { type: 'diff', key: 'diff:since-base:main' };
const POLL_MS = 60;

/** Paths the stub engine knows (a path with a space and a directory, to check the query decoding). */
const PATHS = ['a/b c.js', 'src/a.js'];

/** @type {Array<{ op: string, ref: any, q: any }>} */
const calls = [];
/** What the stub docState reports as the code doc's working tree. */
let working = { dirty: false, missing: false, sha256: 'sha256:aaa', changedFiles: /** @type {string[]} */ ([]) };
/** docState calls by doc id (the poller's reads). */
const stateCalls = new Map();
/** Makes the code ops throw like a build without the code engine. */
let unavailable = false;

const stubOps = {
  ...realOps,
  /** @param {any} ctx @param {any} ref @param {any} q */
  codeFiles: async (ctx, ref, q) => {
    calls.push({ op: 'codeFiles', ref, q });
    if (unavailable) throw new UsageError(CODE_NOT_AVAILABLE, { details: { kind: 'code' } });
    if (q.from !== undefined) {
      return { from: q.from, to: q.to, files: [{ path: 'src/a.js', change: 'changed', added: 1, removed: 1, threads: ['t1'] }] };
    }
    return {
      v: q.v,
      files: PATHS.map((p) => ({ path: p, status: 'M', old: 'sha256:1', new: 'sha256:2', added: 1, removed: 0, threads: [] })),
      skipped: [{ path: '.env', reason: 'excluded' }],
    };
  },
  /** @param {any} ctx @param {any} ref @param {any} q */
  codeFileDiff: async (ctx, ref, q) => {
    calls.push({ op: 'codeFileDiff', ref, q });
    if (!PATHS.includes(q.path)) throw new NotFoundError(`${q.path} is not in this round`, { details: { path: q.path } });
    const rows = [{ op: '+', oldNo: null, newNo: 1, text: 'x', words: [], hunk: `${q.path}#h1` }];
    return { path: q.path, ...(q.from !== undefined ? { from: q.from, to: q.to } : { v: q.v }), hunks: [{ id: `${q.path}#h1`, header: '@@ -0,0 +1 @@', hunkIds: [`${q.path}#h1`], rows, threads: [] }] };
  },
  /** @param {any} ctx @param {any} ref @param {any} q */
  codeFileSource: async (ctx, ref, q) => {
    calls.push({ op: 'codeFileSource', ref, q });
    if (!PATHS.includes(q.path)) throw new NotFoundError(`${q.path} is not in this round`);
    return { path: q.path, side: q.side, v: q.v, text: 'x\n', lines: 1 };
  },
  /** @param {any} ctx @param {any} ref */
  docState: async (ctx, ref) => {
    const id = typeof ref === 'string' ? ref : ref.id;
    stateCalls.set(id, (stateCalls.get(id) || 0) + 1);
    const doc = await ctx.store.requireDoc(id);
    if (doc.kind === 'code') return { ws: ctx.wsId, doc, versions: [], threads: [], working: { ...working } };
    return realOps.docState(ctx, ref);
  },
};

/**
 * @typedef {{ status: number, headers: http.IncomingHttpHeaders, text: string, json: () => any }} Resp
 */

/**
 * @param {{ port: number, path: string, method?: string, headers?: Record<string, string>, body?: string }} o
 * @returns {Promise<Resp>}
 */
function request({ port, path: p, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * @typedef {{ event: string, data: any }} SseEvent
 * @typedef {{ events: SseEvent[], waitFor: (pred: (e: SseEvent) => boolean, ms?: number) => Promise<SseEvent>, close: () => void }} SseClient
 */

/** @param {number} port @param {string} p @param {Record<string, string>} headers @returns {Promise<SseClient>} */
function openSse(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      let buf = '';
      /** @type {SseClient} */
      const client = {
        events: [],
        close: () => req.destroy(),
        waitFor: (pred, ms = 3000) => new Promise((ok, fail) => {
          const started = Date.now();
          const tick = () => {
            const hit = client.events.find(pred);
            if (hit) return ok(hit);
            if (Date.now() - started > ms) return fail(new Error(`timed out; got ${JSON.stringify(client.events)}`));
            setTimeout(tick, 10);
          };
          tick();
        }),
      };
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
          if (data.length) client.events.push({ event, data: JSON.parse(data.join('\n')) });
        }
      });
      resolve(client);
    });
    req.on('error', reject);
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

describe('daemon code routes and poller (stub engine)', () => {
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
    const code = async () => ({
      root: ws.root, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), newSha: null, newTree: null, newSide: 'worktree', baseMoved: null,
      files: [{ path: 'src/a.js', status: 'M', old: await blob('a\n'), new: await blob('b\n'), added: 1, removed: 1 }], skipped: [], stat: {},
    });
    const author = { kind: 'agent', name: 'claude' };
    await ctx.store.commitVersion(doc.id, { source: 'diff 1\n', manifest: { author, summary: 'round 1', respondsTo: null, capturedBy: 'open', code: await code(), hunks: [] } });
    await ctx.store.commitVersion(doc.id, { source: 'diff 2\n', manifest: { author, summary: 'round 2', respondsTo: null, capturedBy: 'round', code: await code(), hunks: [] } });
    const spec = await realOps.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
    specId = /** @type {any} */ (spec).doc?.id ?? /** @type {any} */ (spec).id;
    const { startDaemon } = await import('../../src/daemon/main.js');
    d = await startDaemon({ uiPort: 0, contentPort: 0, ops: stubOps, logFile: false, idleMs: 0, pingMs: 60_000, timing: { codePollMs: POLL_MS } });
  });

  after(async () => {
    await d?.close?.();
    await ws?.cleanup();
  });

  /** @param {string} p @param {Record<string, string>} [headers] */
  const get = (p, headers = {}) => request({ port: d.uiPort, path: p, headers: { host: `127.0.0.1:${d.uiPort}`, authorization: `Bearer ${d.token}`, ...headers } });
  const D = () => `/api/docs/${wsId}/${codeId}`;
  /** @param {string} op */
  const lastCall = (op) => [...calls].reverse().find((c) => c.op === op);

  test('GET D/files?v=N: the file list of a round, with skipped files', async () => {
    const r = await get(`${D()}/files?v=1`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['cache-control'], 'no-store');
    const body = r.json();
    assert.equal(body.v, 1);
    assert.deepEqual(body.files.map((/** @type {any} */ f) => f.path), PATHS);
    assert.deepEqual(body.skipped, [{ path: '.env', reason: 'excluded' }]);
    assert.deepEqual(lastCall('codeFiles')?.q, { v: 1 });
    assert.equal(lastCall('codeFiles')?.ref, codeId);
    // no round given: head
    assert.equal((await get(`${D()}/files`)).status, 200);
    assert.deepEqual(lastCall('codeFiles')?.q, { v: 2 });
    // 'v2' is accepted like every version parameter of the API
    assert.equal((await get(`${D()}/files?v=v2`)).status, 200);
    assert.deepEqual(lastCall('codeFiles')?.q, { v: 2 });
  });

  test('GET D/files?from=A&to=B: the interdiff file list', async () => {
    const r = await get(`${D()}/files?from=1&to=2`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { from: 1, to: 2, files: [{ path: 'src/a.js', change: 'changed', added: 1, removed: 1, threads: ['t1'] }] });
    assert.deepEqual(lastCall('codeFiles')?.q, { from: 1, to: 2 });
    // to alone: from defaults to the round before
    assert.equal((await get(`${D()}/files?to=2`)).status, 200);
    assert.deepEqual(lastCall('codeFiles')?.q, { from: 1, to: 2 });
  });

  test('GET D/files/diff decodes the path from the query and passes the round and context', async () => {
    const r = await get(`${D()}/files/diff?path=${encodeURIComponent('a/b c.js')}&v=2`);
    assert.equal(r.status, 200, r.text);
    const body = r.json();
    assert.equal(body.path, 'a/b c.js');
    assert.equal(body.v, 2);
    assert.equal(body.hunks[0].id, 'a/b c.js#h1');
    assert.deepEqual(body.hunks[0].rows[0], { op: '+', oldNo: null, newNo: 1, text: 'x', words: [], hunk: 'a/b c.js#h1' });
    assert.deepEqual(lastCall('codeFileDiff')?.q, { path: 'a/b c.js', v: 2 });
    // '+' in a query is a space too
    assert.equal((await get(`${D()}/files/diff?path=a/b+c.js&v=1&context=0`)).status, 200);
    assert.deepEqual(lastCall('codeFileDiff')?.q, { path: 'a/b c.js', v: 1, context: 0 });
    const range = await get(`${D()}/files/diff?path=src%2Fa.js&from=1&to=2&context=10`);
    assert.equal(range.status, 200, range.text);
    assert.deepEqual([range.json().from, range.json().to], [1, 2]);
    assert.deepEqual(lastCall('codeFileDiff')?.q, { path: 'src/a.js', from: 1, to: 2, context: 10 });
  });

  test('GET D/files/source returns one side of a file', async () => {
    const r = await get(`${D()}/files/source?path=${encodeURIComponent('a/b c.js')}&v=1&side=old`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { path: 'a/b c.js', side: 'old', v: 1, text: 'x\n', lines: 1 });
    assert.deepEqual(lastCall('codeFileSource')?.q, { path: 'a/b c.js', v: 1, side: 'old' });
    // the side defaults to new, the round to head
    assert.equal((await get(`${D()}/files/source?path=src/a.js`)).status, 200);
    assert.deepEqual(lastCall('codeFileSource')?.q, { path: 'src/a.js', v: 2, side: 'new' });
  });

  test('an unknown path is 404 (the engine NotFoundError), an unknown doc 404', async () => {
    const r = await get(`${D()}/files/diff?path=nope.js&v=1`);
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json().code, 'NOT_FOUND');
    assert.equal((await get(`${D()}/files/source?path=nope.js&v=1&side=new`)).status, 404);
    assert.equal((await get(`/api/docs/${wsId}/no-such-doc/files?v=1`)).status, 404);
  });

  test('a spec or snapshot doc is 400 not a code review, before the engine runs', async () => {
    const before = calls.length;
    for (const sub of ['files?v=1', 'files/diff?path=a.js&v=1', 'files/source?path=a.js&v=1&side=new']) {
      const r = await get(`/api/docs/${wsId}/${specId}/${sub}`);
      assert.equal(r.status, 400, `${sub}: ${r.text}`);
      assert.deepEqual(r.json(), { error: 'not a code review', code: 'BAD_REQUEST' });
    }
    assert.equal(calls.length, before);
  });

  test('a malformed v / from / to / context / side / path is 422, and never reaches the engine', async () => {
    const before = calls.length;
    const bad = [
      'files?v=abc', 'files?v=0', 'files?v=-1', 'files?v=live', 'files?v=1&from=1', 'files?from=x&to=2', 'files?from=1&to=live',
      'files/diff?v=1', 'files/diff?path=&v=1', 'files/diff?path=src/a.js&v=1.5', 'files/diff?path=src/a.js&v=1&context=-1',
      'files/diff?path=src/a.js&v=1&context=abc', 'files/diff?path=src/a.js&v=1&context=100000',
      `files/diff?path=${'x'.repeat(5000)}&v=1`, 'files/diff?path=a%00b&v=1',
      'files/source?path=src/a.js&v=1&side=both', 'files/source?path=src/a.js&v=1&side=', 'files/source?path=src/a.js&from=1&to=2',
      'files/source?v=1',
    ];
    for (const sub of bad) {
      const r = await get(`${D()}/${sub}`);
      assert.equal(r.status, 422, `${sub}: ${r.status} ${r.text.slice(0, 200)}`);
      assert.equal(r.json().code, 'VALIDATION', sub);
    }
    assert.equal(calls.length, before);
  });

  test('a build without the code engine answers 422 with CODE_NOT_AVAILABLE', async () => {
    unavailable = true;
    try {
      const r = await get(`${D()}/files?v=1`);
      assert.equal(r.status, 422, r.text);
      assert.equal(r.json().error, CODE_NOT_AVAILABLE);
    } finally {
      unavailable = false;
    }
  });

  test('the code routes have the API security: Host, Bearer token, GET only', async () => {
    const p = `${D()}/files/diff?path=src%2Fa.js&v=1`;
    assert.equal((await request({ port: d.uiPort, path: p, headers: { host: `127.0.0.1:${d.uiPort}` } })).status, 401);
    assert.equal((await request({ port: d.uiPort, path: p, headers: { host: `127.0.0.1:${d.uiPort}`, authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request({ port: d.uiPort, path: p, headers: { host: 'evil.example:80', authorization: `Bearer ${d.token}` } })).status, 421);
    const post = await request({
      port: d.uiPort, path: `${D()}/files?v=1`, method: 'POST', body: '{}',
      headers: { host: `127.0.0.1:${d.uiPort}`, origin: `http://127.0.0.1:${d.uiPort}`, authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
    });
    assert.ok(post.status === 404 || post.status === 405, `POST D/files: ${post.status}`);
    // nothing of a code doc on the content origin either
    assert.equal((await request({ port: d.contentPort, path: `/c/x/v1/code/${codeId}.diff`, headers: { host: `127.0.0.1:${d.contentPort}` } })).status, 404);
  });

  test('poller: working.changed {dirty, changedFiles} within two intervals while subscribed; nothing without a subscriber', async () => {
    working = { dirty: false, missing: false, sha256: 'sha256:aaa', changedFiles: [] };
    // nobody watches the doc: the poller does not run
    stateCalls.set(codeId, 0);
    await sleep(POLL_MS * 5);
    assert.equal(stateCalls.get(codeId), 0, 'no polling without a subscriber');

    const sse = await openSse(d.uiPort, `/api/events?ws=${wsId}&doc=${codeId}&k=${d.token}`, { host: `127.0.0.1:${d.uiPort}` });
    try {
      const first = await sse.waitFor((e) => e.event === SSE.WORKING_CHANGED);
      assert.deepEqual({ ...first.data, ws: undefined, doc: undefined }, { dirty: false, missing: false, sha256: 'sha256:aaa', changedFiles: [], ws: undefined, doc: undefined });
      assert.equal(first.data.doc, codeId);
      await sleep(POLL_MS * 3);
      assert.ok((stateCalls.get(codeId) || 0) >= 2, `polled while subscribed (${stateCalls.get(codeId)} calls)`);

      // a reviewed file is edited: dirty, with the changed file
      const changedAt = Date.now();
      working = { dirty: true, missing: false, sha256: 'sha256:bbb', changedFiles: ['src/a.js'] };
      const dirty = await sse.waitFor((e) => e.event === SSE.WORKING_CHANGED && e.data.dirty === true, POLL_MS * 2 + 400);
      assert.ok(Date.now() - changedAt <= POLL_MS * 2 + 400, 'within two poll intervals (plus scheduling slack)');
      assert.deepEqual(dirty.data.changedFiles, ['src/a.js']);
      assert.equal(dirty.data.missing, false);
      assert.equal(dirty.data.sha256, 'sha256:bbb');

      // only the diff hash changes (another edit of the same file): no event
      working = { ...working, sha256: 'sha256:ccc' };
      await sleep(POLL_MS * 4);
      assert.equal(sse.events.filter((e) => e.event === SSE.WORKING_CHANGED).length, 2);

      // another file changes: a new event with both files
      working = { dirty: true, missing: false, sha256: 'sha256:ddd', changedFiles: ['a/b c.js', 'src/a.js'] };
      const two = await sse.waitFor((e) => e.event === SSE.WORKING_CHANGED && e.data.changedFiles?.length === 2, POLL_MS * 2 + 400);
      assert.deepEqual(two.data.changedFiles, ['a/b c.js', 'src/a.js']);

      // back to clean
      working = { dirty: false, missing: false, sha256: 'sha256:aaa', changedFiles: [] };
      await sse.waitFor((e) => e.event === SSE.WORKING_CHANGED && e.data.dirty === false && e !== first, POLL_MS * 2 + 400);
    } finally {
      sse.close();
    }
    // the last client left: polling stops
    await sleep(POLL_MS * 3);
    const settled = stateCalls.get(codeId) || 0;
    await sleep(POLL_MS * 5);
    assert.equal(stateCalls.get(codeId), settled, 'no polling after the last subscriber left');
  });

  test('poller: an engine that cannot tell the working state sends nothing (the UI keeps docState)', async () => {
    const orig = stubOps.docState;
    stubOps.docState = async () => {
      throw new UsageError(CODE_NOT_AVAILABLE);
    };
    const sse = await openSse(d.uiPort, `/api/events?ws=${wsId}&doc=${codeId}&k=${d.token}`, { host: `127.0.0.1:${d.uiPort}` });
    try {
      await sse.waitFor((e) => e.event === SSE.PRESENCE);
      await sleep(POLL_MS * 4);
      assert.equal(sse.events.filter((e) => e.event === SSE.WORKING_CHANGED).length, 0);
    } finally {
      sse.close();
      stubOps.docState = orig;
    }
  });
});
