// @ts-check
// An APPROVED review that also reopens a thread (or answers an agent question, or brings a new suggestion) in the
// same submission. With a final version that is the current head, the packet lists the threads and tells the agent to
// reply with a status (no edits, no new version) and then run `final`: a revise would make the working copy differ
// from the final version. Without a current final version the usual revise flow stays. (Bug report 2026-10-11, item 1.)

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/index.js';
import { setClock } from '../../src/core/util/time.js';
import { editFile, engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;

beforeEach(async () => {
  let t = Date.parse('2026-10-10T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
afterEach(async () => {
  restoreClock();
  await ws.cleanup();
});

const REPLY_NEXT = /^NEXT: approved: answer each thread with suiko reply kitchen-sink <tid> -m <md> --status answered\|declined \(no edits, no new version\) -> suiko final kitchen-sink --decisions {3}\(then stop waiting\)$/m;

/** @param {Awaited<ReturnType<typeof engineCtx>>} ctx */
const wait = async (ctx) => {
  const w = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
  assert.equal(w.status, 'delivered');
  return w;
};

/** @param {Awaited<ReturnType<typeof engineCtx>>} ctx */
const peek = async (ctx) => {
  let text = '';
  await ops.feedback(ctx, DOC, { peek: true, write: (t) => { text = t; } });
  return text;
};

/**
 * Round 1 (a comment and a question), the agent's v2 with replies to both.
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 */
async function roundOne(ctx) {
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Use a grace window.' });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Where does it run?' });
  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  await wait(ctx);
  editFile(ws.file('docs/kitchen-sink.md'), 'rotated on every use', 'rotated with a 30 s grace window');
  const r = await ops.revise(ctx, DOC, {
    summary: 'grace window',
    threads: { t1: { status: 'addressed', reply: 'Added a grace window.' }, t2: { status: 'answered', reply: 'Behind the gateway.' } },
  });
  assert.equal(r.refused, false);
  return v1;
}

test('approved + final with a reopened thread: NEXT says reply with a status, then final; following it clears the thread', async () => {
  const ctx = await engineCtx(ws.root);
  await roundOne(ctx);

  // the reviewer reopens t1 and approves with "Mark v2 final" in the same submission
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Say 30 s in the summary table too.', reopen: true });
  const rv2 = await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, resolveAddressed: true });
  assert.deepEqual(rv2.reopened, ['t1']);

  const w = await wait(ctx);
  assert.match(w.text, /^SPECREVIEW FEEDBACK · kitchen-sink · review rv2 on v2 · APPROVED · FINAL = v2$/m);
  assert.match(w.text, /^\[t1\] REOPENED /m);
  assert.doesNotMatch(w.text, /suiko revise|^PROTOCOL:/m, w.text);
  assert.match(w.text, /^APPROVED with FINAL = v2: reply to each thread; do not edit the spec/m);
  assert.match(w.text, REPLY_NEXT);
  assert.equal(w.packets[0].replyOnly, true);

  // a lost packet: `feedback` without a new review keeps the reply-only guidance
  const again = await peek(ctx);
  assert.match(again, /no new review/);
  assert.doesNotMatch(again, /suiko revise/, again);
  assert.match(again, REPLY_NEXT);

  // follow NEXT literally: the status clears the thread, nothing is left to act on, and final succeeds
  await ops.reply(ctx, DOC, 't1', { body: 'The summary table has no TTL column; left as is.', status: 'declined' });
  const after = await peek(ctx);
  assert.match(after, /^0 threads need action/m, after);
  assert.doesNotMatch(after, /suiko revise/, after);
  assert.match(after, /^NEXT: suiko final kitchen-sink --decisions {3}\(then stop waiting\)$/m);
  const fin = await ops.finalize(ctx, DOC, { decisions: false });
  assert.equal(fin.final.version, 2);
  assert.equal(fin.workingMatches, true);
});

test('approved + final on the first packet with a new suggestion: no PROTOCOL lines and no "apply verbatim" hint', async () => {
  const ctx = await engineCtx(ws.root);
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Optional wording.',
    suggestion: { mode: 'text', new: 'Prototype the issuer behind the gateway.' },
  });
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: 'Ship it.', markFinal: true });
  const w = await wait(ctx);
  assert.equal(w.packets[0].firstPacket, true);
  assert.match(w.text, /^\[t1\] suggestion /m);
  assert.doesNotMatch(w.text, /apply verbatim|^PROTOCOL:|suiko apply|suiko revise/m, w.text);
  assert.equal(w.packets[0].threads[0].apply, null);
  assert.match(w.text, REPLY_NEXT);
});

test('approved without a final version, with a reopened thread: the usual revise flow (edits are allowed)', async () => {
  const ctx = await engineCtx(ws.root);
  await roundOne(ctx);
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Also say 30 s in the table.', reopen: true });
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', resolveAddressed: true });
  const w = await wait(ctx);
  assert.match(w.text, /^\[t1\] REOPENED /m);
  assert.equal(w.packets[0].replyOnly, false);
  assert.doesNotMatch(w.text, /suiko final|no edits/, w.text);
  assert.match(w.text, /^NEXT: edits -> suiko revise kitchen-sink --replies - -> suiko wait kitchen-sink \(background\)$/m);
});

test('an older final version that is no longer head: an approval without "Mark final" never points at `final`', async () => {
  const ctx = await engineCtx(ws.root);
  await roundOne(ctx);
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, resolveAddressed: true });
  await wait(ctx);
  // the agent records v3 after the final v2 (the doc goes back in review); the reviewer approves v3 without a final
  editFile(ws.file('docs/kitchen-sink.md'), 'Prototype the issuer.', 'Prototype the issuer next sprint.');
  const r = await ops.revise(ctx, DOC, { summary: 'timing' });
  assert.equal(r.refused, false);
  assert.equal(r.version, 3);
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '' });
  const w = await wait(ctx);
  assert.doesNotMatch(w.text, /suiko final/, w.text);
  assert.match(w.text, /^NEXT: approved \(no final version marked\); stop waiting unless the reviewer asks for more$/m);
});
