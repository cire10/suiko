// @ts-check
// The code-doc contract (design 2.9): a code doc (createSnapshotDoc({kind: 'code'}) plus two committed '.diff'
// rounds with hand-written manifest.code) goes through EVERY export of ops.js and every daemon D/* route, and each
// call returns a result or a typed error (UsageError, RefusedError, NotFoundError, ConflictError), never a TypeError
// or a 500 from the spec-doc machinery (render, anchors, working file). Until WP3 lands the code stubs throw
// UsageError('code review is not available in this build'), which the contract accepts; the WP3 engine keeps this
// test passing with real results. Also: code-anchored drafts keep `anchor.file` and their lines through a submit
// (at head, and across rounds through the kind forwarder); the fixed refusals (locks, tagged edits, revert,
// snapshot ops) and the content origin's 404 for a code doc.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { ConflictError, NotFoundError, RefusedError, UsageError } from '../../src/core/store/errors.js';
import { anchorFromLines } from '../../src/core/anchor/create.js';
import * as ops from '../../src/core/review/ops.js';
import { CODE_NOT_AVAILABLE } from '../../src/core/code/index.js';
import { TINY_PNG, engineCtx, makeWorkspace } from '../helpers/engine.js';

const SPEC = { mode: /** @type {const} */ ('since-base'), base: 'main', context: 3 };
const ORIGIN = { type: 'diff', key: 'diff:since-base:main' };

const OLD_A = 'export function a() {\n  return 1;\n}\n';
const NEW_A1 = 'export function a() {\n  return 2;\n}\n\nexport const b = 3;\n';
const NEW_A2 = '// header\nexport function a() {\n  return 2;\n}\n\nexport const b = 4;\n';
const NEW_C = 'console.log("new");\n';
const DIFF1 = 'diff --git a/src/a.js b/src/a.js\n@@ -2 +2 @@\n-  return 1;\n+  return 2;\n';
const DIFF2 = 'diff --git a/src/a.js b/src/a.js\n@@ -1,0 +1 @@\n+// header\n';

/** The typed errors of the engine (never TypeError, RangeError or a plain Error). */
const TYPED = [UsageError, RefusedError, NotFoundError, ConflictError];

/**
 * Runs an op: its result, or the typed error it threw (anything else fails the test, with the stack).
 * @param {string} name
 * @param {() => Promise<unknown> | unknown} fn
 * @returns {Promise<{ ok: true, value: any } | { ok: false, err: any }>}
 */
async function outcome(name, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const e = /** @type {any} */ (err);
    assert.ok(
      TYPED.some((C) => err instanceof C),
      `${name} on a code doc threw ${e?.name}: ${e?.message}\n${e?.stack ?? ''}`,
    );
    return { ok: false, err };
  }
}

/**
 * A code anchor as the code engine builds it: anchorFromLines on the file side's text, plus `file` and the file as
 * its section (design 4.7).
 * @param {number} v
 * @param {string} text the file side's text at v
 * @param {number} startLine
 * @param {number} endLine
 */
function codeAnchor(v, text, startLine, endLine) {
  const a = anchorFromLines({ version: v, startLine, endLine, source: text, render: null, format: 'text', config: undefined });
  return { ...a, section: ['src/a.js'], file: { path: 'src/a.js', side: /** @type {const} */ ('new') } };
}

/**
 * A code doc with two rounds and one submitted thread anchored to src/a.js (new side) L2.
 * @returns {Promise<{ ws: Awaited<ReturnType<typeof makeWorkspace>>, ctx: any, id: string }>}
 */
