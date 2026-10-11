// @ts-check
// An APPROVED review that also reopens a thread (or answers an agent question) in the same submission: the packet
// lists the thread, and NEXT says to reply (no edits, no new version) and then run `final`, never to revise. A revise
// would make the working copy differ from the final version. (Bug report 2026-10-11, item 1.)

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/index.js';
import { setClock } from '../../src/core/util/time.js';
import { editFile, engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;

before(async () => {
  let t = Date.parse('2026-10-10T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
after(async () => {
  restoreClock();
  await ws.cleanup();
});

test('approved + final with a reopened thread: NEXT says reply then final, and final still succeeds', async () => {
  const ctx = await engineCtx(ws.root);
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Use a grace window.' });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Where does it run?' });
  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });

  editFile(ws.file('docs/kitchen-sink.md'), 'rotated on every use', 'rotated with a 30 s grace window');
  const r = await ops.revise(ctx, DOC, {
    summary: 'grace window',
    threads: { t1: { status: 'addressed', reply: 'Added a grace window.' }, t2: { status: 'answered', reply: 'Behind the gateway.' } },
  });
  assert.equal(r.refused, false);

  // the reviewer reopens t1 and approves with "Mark v2 final" in the same submission
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Say 30 s in the summary table too.', reopen: true });
  const rv2 = await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, resolveAddressed: true });
  assert.deepEqual(rv2.reopened, ['t1']);

  const w = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
  assert.equal(w.status, 'delivered');
  assert.match(w.text, /^SPECREVIEW FEEDBACK · kitchen-sink · review rv2 on v2 · APPROVED · FINAL = v2$/m);
  assert.match(w.text, /^\[t1\] REOPENED /m);
  assert.doesNotMatch(w.text, /specreview revise/, w.text);
  assert.match(
    w.text,
    /^NEXT: approved: answer each thread with specreview reply kitchen-sink <tid> -m <md> \(no edits, no new version\) -> specreview final kitchen-sink --decisions {3}\(then stop waiting\)$/m,
  );

  // following NEXT keeps the working copy equal to the final version
  await ops.reply(ctx, DOC, 't1', { body: 'The summary table has no TTL column; left as is.', status: 'declined' });
  const fin = await ops.finalize(ctx, DOC, { decisions: false });
  assert.equal(fin.final.version, 2);
  assert.equal(fin.workingMatches, true);
});

test('approved without a final version, with an answered thread: NEXT says reply, then stop', async () => {
  const ws2 = await makeWorkspace();
  try {
    const ctx = await engineCtx(ws2.root);
    const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
    const v1 = await ctx.render(opened.doc, 1);
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Why?' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', body: '' });
    await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    await ops.reply(ctx, DOC, 't1', { body: 'Do you want a grace window?', status: 'needs_input' });
    await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'No, keep it.' });
    await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '' });
    const w = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    assert.match(w.text, /^\[t1\] ANSWER /m);
    assert.match(w.text, /^NEXT: approved: answer each thread with specreview reply kitchen-sink <tid> -m <md> \(no edits, no new version\); then stop waiting$/m);
  } finally {
    await ws2.cleanup();
  }
});
