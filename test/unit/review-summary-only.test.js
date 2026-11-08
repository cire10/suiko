// @ts-check
// A review whose only feedback is its summary (no thread, not an approval): the summary is the request, so the NEXT
// line says how to record the change it asks for (the steps of a round, with `-m <what changed>` instead of thread
// replies) instead of "nothing to act on". Per kind: a file doc, a code review, a text snapshot, a page built from
// sources, a public page. An approval with a summary, and a later packet without a new review, are unchanged.
// (Release check of 0.4.0, 2026-11-08: a comment review with only "Please tighten the wording..." said NEXT: nothing
// to act on.)

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/index.js';
import { codeNextStep } from '../../src/core/code/packet.js';
import { setClock } from '../../src/core/util/time.js';
import { editFile, engineCtx, makeWorkspace } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
const ASK = 'Please tighten the wording of the second paragraph.';
/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;

beforeEach(async () => {
  let t = Date.parse('2026-11-08T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
afterEach(async () => {
  restoreClock();
  await ws.cleanup();
});

/**
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 * @param {string} id
 */
const wait = async (ctx, id) => {
  const w = await ops.waitForFeedback(ctx, { docIds: [id], pollMs: 20, write: () => {} });
  assert.equal(w.status, 'delivered');
  return w;
};

test('a file doc: the summary is the request; following NEXT records the change, and the next packet has nothing to act on', async () => {
  const ctx = await engineCtx(ws.root);
  await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  await ops.submitReview(ctx, DOC, { verdict: 'comment', body: ASK });
  const w = await wait(ctx, DOC);
  assert.match(w.text, new RegExp(`^Reviewer summary: ${ASK}$`, 'm'));
  assert.match(w.text, /^0 threads need action/m);
  assert.equal(w.packets[0].next, 'act on the reviewer summary (no thread asks for anything): edits it asks for, if any -> suiko revise kitchen-sink -m <what changed> -> suiko wait kitchen-sink (background)');
  assert.match(w.text, /^NEXT: act on the reviewer summary \(no thread asks for anything\): edits it asks for, if any -> suiko revise kitchen-sink -m <what changed> -> suiko wait kitchen-sink \(background\)$/m);
  assert.doesNotMatch(w.text, /nothing to act on|JSON, one entry per thread/);
  // follow it: edit, revise with a summary (no replies needed)
  editFile(ws.file('docs/kitchen-sink.md'), 'Prototype the issuer.', 'Prototype the issuer first.');
  const r = await ops.revise(ctx, DOC, { summary: 'tightened the second paragraph' });
  assert.equal(r.refused, false);
  assert.equal(r.version, 2);
  // no new review: the summary was answered with v2, nothing is left to act on
  const peek = await ops.feedback(ctx, DOC, { peek: true });
  assert.equal(peek.next, 'nothing to act on; suiko wait kitchen-sink (background)');
  // "Needs changes" with only a summary is the same request
  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: 'Shorter, please.' });
  assert.match((await wait(ctx, DOC)).packets[0].next, /^act on the reviewer summary \(no thread asks for anything\): /);
});

test('an approval with a summary keeps its usual NEXT; a review with neither threads nor a summary is never sent', async () => {
  const ctx = await engineCtx(ws.root);
  await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', body: '  \n' }), /nothing to submit: no drafts and no summary/);
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: 'Ship it.', markFinal: true });
  assert.equal((await wait(ctx, DOC)).packets[0].next, 'suiko final kitchen-sink --decisions   (then stop waiting)');
});

test('snapshots: a text snapshot records new text, a page built from sources is snapshotted again, a public page is not edited', async () => {
  const ctx = await engineCtx(ws.root);
  const lead = 'act on the reviewer summary (no thread asks for anything): ';
  const msg = await ops.openSnapshot(ctx, { source: '# Plan\n\nShip it.\n', origin: { type: 'message', key: 'claude-msg:s:m' } });
  await ops.submitReview(ctx, msg.doc.id, { verdict: 'comment', body: ASK });
  assert.equal((await wait(ctx, msg.doc.id)).packets[0].next, `${lead}write the complete revised text to a file -> suiko revise ${msg.doc.id} --source <file> -m <what changed> -> suiko wait ${msg.doc.id} (background)`);

  const src = '# Status page\n\nThe build is green.\n';
  const built = await ops.takeSnapshot(ctx, { source: src, format: 'markdown', origin: { type: 'url', key: 'http://localhost:3000/', url: 'http://localhost:3000/', private: true }, title: 'Status' });
  await ops.submitReview(ctx, built.doc.id, { verdict: 'comment', body: ASK });
  assert.equal((await wait(ctx, built.doc.id)).packets[0].next, `${lead}edit the sources that produce the page -> suiko snapshot http://localhost:3000/ --allow-private (records v2) -> suiko wait ${built.doc.id} (background)`);

  const pub = await ops.takeSnapshot(ctx, { source: src, format: 'markdown', origin: { type: 'url', key: 'https://example.com/status', url: 'https://example.com/status' }, title: 'Public' });
  await ops.submitReview(ctx, pub.doc.id, { verdict: 'comment', body: ASK });
  assert.equal((await wait(ctx, pub.doc.id)).packets[0].next, `${lead}a public page is not edited; do what it asks -> suiko wait ${pub.doc.id} (background)`);
});

test('code reviews: the round for each mode, recorded with -m instead of replies', () => {
  const open = { approved: false, finalNow: false };
  const lead = 'act on the reviewer summary (no thread asks for anything): ';
  const doc = (/** @type {any} */ code) => /** @type {any} */ ({ id: 'c1', state: 'in_review', head: 1, code });
  assert.equal(codeNextStep(doc({ mode: 'staged' }), 'c1', open, 0, true), `${lead}edit the files -> git add <files> -> suiko revise c1 -m <what changed> -> suiko wait c1 (background)`);
  assert.equal(codeNextStep(doc({ mode: 'branch', base: 'main' }), 'c1', open, 0, true), `${lead}edit -> commit -> suiko revise c1 -m <what changed> -> suiko wait c1 (background)`);
  assert.equal(codeNextStep(doc({ mode: 'worktree' }), 'c1', open, 0, true), `${lead}edit the files -> suiko revise c1 -m <what changed> (records round v2 from your working tree) -> suiko wait c1 (background)`);
  // without the summary flag: unchanged
  assert.equal(codeNextStep(doc({ mode: 'staged' }), 'c1', open, 0), 'nothing to act on; suiko wait c1 (background)');
  assert.equal(codeNextStep(doc({ mode: 'staged' }), 'c1', open, 2), 'edit the files -> git add <files> -> suiko revise c1 --replies - -> suiko wait c1 (background)');
});