async function codeFixture() {
  const ws = await makeWorkspace({ files: [] });
  const ctx = await engineCtx(ws.root);
  const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Feat token refresh', slug: 'cr-feat', origin: ORIGIN, code: SPEC });
  const blob = (/** @type {string} */ s) => ctx.store.putDocBlob(doc.id, s);
  const manifestCode = async (/** @type {string} */ newA, /** @type {string | null} */ newSha) => ({
    root: ws.root,
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    newSha,
    newTree: null,
    newSide: 'worktree',
    baseMoved: null,
    files: [
      { path: 'src/a.js', status: 'M', old: await blob(OLD_A), new: await blob(newA), added: 3, removed: 1 },
      { path: 'src/c.js', status: 'A', new: await blob(NEW_C), added: 1, removed: 0 },
      { path: 'img/logo.png', status: 'A', binary: true, added: 0, removed: 0 },
    ],
    skipped: [],
    stat: {},
  });
  const author = { kind: 'agent', name: 'claude' };
  await ctx.store.commitVersion(doc.id, {
    source: DIFF1,
    manifest: { author, summary: 'round 1', respondsTo: null, capturedBy: 'open', code: await manifestCode(NEW_A1, null), hunks: [] },
  });
  // round 1 review: one line thread (saved as a draft with its code anchor, then submitted at head)
  await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', anchor: codeAnchor(1, NEW_A1, 2, 2), body: 'Why 2?' });
  const rv1 = await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: 'one thing', by: 'Eric' });
  await ctx.store.commitVersion(doc.id, {
    source: DIFF2,
    manifest: {
      author,
      summary: 'round 2',
      respondsTo: rv1.id,
      capturedBy: 'round',
      code: await manifestCode(NEW_A2, null),
      hunks: [{ id: 'src/a.js#h1', file: 'src/a.js', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, threads: [], linkedBy: null, other: 'header' }],
    },
  });
  return { ws, ctx, id: doc.id };
}

/** Every export of ops.js that is not an op on a doc. */
const NOT_DOC_OPS = new Set(['createContext', 'resolveAgentName', 'parseReviseInput', 'listDocsAcrossWorkspaces', 'docsByActivity']);

