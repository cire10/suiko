// @ts-check
// `wait` / `feedback` delivery (design 5.4 "Delivery", 9.2; BUILD_AMENDMENTS 2.4): dirty working copy refusal,
// timeouts and aborts, a single waiter per (doc, agent) (a newer wait supersedes the older one and the review is
// delivered exactly once), delivery only after the write resolved (a failed write re-delivers), closed sessions,
// `wait --all`, `feedback --peek` / `--include-drafts`, and the ack of delivered reviews by the agent's next op.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SSE } from '../../src/shared/protocol.js';
import * as ops from '../../src/core/review/index.js';
import { editFile, engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
const FILE = 'docs/kitchen-sink.md';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

/** open the fixture; returns the ctx and the v1 render */
async function opened() {
  const ctx = await engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: FILE });
  const v1 = await ctx.render(doc, 1);
  return { ctx, doc, v1 };
}

/**
 * Submits a one-comment review.
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 * @param {any} v1
 * @param {string} [quote]
 */
async function submitOne(ctx, v1, quote = 'rotated on every use') {
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, quote), body: `About "${quote}".` });
  return ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
}

/**
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 * @param {string} type
 */
async function eventsOf(ctx, type) {
  return (await ctx.store.readEvents(DOC, 0)).filter((e) => e.type === type);
}

/** Resolves once `pred()` is true (polls every 10 ms, fails after 5 s). */
async function until(/** @type {() => Promise<boolean> | boolean} */ pred) {
  const end = Date.now() + 5000;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('until: condition not met in 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('wait', () => {
  test('a dirty working copy is refused unless allowDirty', async () => {
    const { ctx, v1 } = await opened();
    await submitOne(ctx, v1);
    editFile(ws.file(FILE), 'Prototype the issuer.', 'Prototype the issuer first.');
    const r = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    assert.deepEqual([r.status, r.docId, r.packets.length], ['dirty', DOC, 0]);
    assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude, undefined, 'nothing delivered');
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), [], 'no waiter registered');

    const ok = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, allowDirty: true, write: () => {} });
    assert.equal(ok.status, 'delivered');
    assert.match(ok.text, /^Line numbers = current file on disk \(working copy differs from v1: lines mapped\)\.$/m);
  });

  test('times out with no review and removes its waiter file', async () => {
    const { ctx } = await opened();
    let started = null;
    const r = await ops.waitForFeedback(ctx, {
      docIds: [DOC],
      timeoutMs: 120,
      pollMs: 20,
      onStart: async (info) => {
        started = info;
      },
    });
    assert.equal(r.status, 'timeout');
    assert.deepEqual(started, { docs: [{ id: DOC, head: 1, path: FILE }], agent: 'claude', pid: process.pid });
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), []);
  });

  test('an abort signal ends the wait', async () => {
    const { ctx } = await opened();
    const ac = new AbortController();
    const p = ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 1000, signal: ac.signal });
    await until(async () => (await ctx.store.listWaiters(DOC)).length === 1);
    ac.abort();
    const r = await p;
    assert.deepEqual([r.status, r.aborted], ['timeout', true]);
  });

  test('a newer wait supersedes the older one; the review is delivered exactly once', async () => {
    const { ctx, v1 } = await opened();
    // Two live pids of the same agent: the parent process plays the older `wait`, this process the newer one.
    const older = ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, pid: process.ppid, write: () => assert.fail('the superseded wait must not deliver') });
    await until(async () => (await ctx.store.listWaiters(DOC)).some((w) => w.pid === process.ppid));
    /** @type {string[]} */
    const writes = [];
    const newer = ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: (t) => void writes.push(t) });
    const r1 = await older;
    assert.deepEqual([r1.status, r1.by, r1.packets.length], ['superseded', process.pid, 0]);
    // the newer wait marks the older one superseded just before writing its own waiter file
    await until(async () => (await ctx.store.listWaiters(DOC)).length === 1);
    assert.deepEqual((await ctx.store.listWaiters(DOC)).map((w) => w.pid), [process.pid], 'only the newer waiter is live');

    await submitOne(ctx, v1);
    const r2 = await newer;
    assert.equal(r2.status, 'delivered');
    assert.equal(writes.length, 1);
    assert.deepEqual(r2.packets[0].reviews.map((r) => r.id), ['rv1']);
    assert.equal((await eventsOf(ctx, SSE.REVIEW_DELIVERED)).length, 1);

    // a later wait finds nothing new
    const r3 = await ops.waitForFeedback(ctx, { docIds: [DOC], timeoutMs: 80, pollMs: 20, write: () => assert.fail('nothing to deliver') });
    assert.equal(r3.status, 'timeout');
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), []);
  });

  test('a waiter of another agent is not superseded', async () => {
    const { ctx, v1 } = await opened();
    const other = await engineCtx(ws.root, { agent: 'codex' });
    const a = ops.waitForFeedback(other, { docIds: [DOC], pollMs: 20, pid: process.ppid, write: () => {} });
    await until(async () => (await ctx.store.listWaiters(DOC)).length === 1);
    const b = ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    await until(async () => (await ctx.store.listWaiters(DOC)).length === 2);
    await submitOne(ctx, v1);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], ['delivered', 'delivered']);
    assert.deepEqual(Object.keys((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo ?? {}).sort(), ['claude', 'codex']);
  });

  test('delivery is recorded only after the write resolved; a failed write re-delivers next time', async () => {
    const { ctx, v1 } = await opened();
    await submitOne(ctx, v1);
    await assert.rejects(
      ops.waitForFeedback(ctx, {
        docIds: [DOC],
        pollMs: 20,
        write: async () => {
          throw new Error('EPIPE');
        },
      }),
      /EPIPE/,
    );
    assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude, undefined);
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), [], 'waiter removed on error');
    const again = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    assert.equal(again.status, 'delivered');
    assert.ok((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude);
  });

  test('a closed session ends the wait', async () => {
    const { ctx } = await opened();
    const p = ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20 });
    await until(async () => (await ctx.store.listWaiters(DOC)).length === 1);
    await ops.closeSession(ctx, DOC);
    const r = await p;
    assert.deepEqual([r.status, r.docId], ['closed', DOC]);
    const again = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20 });
    assert.equal(again.status, 'closed');
  });

  test('wait --all registers one _all waiter and delivers any doc', async () => {
    const { ctx, v1 } = await opened();
    const p = ops.waitForFeedback(ctx, { docIds: null, pollMs: 20, write: () => {} });
    await until(async () => (await ctx.store.listWaiters('_all')).length === 1);
    assert.deepEqual(await ctx.store.listWaiters(DOC), []);
    await submitOne(ctx, v1);
    const r = await p;
    assert.deepEqual([r.status, r.docId, r.packets.map((x) => x.doc)], ['delivered', DOC, [DOC]]);
  });
});

describe('feedback and ack', () => {
  test('--peek neither delivers nor acks; feedback delivers; the next agent op acks once', async () => {
    const { ctx, v1 } = await opened();
    await submitOne(ctx, v1);
    const peek = await ops.feedback(ctx, DOC, { peek: true });
    assert.deepEqual(peek.reviews.map((r) => r.id), ['rv1']);
    assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude, undefined);

    /** @type {Array<[string, any]>} */
    const out = [];
    const fb = await ops.feedback(ctx, DOC, { write: (t, p) => void out.push([t, p]) });
    assert.equal(fb.threads.length, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0][0], ops.formatPacket(fb), 'write gets the formatted packet');
    assert.deepEqual(out[0][1], fb, 'and the packet object (--json)');
    let rv1 = await ctx.store.getReview(DOC, 'rv1');
    assert.ok(rv1?.deliveredTo?.claude);
    assert.equal(rv1?.ackedBy?.claude, undefined, 'delivery itself is not an ack');

    await ops.show(ctx, DOC, { thread: 't1' });
    rv1 = await ctx.store.getReview(DOC, 'rv1');
    assert.ok(rv1?.ackedBy?.claude, 'show acks');
    const ackedAt = rv1?.ackedBy?.claude;
    await ops.reply(ctx, DOC, 't1', { body: 'Looking into it.' });
    assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.ackedBy?.claude, ackedAt, 'acked once');
    assert.deepEqual((await eventsOf(ctx, SSE.REVIEW_ACKED)).map((e) => [e.review, e.agent]), [['rv1', 'claude']]);

    // no new review: the packet still lists what is open (an agent reply without a status leaves t1 open)
    const empty = await ops.feedback(ctx, DOC, {});
    assert.deepEqual(empty.reviews, []);
    assert.match(ops.formatPacket(empty), /^SPECREVIEW FEEDBACK · kitchen-sink · no new review · head v1\n/);
    assert.match(ops.formatPacket(empty), /^\[t1\] STILL OPEN · comment · L51 /m);
  });

  test('reviewer ops do not ack; agent ops of another agent do not ack for claude', async () => {
    const { ctx, v1 } = await opened();
    await submitOne(ctx, v1);
    await ops.feedback(ctx, DOC, {});
    await ops.resolveThread(ctx, DOC, 't1', {});
    const codex = await engineCtx(ws.root, { agent: 'codex' });
    await ops.show(codex, DOC, { thread: 't1' });
    assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.ackedBy?.claude, undefined);
  });

  test('--include-drafts labels unsubmitted drafts', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Which region?' });
    const p = await ops.feedback(ctx, DOC, { peek: true, includeDrafts: true });
    const text = ops.formatPacket(p);
    assert.match(text, /0 submitted reviews pending; 1 DRAFT comment not yet submitted \(ask the reviewer to click Submit review\)/);
    assert.match(text, /Which region\?/);
  });
});