describe('every ops.js export on a code doc', () => {
  /** @type {Awaited<ReturnType<typeof codeFixture>>} */
  let f;
  before(async () => {
    f = await codeFixture();
  });
  after(async () => {
    await f.ws.cleanup();
  });

  test('a round-1 draft submitted at head keeps anchor.file and its lines', async () => {
    const t1 = await f.ctx.store.getThread(f.id, 't1');
    assert.deepEqual(t1.anchors['1'].file, { path: 'src/a.js', side: 'new' });
    assert.equal(t1.anchors['1'].src.startLine, 2);
    assert.equal(t1.anchors['1'].src.endLine, 2);
    assert.equal(t1.anchors['1'].src.text, '  return 2;');
  });

  test('a draft at head (v2) keeps anchor.file and its lines through submit', async () => {
    const d = await ops.saveDraft(f.ctx, f.id, { kind: 'thread', type: 'comment', anchor: codeAnchor(2, NEW_A2, 6, 6), body: 'b = 4?' });
    const rv = await ops.submitReview(f.ctx, f.id, { verdict: 'comment', body: '', draftIds: [d.id], by: 'Eric' });
    const t = await f.ctx.store.getThread(f.id, rv.newThreads[0]);
    assert.deepEqual(Object.keys(t.anchors), ['2']);
    assert.deepEqual(t.anchors['2'].file, { path: 'src/a.js', side: 'new' });
    assert.deepEqual([t.anchors['2'].src.startLine, t.anchors['2'].src.endLine], [6, 6]);
    assert.equal(t.anchors['2'].src.text, 'export const b = 4;');
  });

  test('a draft made on v1 is carried to v2 by the kind forwarder, never by forwardAnchor', async () => {
    const d = await ops.saveDraft(f.ctx, f.id, { kind: 'thread', type: 'comment', anchor: codeAnchor(1, NEW_A1, 5, 5), body: 'b = 3?' });
    const res = await outcome('submitReview (across rounds)', () => ops.submitReview(f.ctx, f.id, { verdict: 'comment', body: '', draftIds: [d.id], by: 'Eric' }));
    if (res.ok) {
      // the code engine (WP3): v1 kept as captured, v2 on the same file
      const t = await f.ctx.store.getThread(f.id, res.value.newThreads[0]);
      assert.deepEqual(t.anchors['1'].file, { path: 'src/a.js', side: 'new' });
      assert.deepEqual([t.anchors['1'].src.startLine, t.anchors['1'].src.endLine], [5, 5]);
      assert.equal(t.anchors['2'].file?.path, 'src/a.js');
      assert.ok(Number.isInteger(t.anchors['2'].src?.startLine) || t.anchors['2'].state === 'orphaned');
    } else {
      // the stub forwarder: nothing submitted, the draft untouched
      assert.ok(res.err instanceof UsageError);
      assert.equal(res.err.message, CODE_NOT_AVAILABLE);
      const kept = (await f.ctx.store.getDrafts(f.id)).items.find((/** @type {any} */ x) => x.id === d.id);
      assert.deepEqual(kept?.anchor?.file, { path: 'src/a.js', side: 'new' });
      assert.deepEqual([kept.anchor.src.startLine, kept.anchor.src.endLine], [5, 5]);
      await ops.deleteDraft(f.ctx, f.id, d.id);
    }
  });

  test('every op returns a result or a typed error', async () => {
    const { ctx, id } = f;
    const doc = await ctx.store.requireDoc(id);
    const line = { kind: 'line', file: 'src/a.js', side: 'new', startLine: 2, endLine: 3 };
    /** @type {Record<string, () => Promise<unknown> | unknown>} */
    const calls = {
      openDoc: () => ops.openDoc(ctx, { path: doc.path }),
      docState: () => ops.docState(ctx, id),
      status: () => ops.status(ctx, id),
      log: () => ops.log(ctx, id),
      sourceLines: () => ops.sourceLines(ctx, id, { version: 1, from: 1, to: 2 }),
      closeSession: () => ops.closeSession(ctx, id),
      saveAttachment: () => ops.saveAttachment(ctx, id, { dataUrl: TINY_PNG }),
      threads: () => ops.threads(ctx, id),
      show: async () => [
        await outcome('show thread', () => ops.show(ctx, id, { thread: 't1' })),
        await outcome('show file', () => ops.show(ctx, id, { file: 'src/a.js', side: 'new' })),
        await outcome('show version', () => ops.show(ctx, id, { version: 1, lines: [1, 2] })),
      ],
      resolveCapture: async () => [
        await outcome('resolveCapture line', () => ops.resolveCapture(ctx, id, { version: 2, capture: line })),
        await outcome('resolveCapture file', () => ops.resolveCapture(ctx, id, { version: 2, capture: { kind: 'file', file: 'img/logo.png' } })),
        await outcome('resolveCapture doc', () => ops.resolveCapture(ctx, id, { version: 2, capture: { kind: 'doc' } })),
      ],
      saveDraft: () => ops.saveDraft(ctx, id, { kind: 'thread', type: 'comment', version: 2, capture: line, body: 'x' }),
      updateDraft: () => ops.updateDraft(ctx, id, 'd99', { body: 'y' }),
      deleteDraft: () => ops.deleteDraft(ctx, id, 'd99'),
      listDrafts: () => ops.listDrafts(ctx, id),
      submitReview: () => ops.submitReview(ctx, id, { verdict: 'comment', body: 'a note', by: 'Eric' }),
      resolveThread: () => ops.resolveThread(ctx, id, 't1', { by: 'Eric' }),
      unresolveThread: () => ops.unresolveThread(ctx, id, 't1', {}),
      moveThread: () => ops.moveThread(ctx, id, 't1', { version: 2, capture: line, by: 'Eric' }),
      addLock: () => ops.addLock(ctx, id, { version: 2, capture: { kind: 'doc' }, note: 'n', by: 'Eric' }),
      removeLock: () => ops.removeLock(ctx, id, 'l1', { by: 'Eric' }),
      relock: () => ops.relock(ctx, id, 'l1', { by: 'Eric' }),
      recordReviewerVersion: () => ops.recordReviewerVersion(ctx, id, { summary: 's', by: 'Eric' }),
      applySuggestionAsReviewer: () => ops.applySuggestionAsReviewer(ctx, id, 't1', { by: 'Eric' }),
      feedback: () => ops.feedback(ctx, id, { peek: true }),
      buildDocPacket: () => ops.buildDocPacket(ctx, doc, { allOpen: true }),
      waitForFeedback: async () => [
        await outcome('wait <doc>', () => ops.waitForFeedback(ctx, { docIds: [id], timeoutMs: 30, pollMs: 10 })),
        await outcome('wait --all', () => ops.waitForFeedback(ctx, { docIds: null, timeoutMs: 30, pollMs: 10, allowDirty: false })),
      ],
      applySuggestions: () => ops.applySuggestions(ctx, id, ['t1'], { dryRun: true }),
      taggedEdit: () => ops.taggedEdit(ctx, id, { threads: ['t1'], oldString: 'a', newString: 'b' }),
      taggedEdits: () => ops.taggedEdits(ctx, id, [{ threads: ['t1'], old: 'a', new: 'b' }]),
      revert: () => ops.revert(ctx, id, { hunk: 'src/a.js#h1' }),
      revise: () => ops.revise(ctx, id, { summary: 'round 3', threads: { t1: { status: 'addressed', reply: 'done', at: 'src/a.js:L3' } } }),
      openSnapshot: () => ops.openSnapshot(ctx, { source: '# x\n', origin: { type: 'stdin', key: ORIGIN.key } }),
      recordSnapshot: () => ops.recordSnapshot(ctx, id, { source: '# x\n' }),
      takeSnapshot: () => ops.takeSnapshot(ctx, { source: '# x\n', origin: { type: 'diff', key: ORIGIN.key } }),
      reply: () => ops.reply(ctx, id, 't1', { status: 'addressed', body: 'changed', at: 'src/a.js:L3' }),
      ask: async () => [
        await outcome('ask file', () => ops.ask(ctx, id, { file: 'src/a.js', lines: 'L2', body: 'ok?' })),
        await outcome('ask whole review', () => ops.ask(ctx, id, { body: 'ok?' })),
      ],
      reanchorThread: () => ops.reanchorThread(ctx, id, 't1', { file: 'src/a.js', lines: 'L3' }),
      finalize: () => ops.finalize(ctx, id, { decisions: true }),
      changes: () => ops.changes(ctx, id, { from: 1, to: 2 }),
      sourceDiffOp: () => ops.sourceDiffOp(ctx, id, { from: 1, to: 2 }),
      unifiedDiff: () => ops.unifiedDiff(ctx, id, { from: 1, to: 2 }),
      threadMiniDiff: () => ops.threadMiniDiff(ctx, id, 't1'),
      domTargets: () => ops.domTargets(ctx, id, 2),
      openCodeReview: () => ops.openCodeReview(ctx, { input: { mode: 'since-base' } }),
      codeFiles: async () => [
        await outcome('codeFiles v', () => ops.codeFiles(ctx, id, { v: 2 })),
        await outcome('codeFiles from/to', () => ops.codeFiles(ctx, id, { from: 1, to: 2 })),
      ],
      codeFileDiff: () => ops.codeFileDiff(ctx, id, { path: 'src/a.js', v: 2 }),
      codeFileSource: () => ops.codeFileSource(ctx, id, { path: 'src/a.js', v: 2, side: 'new' }),
    };
    const missing = Object.keys(ops).filter((k) => typeof (/** @type {any} */ (ops)[k]) === 'function' && !NOT_DOC_OPS.has(k) && !(k in calls));
    assert.deepEqual(missing, [], 'every ops.js export has a contract call (or is listed in NOT_DOC_OPS)');

    /** @type {Record<string, any>} */
    const out = {};
    for (const [name, fn] of Object.entries(calls)) out[name] = await outcome(name, fn);
    if (process.env.CONTRACT_DEBUG) for (const [k, o] of Object.entries(out)) console.log(k, o.ok ? "OK" : `${o.err.name}: ${o.err.message}`, Array.isArray(o.value) ? o.value.map((x) => (x.ok ? "OK" : x.err.message)).join(" / ") : "");
    // the op-independent ones: also on a code doc
    assert.ok((await outcome('listDocsAcrossWorkspaces', () => ops.listDocsAcrossWorkspaces(ctx))).ok);
    assert.ok((await outcome('docsByActivity', () => ops.docsByActivity(ctx))).ok);

    // fixed outcomes (they hold with the stubs and with the WP3 engine)
    const refused = (/** @type {string} */ name, /** @type {RegExp} */ re) => {
      assert.ok(!out[name].ok && out[name].err instanceof RefusedError && re.test(out[name].err.message), `${name}: ${out[name].err?.message}`);
    };
    refused('addLock', /code reviews have no locks/);
    refused('relock', /code reviews have no locks/);
    refused('taggedEdit', /edit the files with your own tools/);
    refused('taggedEdits', /edit the files with your own tools/);
    refused('revert', /edit the files with your own tools/);
    assert.ok(out.recordSnapshot.err instanceof UsageError && /not a snapshot doc/.test(out.recordSnapshot.err.message));
    assert.ok(out.openSnapshot.err instanceof ConflictError, 'a snapshot never lands in a code doc (same origin key)');
    assert.ok(out.takeSnapshot.err instanceof UsageError, "origin type 'diff' is reserved for code reviews");
    assert.ok(!out.openDoc.ok, 'the synthetic code/<id>.diff path is not a file doc');
    assert.deepEqual(out.domTargets.value, { version: 2, threads: [], locks: [], drafts: [], outline: [] });
    const st = out.status.value.docs.find((/** @type {any} */ d) => d.doc === id);
    assert.equal(st.kind, 'code');
    assert.equal(st.origin, 'diff');
    assert.equal(st.file, null);
    assert.equal(st.pathFromCwd, null);
    assert.ok(out.sourceLines.ok && out.log.ok && out.listDrafts.ok && out.closeSession.ok && out.saveAttachment.ok);
    // a code doc is never a "file" in the cross-workspace list
    const listed = (await ops.listDocsAcrossWorkspaces(ctx)).find((/** @type {any} */ d) => d.id === id || d.doc === id);
    if (listed && 'kind' in listed) assert.equal(listed.kind, 'code');

    // nothing was written at the synthetic path, and thread anchors still carry their file
    const fs = await import('node:fs');
    assert.equal(fs.existsSync(f.ws.file('code')), false);
    for (const t of await ctx.store.listThreads(id)) {
      for (const [v, a] of Object.entries(t.anchors)) {
        if (a.kind !== 'doc') assert.equal(a.file?.path, 'src/a.js', `${t.id}@v${v} keeps its file`);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ daemon routes

/**
 * @param {{ port: number, path: string, method?: string, headers?: Record<string, string>, body?: unknown }} o
 * @returns {Promise<{ status: number, text: string }>}
 */
function request({ port, path: p, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { connection: 'close', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('every daemon D/* route on a code doc', () => {
  /** @type {Awaited<ReturnType<typeof codeFixture>>} */
  let f;
  /** @type {any} */
  let d;
  before(async () => {
    f = await codeFixture();
    delete process.env.SPECREVIEW_PORT;
    const { startDaemon } = await import('../../src/daemon/main.js');
    d = await startDaemon({ uiPort: 0, contentPort: 0, logFile: false, idleMs: 0, pingMs: 60_000 });
  });
  after(async () => {
    await d?.close();
    await f.ws.cleanup();
  });

  test('each route answers with a result or a typed error status, never a 500', async () => {
    const ws = f.ctx.store.wsId;
    const D = `/api/docs/${ws}/${f.id}`;
    const api = (/** @type {string} */ method, /** @type {string} */ p, /** @type {unknown} */ body) =>
      request({
        port: d.uiPort,
        path: `${D}${p}`,
        method,
        body,
        headers: { host: `127.0.0.1:${d.uiPort}`, origin: `http://127.0.0.1:${d.uiPort}`, authorization: `Bearer ${d.token}` },
      });
    const line = { kind: 'line', file: 'src/a.js', side: 'new', startLine: 2, endLine: 3 };
    // POST D/snip/screen is left out: it opens the native region picker on macOS (and is kind-independent: the
    // image is saved with saveAttachment, covered by POST D/attachments)
    /** @type {Array<[string, string, unknown?]>} */
    const routes = [
      ['GET', ''],
      ['GET', '/versions/2/targets'],
      ['GET', '/versions/live/targets'],
      ['GET', '/source?v=1'],
      ['GET', '/source'],
      ['POST', '/anchors/resolve', { version: 2, capture: line }],
      ['GET', '/drafts'],
      ['POST', '/drafts', { kind: 'thread', type: 'comment', version: 2, capture: line, body: 'x' }],
      ['PATCH', '/drafts/d99', { body: 'y' }],
      ['DELETE', '/drafts/d99'],
      ['POST', '/reviews', { verdict: 'comment', body: 'note' }],
      ['POST', '/threads/t1/resolve', {}],
      ['POST', '/threads/t1/unresolve', {}],
      ['POST', '/threads/t1/move', { version: 2, capture: line }],
      ['POST', '/threads/t1/apply', {}],
      ['GET', '/threads/t1/minidiff'],
      ['POST', '/locks', { version: 2, capture: { kind: 'doc' } }],
      ['DELETE', '/locks/l1'],
      ['POST', '/locks/l1/relock', {}],
      ['GET', '/diff?from=1&to=2'],
      ['GET', '/diff/source?from=1&to=2'],
      ['POST', '/record', { summary: 's' }],
      ['POST', '/attachments', { dataUrl: TINY_PNG }],
      ['POST', '/fragment', { source: '<b>x</b>' }],
      ['POST', '/close', {}],
    ];
    for (const [method, p, body] of routes) {
      const r = await api(method, p, body);
      assert.ok([200, 404, 409, 422].includes(r.status), `${method} D${p}: ${r.status} ${r.text}`);
      assert.doesNotMatch(r.text, /TypeError|Cannot read propert|is not a function|undefined \(reading/, `${method} D${p}`);
    }
    const locks = await api('POST', '/locks', { version: 2, capture: { kind: 'doc' } });
    assert.equal(locks.status, 409);
    assert.match(JSON.parse(locks.text).error, /code reviews have no locks/);
    const targets = JSON.parse((await api('GET', '/versions/2/targets')).text);
    assert.deepEqual(targets.outline, []);
    // the doc list labels it a code review
    const list = await request({ port: d.uiPort, path: '/api/docs', headers: { host: `127.0.0.1:${d.uiPort}`, authorization: `Bearer ${d.token}` } });
    const entry = JSON.parse(list.text).find((/** @type {any} */ x) => x.id === f.id);
    assert.equal(entry.kind, 'code');
    assert.equal(entry.origin, 'diff');
  });

  test('the content origin serves nothing of a code doc but its attachments', async () => {
    const ws = f.ctx.store.wsId;
    const key = crypto.createHmac('sha256', d.secret).update(`${ws}/${f.id}`).digest('hex').slice(0, 24);
    const att = await ops.saveAttachment(f.ctx, f.id, { dataUrl: TINY_PNG });
    const content = (/** @type {string} */ p) => request({ port: d.contentPort, path: p, headers: { host: `127.0.0.1:${d.contentPort}` } });
    for (const p of [`/c/${key}/v1/code/${f.id}.diff`, `/c/${key}/v2/code/${f.id}.diff`, `/c/${key}/live/code/${f.id}.diff`, `/c/${key}/v1`, `/c/${key}/live/src/a.js`, `/c/${key}/v1/img/logo.png`]) {
      assert.equal((await content(p)).status, 404, p);
    }
    const name = String(typeof att === 'string' ? att : /** @type {any} */ (att).path).split('/').pop();
    assert.equal((await content(`/c/${key}/__att/${name}`)).status, 200, 'review screenshots stay reachable');
  });
});
