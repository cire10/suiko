// @ts-check
// Batched edits and rich replies on a file doc (design spec "Sending & context", "Rich replies"):
// - status `planned`: a reply that says what the agent will change without editing; not actionable, so `wait` never
//   counts it as unanswered; a replies-only revise posts it without a doc change; threads / status / DomTargets;
// - Review.edits ('now' | 'batch'): stored on the review (approvals: always 'now'); a thread is batched by the newest
//   review that handed it over, delivered or not, so the EDITS line and the replies-only NEXT come back when
//   `suiko feedback` re-reads a delivered round; a packet with batched and edit-now threads names the batched ones;
//   a batched suggestion is planned, not applied; the unanswered refusal knows a thread is batched;
// - apply: only planned threads (else Conflict / NotFound / Usage, nothing changes); without draftIds it submits no
//   draft; the thread reopens with an "Apply this change." request (marked `apply`), the packet labels it APPLY with
//   the reviewer's original request above the planned reply and the APPLY header line (record as NEXT says: also a
//   snapshot of a page built from sources), `wait` hands it back until the change is recorded, then Verify;
// - agent attachments on replies (reply, revise threads.tN.attachments): copied as attachments/aN.<ext> with their
//   original names and kinds; every refusal writes nothing; a replies-only revise that fails part way never hands
//   an attachment id out again;
// - replies-only revise: an `addressed` reply with nothing recorded warns (a file loaded at runtime is not versioned);
// - "Use in doc": a reviewer reply's `use` (only attachments of its thread) is kept by drafts, stored on the comment
//   and printed as `use:` lines (with a final approval: whether it goes into a next version); on a resolved thread
//   it reopens it;
// - textChars / lines of versions (manifests and DocState).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../../src/shared/protocol.js';
import { ConflictError, NotFoundError, UsageError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/index.js';
import { isActionable } from '../../src/core/review/threadstate.js';
import { loadAttachments } from '../../src/core/review/attachments.js';
import { useLine } from '../../src/core/review/packet.js';
import { editFile, engineCtx, makeWorkspace, textCapture, TINY_PNG } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
const FILE = 'docs/kitchen-sink.md';
const PNG = Buffer.from(TINY_PNG.split(',')[1], 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#4f46e5"/></svg>\n';
const HTML = '<!doctype html><html><body><canvas id="c"></canvas><script>document.title = "chart";</script></body></html>\n';

const EDITS_LINE =
  'EDITS: batch. Answer every thread now. For a change you agree to make, do not edit the doc yet: reply with status "planned" and say exactly what you will change; questions get "answered". The edits come later in one APPLY packet.';
const APPLY_LINE = 'APPLY: make every planned change below in one pass, then record ONE version as NEXT says (status addressed).';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

async function opened() {
  const ctx = await engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: FILE });
  const v1 = await ctx.render(doc, 1);
  return { ctx, doc, v1 };
}

/**
 * Submits a review with a comment on "rotated on every use" (t1) and a general question (t2).
 * @param {any} ctx
 * @param {any} v1
 * @param {Record<string, unknown>} [extra] submitReview input (edits...)
 */
async function twoThreads(ctx, v1, extra = {}) {
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Add a grace window.' });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'Why Redis?' });
  return ops.submitReview(ctx, DOC, { verdict: 'comment', body: '', ...extra });
}

/**
 * Delivers what is pending (wait) and returns the result.
 * @param {any} ctx
 * @param {Record<string, unknown>} [o]
 */
function deliver(ctx, o = {}) {
  return ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, timeoutMs: 150, write: () => {}, ...o });
}

/**
 * A thread item block of a packet text.
 * @param {string} text
 * @param {string} tid
 */
function itemOf(text, tid) {
  return text.split('\n\n').find((b) => b.startsWith(`[${tid}]`)) ?? '';
}

/**
 * Writes files into the workspace root (relative paths), returning their absolute paths.
 * @param {Record<string, string | Buffer>} files
 */
function writeFiles(files) {
  const out = /** @type {Record<string, string>} */ ({});
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    out[rel] = abs;
  }
  return out;
}

/** @param {any} ctx */
function attachmentFiles(ctx) {
  const dir = path.join(ctx.store.docDir(DOC), 'attachments');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('planned (batched edits)', () => {
  test('a planned reply answers the thread: not actionable, wait does not refuse it, a replies-only revise posts it without a doc change', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1, { edits: 'batch' });
    assert.equal((await deliver(ctx)).status, 'delivered');
    // nothing answered yet: refused
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'unanswered');

    const r = await ops.revise(ctx, DOC, {
      threads: { t1: { status: 'planned', reply: 'I will add a 30 s grace window to the rotation paragraph.' }, t2: { status: 'answered', reply: 'Lower latency.' } },
    });
    assert.equal(r.repliesOnly, true, 'no doc change: the replies are posted without a version');
    assert.deepEqual(r.replies, [{ thread: 't1', status: 'planned' }, { thread: 't2', status: 'answered' }]);
    assert.equal(ops.formatReviseReport(r), `suiko: working copy matches v1; posted 2 replies (no new version)\n  t1 planned\n  t2 answered\nnext: suiko wait ${DOC} (background)\n`);
    assert.equal((await ctx.store.getDoc(DOC))?.head, 1, 'no version recorded');
    const t1 = /** @type {any} */ (await ctx.store.getThread(DOC, 't1'));
    assert.equal(t1.status, 'planned');
    assert.equal(isActionable(t1), false);
    // wait --require-answers: a planned thread is answered (it waits for the reviewer's APPLY)
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'timeout');

    // listings: threads --status planned, status counts, DomTargets (painted as a planned change: "Will change")
    assert.deepEqual((await ops.threads(ctx, DOC, { status: 'planned' })).threads.map((t) => t.id), ['t1']);
    const st = await ops.status(ctx, DOC);
    assert.equal(st.docs[0].counts.planned, 1);
    assert.match(ops.formatStatus(st), /needs_input 0 · planned 1 · resolved 0/);
    const targets = await ops.domTargets(ctx, DOC, 1);
    assert.equal(targets.threads.find((/** @type {any} */ t) => t.id === 't1')?.state, 'planned');
    // the packet of the doc now: nothing to act on, the planned thread waits for the reviewer
    const p = await ops.feedback(ctx, DOC, { peek: true, allOpen: true });
    assert.equal(p.counts.actionable, 0);
    assert.equal(p.counts.planned, 1);
    const shown = await ops.show(ctx, DOC, { thread: 't1' });
    assert.match(ops.formatThread(shown), /^\[t1\] comment · PLANNED · /);
  });

  test('suiko reply --status planned (ops.reply) does the same; a reviewer reply on a planned thread hands it back as a REPLY', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1, { edits: 'batch' });
    await deliver(ctx);
    const res = await ops.reply(ctx, DOC, 't1', { body: 'I will add a grace window.', status: 'planned' });
    assert.equal(res.thread.status, 'planned');
    assert.equal(ops.formatReply(res), 'replied on t1 (planned) · no version recorded\n');
    await ops.reply(ctx, DOC, 't2', { body: 'Latency.', status: 'answered' });
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'timeout');

    // the reviewer comments on the plan (no reopen): the thread is the agent's again, still planned
    await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Make it 60 s.' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
    const w = await deliver(ctx);
    assert.equal(w.status, 'delivered');
    assert.match(itemOf(w.text, 't1'), /^\[t1\] REPLY · comment · /);
    assert.match(itemOf(w.text, 't1'), /^ {2}claude \(v1, planned\): I will add a grace window\.$/m);
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.status, 'planned');
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'unanswered');
    await ops.reply(ctx, DOC, 't1', { body: 'I will add a 60 s grace window.', status: 'planned' });
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'timeout');
  });
});

describe('edits: now | batch', () => {
  test('stored on the review: default now, batch kept, an approval is always now; anything else is refused', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'x' });
    assert.equal((await ops.submitReview(ctx, DOC, { verdict: 'comment' })).edits, 'now');
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'y' });
    const batch = await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', edits: 'batch' });
    assert.equal(batch.edits, 'batch');
    assert.equal((await ctx.store.getReview(DOC, batch.id))?.edits, 'batch', 'persisted');
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', body: 'z', edits: 'later' }), UsageError);
    const approved = await ops.submitReview(ctx, DOC, { verdict: 'approved', edits: 'batch' });
    assert.equal(approved.edits, 'now', 'an approval asks for no edits');
    const st = await ops.docState(ctx, DOC);
    assert.deepEqual(st.reviews.map((/** @type {any} */ r) => r.edits), ['now', 'batch', 'now']);
  });

  test('the EDITS line (and a replies-only NEXT) only when a delivered review asked for batched edits', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    const now = await deliver(ctx);
    assert.doesNotMatch(now.text, /^EDITS:/m);
    assert.equal(now.packets[0].edits, 'now');
    assert.match(now.text, /^NEXT: edits, if any -> suiko revise kitchen-sink --replies - \(JSON, one entry per thread\) -> /m);

    await ops.revise(ctx, DOC, { threads: { t1: { status: 'declined', reply: 'Out of scope.' }, t2: { status: 'answered', reply: 'Latency.' } } });
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Name the owner.' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
    const batch = await deliver(ctx);
    assert.equal(batch.packets[0].edits, 'batch');
    const lines = batch.text.split('\n');
    const counts = lines.findIndex((l) => /^1 thread needs action/.test(l));
    assert.ok(counts > 0, batch.text);
    assert.equal(lines[counts + 1], EDITS_LINE, 'right under the counts line, before the threads');
    assert.equal(lines.at(-2), `NEXT: replies only, no edits yet -> suiko revise ${DOC} --replies - (JSON, one entry per thread) -> suiko wait ${DOC} (background)`);
  });

  test('batched edits on snapshots: piped text answers with suiko reply; a plan gets no EDITS line', async () => {
    const ctx = await engineCtx(ws.root);
    const piped = await ops.openSnapshot(ctx, { source: '# Notes\n\nShip it on Friday.\n', origin: { type: 'stdin', key: 'stdin:notes' } });
    const plan = await ops.openSnapshot(ctx, { source: '# Plan\n\n1. Do it.\n', origin: { type: 'plan', key: 'plan:k1' }, title: 'Plan' });
    for (const doc of [piped.doc, plan.doc]) {
      await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Which Friday?' });
      await ops.submitReview(ctx, doc.id, { verdict: 'comment', edits: 'batch' });
    }
    const p1 = ops.formatPacket(await ops.feedback(ctx, piped.doc.id, { peek: true }));
    assert.match(p1, /^EDITS: batch\. Answer every thread now\./m);
    assert.match(p1, new RegExp(`^NEXT: answer each thread with suiko reply ${piped.doc.id} <tid> -m <md> --status planned\\|answered\\|declined \\(no edits yet\\) -> suiko wait ${piped.doc.id} \\(background\\)$`, 'm'));
    const p2 = ops.formatPacket(await ops.feedback(ctx, plan.doc.id, { peek: true }));
    assert.doesNotMatch(p2, /^EDITS:/m, 'the plan gate wants the plan edited');
    assert.doesNotMatch(p2, /no edits yet/);
  });

  test('a delivered batched round re-read with `suiko feedback` says what `wait` said: the EDITS line and the replies-only NEXT', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1, { edits: 'batch' });
    const w = await deliver(ctx);
    const pick = (/** @type {string} */ text) => text.split('\n').filter((l) => /^(EDITS|NEXT):/.test(l));
    const said = pick(w.text);
    assert.deepEqual(said, [EDITS_LINE, `NEXT: replies only, no edits yet -> suiko revise ${DOC} --replies - (JSON, one entry per thread) -> suiko wait ${DOC} (background)`]);
    // the agent lost the packet (a compaction; the prompt hook tells it to run `suiko feedback`)
    const again = await ops.feedback(ctx, DOC, {});
    assert.deepEqual(again.reviews, [], 'nothing new to deliver');
    assert.equal(again.edits, 'batch');
    assert.deepEqual(again.threads.map((t) => [t.id, t.why, t.edits]), [['t1', 'open', 'batch'], ['t2', 'open', 'batch']]);
    assert.deepEqual(pick(ops.formatPacket(again)), said);
    // one thread answered (planned), the other still open: the same lines
    await ops.reply(ctx, DOC, 't1', { body: 'I will add a 30 s grace window.', status: 'planned' });
    const later = ops.formatPacket(await ops.feedback(ctx, DOC, {}));
    assert.deepEqual(pick(later), said);
    assert.match(itemOf(later, 't2'), /^\[t2\] STILL OPEN · question · GENERAL/);
    // the wait refusal knows the round is batched (cli/commands/wait.js asks for planned replies)
    const refused = await deliver(ctx, { requireAnswers: true });
    assert.deepEqual([refused.status, refused.threads], ['unanswered', [{ id: 't2', type: 'question', status: 'open', replied: false, batch: true }]]);
  });

  test('batched per thread: a thread a batched review handed over stays batched when a later review asks for edits now', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1, { edits: 'batch' });
    await deliver(ctx);
    await ops.reply(ctx, DOC, 't2', { body: 'Lower latency.', status: 'answered' });
    // t1 still unanswered; the reviewer sends a new comment with edits now
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Name the owner.' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment' });
    const w = await deliver(ctx);
    const p = w.packets[0];
    assert.deepEqual(Object.fromEntries(p.threads.map((t) => [t.id, [t.why, t.edits ?? 'now']])), { t1: ['open', 'batch'], t3: ['new', 'now'] });
    assert.equal(p.edits, 'batch');
    assert.ok(
      w.text.split('\n').includes('EDITS: batch for t1 only (the other threads: edit now). Answer it now. For a change you agree to make there, do not edit the doc yet: reply with status "planned" and say exactly what you will change; questions get "answered". The edits come later in one APPLY packet.'),
      w.text,
    );
    assert.match(w.text, /^NEXT: edits, if any -> suiko revise kitchen-sink --replies - /m, 't3 is edited now');
    // the other way round: a new batched review on top of a thread asked for now
    const unanswered = await deliver(ctx, { requireAnswers: true });
    assert.deepEqual(unanswered.threads?.map((t) => [t.id, t.batch]), [['t1', true], ['t3', false]]);
  });

  test('a batched suggestion is planned now, not applied: its item says so; the APPLY round applies it verbatim', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Say where.', suggestion: { mode: 'text', new: 'Prototype the issuer behind the gateway.' } });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
    const w = await deliver(ctx);
    const item = itemOf(w.text, 't1');
    assert.match(item.split('\n')[0], /^\[t1\] suggestion · L\d+ · .* · suggestion: plan it now; it is applied in the APPLY round$/);
    assert.doesNotMatch(w.text, /apply verbatim|suiko apply kitchen-sink t1/);
    assert.equal(w.packets[0].threads[0].apply, 'suiko apply kitchen-sink t1', 'the JSON keeps the command for the APPLY round');
    await ops.reply(ctx, DOC, 't1', { body: 'I will apply it as suggested.', status: 'planned' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [], apply: ['t1'], edits: 'batch' });
    const a = await deliver(ctx);
    assert.match(itemOf(a.text, 't1').split('\n')[0], /^\[t1\] APPLY · suggestion · L\d+ · .* · apply verbatim: suiko apply kitchen-sink t1$/);
  });
});

describe('apply', () => {
  /**
   * t1 planned, t2 answered (delivered batch review); returns the ctx.
   */
  async function planned() {
    const o = await opened();
    await twoThreads(o.ctx, o.v1, { edits: 'batch' });
    await deliver(o.ctx);
    await ops.revise(o.ctx, DOC, { threads: { t1: { status: 'planned', reply: 'I will add a 30 s grace window after "rotated on every use".' }, t2: { status: 'answered', reply: 'Lower latency.' } } });
    return o;
  }

  test('refused for a thread that is not planned (Conflict), an unknown one (NotFound), with an approval or a resolve of it; nothing changes', async () => {
    const { ctx } = await planned();
    const before = JSON.stringify(await ctx.store.listThreads(DOC));
    const reviews = (await ctx.store.listReviews(DOC)).length;
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', apply: ['t1', 't2'] }), (err) => {
      assert.ok(err instanceof ConflictError);
      assert.match(/** @type {Error} */ (err).message, /^apply: t2 is answered, not planned; only a planned change/);
      return true;
    });
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', apply: ['t9'] }), NotFoundError);
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'approved', apply: ['t1'] }), UsageError);
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', apply: ['x1'] }), UsageError);
    const resolve = await ops.saveDraft(ctx, DOC, { kind: 'resolve', thread: 't1' });
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [resolve.id], apply: ['t1'] }), /t1 is also resolved by this review/);
    assert.equal(JSON.stringify(await ctx.store.listThreads(DOC)), before, 'no thread changed');
    assert.equal((await ctx.store.listReviews(DOC)).length, reviews, 'no review recorded');
  });

  test('an Apply without draftIds submits no draft: the pending ones stay drafts; the drafts it names go with it', async () => {
    const { ctx } = await planned();
    // the reviewer has two unsent drafts (batch sending mode) when they click Apply
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'A half-written thought.' });
    const reply = await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't2', body: 'Not ready to send.' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'comment', apply: ['t1'], edits: 'batch' });
    assert.deepEqual([rv.apply, rv.newThreads, rv.replies], [['t1'], [], []], 'nothing but the apply');
    assert.equal((await ctx.store.getDrafts(DOC)).items.length, 2, 'both drafts stay drafts');
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.status, 'open');
    assert.equal((await ctx.store.listThreads(DOC)).length, 2, 'no new thread');
    // the Apply sent again (t1 planned once more) with one draft named: only that one goes
    await ops.reply(ctx, DOC, 't1', { body: 'I will add a 30 s grace window.', status: 'planned' });
    const rv2 = await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [reply.id], apply: ['t1'] });
    assert.deepEqual([rv2.apply, rv2.newThreads, rv2.replies.map((r) => r.thread)], [['t1'], [], ['t2']]);
    assert.deepEqual((await ctx.store.getDrafts(DOC)).items.map((d) => d.body), ['A half-written thought.']);
    // any other review still submits every draft by default
    const rv3 = await ops.submitReview(ctx, DOC, { verdict: 'comment' });
    assert.deepEqual(rv3.newThreads, ['t3']);
    assert.equal((await ctx.store.getDrafts(DOC)).items.length, 0);
  });

  test('reopens the planned thread with an "Apply this change." request; the packet says APPLY with the planned reply; wait hands it back until the change is recorded', async () => {
    const { ctx } = await planned();
    // an Apply alone: no drafts (draftIds []), not even pending ones
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'A pending draft.' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [], apply: ['t1'], edits: 'batch' });
    assert.deepEqual([rv.apply, rv.newThreads, rv.replies, rv.reopened], [['t1'], [], [], []]);
    assert.equal((await ctx.store.getDrafts(DOC)).items.length, 1, 'the pending draft stays a draft');
    const t1 = /** @type {any} */ (await ctx.store.getThread(DOC, 't1'));
    assert.equal(t1.status, 'open');
    assert.deepEqual([t1.comments.at(-1).body, t1.comments.at(-1).apply, t1.comments.at(-1).by.kind, t1.comments.at(-1).review], ['Apply this change.', true, 'human', rv.id]);
    assert.match(ops.formatLog(await ops.log(ctx, DOC)), new RegExp(`^ +${rv.id} {2}Eric {2}\\d\\d:\\d\\d {2}COMMENT {2}1 thread \\(t1 to apply\\)$`, 'm'));

    const w = await deliver(ctx);
    assert.equal(w.status, 'delivered');
    const lines = w.text.split('\n');
    assert.equal(lines.find((l) => /needs action/.test(l)), '1 thread needs action: 1 to apply');
    assert.ok(lines.includes(APPLY_LINE), w.text);
    assert.doesNotMatch(w.text, /^EDITS:/m, 'nothing else to answer: no EDITS line');
    assert.match(w.text, /^NEXT: edits, if any -> suiko revise kitchen-sink --replies - /m, 'the APPLY round edits now');
    const item = itemOf(w.text, 't1');
    assert.match(item, /^\[t1\] APPLY · comment · L51 · /);
    assert.match(item, /^ {2}src> Refresh tokens are rotated on every use/m);
    // the reviewer's original request, then the plan (an agent after a compaction has only this packet)
    const conv = item.split('\n').filter((l) => /^ {2}(Eric|claude)\b/.test(l));
    assert.deepEqual(conv, ['  Eric: Add a grace window.', '  claude (v1, planned): I will add a 30 s grace window after "rotated on every use".']);
    assert.doesNotMatch(item, /earlier, suiko show/, 'nothing else hidden');
    assert.doesNotMatch(item, /Apply this change\./, 'the APPLY label says it');
    const pt = w.packets[0].threads[0];
    assert.equal(pt.why, 'apply');
    assert.equal(w.packets[0].counts.apply, 1);
    assert.deepEqual(pt.comments.map((/** @type {any} */ c) => [c.kind, c.status, c.apply ?? false, c.request ?? false]), [
      ['human', null, false, true],
      ['agent', 'planned', false, false],
      ['human', null, true, false],
    ]);
    assert.equal(pt.earlier, 0);

    // handed back: wait refuses until the change is recorded
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'unanswered');
    editFile(ws.file(FILE), 'rotated on every use', 'rotated on every use (with a 30 s grace window)');
    const rec = await ops.revise(ctx, DOC, { threads: { t1: { status: 'addressed', reply: 'Added the 30 s grace window.' } } });
    assert.equal(rec.version, 2);
    assert.deepEqual(rec.hunks.flatMap((/** @type {any} */ h) => h.threads), ['t1'], 'the change links to the applied thread');
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.status, 'addressed', 'then the usual Verify flow');
    assert.equal((await deliver(ctx, { requireAnswers: true })).status, 'timeout');
  });

  test('a batch review with new threads and an apply: the APPLY line and an EDITS line for the other threads', async () => {
    const { ctx, v1 } = await planned();
    const d = await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Name the owner.' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [d.id], apply: ['t1'], edits: 'batch' });
    const w = await deliver(ctx);
    const lines = w.text.split('\n');
    assert.ok(lines.includes(APPLY_LINE), w.text);
    assert.ok(
      lines.includes('EDITS: batch for every thread not marked APPLY. Answer them now. For a change you agree to make, do not edit the doc yet: reply with status "planned" and say exactly what you will change; questions get "answered". The edits come later in one APPLY packet.'),
      w.text,
    );
    assert.match(itemOf(w.text, 't3'), /^\[t3\] comment · /);
    assert.match(itemOf(w.text, 't1'), /^\[t1\] APPLY · /);
  });

  test('an APPLY item shows the original request above the plan, and points to the comments in between', async () => {
    const { ctx } = await planned();
    // the reviewer asks for more before applying; the agent revises its plan
    await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Make it 60 s.' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
    await deliver(ctx);
    await ops.reply(ctx, DOC, 't1', { body: 'I will add a 60 s grace window after "rotated on every use".', status: 'planned' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [], apply: ['t1'] });
    const w = await deliver(ctx);
    const item = itemOf(w.text, 't1').split('\n');
    const conv = item.filter((l) => /^ {2}(Eric|claude|\(\+)/.test(l));
    assert.deepEqual(conv, [
      '  Eric: Add a grace window.',
      '  (+2 earlier, suiko show kitchen-sink t1)',
      '  claude (v1, planned): I will add a 60 s grace window after "rotated on every use".',
    ], 'the request, the pointer to the comments between it and the plan, then the plan');
  });

  test('APPLY on a snapshot of a page built from sources: the APPLY line defers to NEXT, which snapshots the page again', async () => {
    const ctx = await engineCtx(ws.root);
    const src = '# Status page\n\nThe build is green on every branch.\n\nDeploys go out at noon.\n';
    const origin = { type: 'url', key: 'http://localhost:3000/', url: 'http://localhost:3000/', private: true };
    const { doc } = await ops.takeSnapshot(ctx, { source: src, format: 'markdown', origin, title: 'Status' });
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Deploys go out at noon.'), body: 'Say which timezone.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', edits: 'batch' });
    const q = { docIds: [doc.id], pollMs: 20, timeoutMs: 150, write: () => {} };
    const w1 = await ops.waitForFeedback(ctx, q);
    assert.match(w1.text, /^EDITS: batch\. Answer every thread now\./m);
    await ops.reply(ctx, doc.id, 't1', { body: 'I will add "(UTC)" after noon.', status: 'planned' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', draftIds: [], apply: ['t1'] });
    const w2 = await ops.waitForFeedback(ctx, q);
    assert.ok(w2.text.split('\n').includes(APPLY_LINE), w2.text);
    assert.match(w2.text, new RegExp(`^NEXT: edit the sources that produce the page -> suiko snapshot http://localhost:3000/ --allow-private --replies - \\(records v2\\) -> suiko wait ${doc.id} \\(background\\)$`, 'm'));
    assert.doesNotMatch(w2.text, /suiko revise/, 'a snapshot has no working file for revise to record');
    // and revise itself says so
    await assert.rejects(ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Added (UTC).' } } }), /there is no working file to record/);
  });
});

describe('agent attachments', () => {
  test('a reply attaches images and HTML previews: copied as aN.<ext> with their names and kinds', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    const files = writeFiles({
      'out/chart.png': PNG,
      'out/photo.jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]),
      'out/anim.gif': Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'),
      'out/pic.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
      'out/diagram.svg': SVG,
      'out/preview.htm': HTML,
    });
    // relative to the agent's cwd (ctx.cwd = the workspace root) or absolute
    const res = await ops.reply(ctx, DOC, 't1', {
      body: 'Two options, see the previews.',
      status: 'answered',
      attachments: ['out/chart.png', files['out/photo.jpeg'], 'out/anim.gif', 'out/pic.webp', './out/diagram.svg', 'out/preview.htm'],
    });
    const c = /** @type {any} */ (res.comment);
    assert.deepEqual(c.attachments, [
      { path: 'attachments/a1.png', name: 'chart.png', kind: 'image' },
      { path: 'attachments/a2.jpg', name: 'photo.jpeg', kind: 'image' },
      { path: 'attachments/a3.gif', name: 'anim.gif', kind: 'image' },
      { path: 'attachments/a4.webp', name: 'pic.webp', kind: 'image' },
      { path: 'attachments/a5.svg', name: 'diagram.svg', kind: 'image' },
      { path: 'attachments/a6.html', name: 'preview.htm', kind: 'html' },
    ]);
    assert.ok(fs.readFileSync(ctx.store.attachmentPath(DOC, 'attachments/a1.png')).equals(PNG));
    assert.equal(fs.readFileSync(ctx.store.attachmentPath(DOC, 'attachments/a6.html'), 'utf8'), HTML);
    assert.equal(ops.formatReply(res), 'replied on t1 (answered) · attached 6 files · no version recorded\n');
    // stored with the thread, counters saved (the next attachment is a7), and in DocState for the UI
    assert.equal((await ctx.store.getDoc(DOC))?.counters.attachment, 6);
    const st = await ops.docState(ctx, DOC);
    const t1 = /** @type {any} */ (st.threads.find((/** @type {any} */ t) => t.id === 't1'));
    assert.deepEqual(t1.comments.at(-1).attachments, c.attachments);
    // `show` names them with their absolute paths
    const shown = ops.formatThread(await ops.show(ctx, DOC, { thread: 't1' }));
    assert.match(shown, new RegExp(`^ {4}attached: ${escapeRe(ctx.store.attachmentPath(DOC, 'attachments/a6.html'))} \\(preview\\.htm\\)$`, 'm'));
  });

  test('refused attachments write nothing: type, content, size, count, empty, directory, symlink, hidden path, missing file', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    writeFiles({
      'out/ok.png': PNG,
      'out/notes.txt': 'text',
      'out/fake.png': '<html>not a png</html>',
      'out/fake.svg': '<html>no svg element</html>',
      'out/binary.html': Buffer.from([0x3c, 0x68, 0x00, 0x01]),
      'out/empty.png': '',
      'out/big.png': Buffer.concat([PNG, Buffer.alloc(LIMITS.maxAttachmentBytes)]),
      '.secret/chart.png': PNG,
      'out/dir.png/inner.txt': 'x',
    });
    fs.symlinkSync(path.join(ws.root, 'out', 'ok.png'), path.join(ws.root, 'out', 'link.png'));
    const before = JSON.stringify(await ctx.store.getThread(DOC, 't1'));
    const doc0 = JSON.stringify(await ctx.store.getDoc(DOC));
    /** @type {Array<[string[], RegExp, Function]>} */
    const cases = [
      [['out/notes.txt'], /out\/notes\.txt is not an attachable file \(allowed: \.png \.jpg \.jpeg \.gif \.webp \.svg \.html \.htm\)/, UsageError],
      [['out/fake.png'], /out\/fake\.png is not a PNG image/, UsageError],
      [['out/fake.svg'], /out\/fake\.svg is not an SVG image/, UsageError],
      [['out/binary.html'], /out\/binary\.html is not a text \(HTML\) file/, UsageError],
      [['out/empty.png'], /out\/empty\.png is empty/, UsageError],
      [['out/big.png'], /out\/big\.png is 5 MB; attachments are limited to 5 MB/, UsageError],
      [['.secret/chart.png'], /refusing to attach \.secret\/chart\.png: it is a hidden \(dot\) file or directory/, UsageError],
      [['out/dir.png'], /out\/dir\.png is a directory/, UsageError],
      [['out/link.png'], /out\/link\.png is a symlink; attach the file itself/, UsageError],
      [['out/missing.png'], /no such file: out\/missing\.png/, NotFoundError],
      [Array.from({ length: LIMITS.maxReplyAttachments + 1 }, (_, i) => `out/f${i}.png`), /at most 6 files per reply \(got 7\)/, UsageError],
      // one bad file fails the whole reply, the good one is not stored either
      [['out/ok.png', 'out/notes.txt'], /out\/notes\.txt is not an attachable file/, UsageError],
    ];
    for (const [attachments, message, type] of cases) {
      await assert.rejects(ops.reply(ctx, DOC, 't1', { body: 'See.', status: 'answered', attachments }), (err) => {
        assert.ok(err instanceof type, `${attachments}: ${err}`);
        assert.match(/** @type {Error} */ (err).message, message);
        return true;
      });
    }
    assert.deepEqual(attachmentFiles(ctx), [], 'nothing copied');
    assert.equal(JSON.stringify(await ctx.store.getThread(DOC, 't1')), before, 'no reply posted');
    assert.equal(JSON.stringify(await ctx.store.getDoc(DOC)), doc0, 'no id allocated');
  });

  test('revise threads.tN.attachments: replies-only rounds and recorded versions; a dry run or a refusal stores nothing', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    writeFiles({ 'out/a.svg': SVG, 'out/b.html': HTML });
    // dry run: checked, nothing stored
    const dry = await ops.revise(ctx, DOC, { dryRun: true, threads: { t1: { status: 'answered', reply: 'See the chart.', attachments: ['out/a.svg'] } } });
    assert.equal(dry.repliesOnly, true);
    assert.deepEqual(dry.replies, [{ thread: 't1', status: 'answered', files: 1 }]);
    assert.deepEqual(attachmentFiles(ctx), []);
    // a bad file fails the revise before anything is written
    await assert.rejects(ops.revise(ctx, DOC, { threads: { t1: { status: 'answered', reply: 'x', attachments: ['out/none.png'] } } }), NotFoundError);
    // replies only
    const r1 = await ops.revise(ctx, DOC, { threads: { t1: { status: 'planned', reply: 'This chart, then.', attachments: ['out/a.svg'] } } });
    assert.match(ops.formatReviseReport(r1), /^ {2}t1 planned \(\+1 file\)$/m);
    assert.deepEqual((/** @type {any} */ (await ctx.store.getThread(DOC, 't1'))).comments.at(-1).attachments, [{ path: 'attachments/a1.svg', name: 'a.svg', kind: 'image' }]);
    // with a doc change: stored with the version (and the reply's comment)
    editFile(ws.file(FILE), 'Prototype the issuer.', 'Prototype the issuer first.');
    const r2 = await ops.revise(ctx, DOC, { threads: { t2: { status: 'answered', reply: 'Latency; see the preview.', attachments: ['out/b.html'] } } });
    assert.equal(r2.version, 2);
    const c = /** @type {any} */ (await ctx.store.getThread(DOC, 't2')).comments.at(-1);
    assert.deepEqual([c.attachments, c.recordedWith], [[{ path: 'attachments/a2.html', name: 'b.html', kind: 'html' }], 2]);
    assert.deepEqual(attachmentFiles(ctx), ['a1.svg', 'a2.html']);
    assert.equal((await ctx.store.getDoc(DOC))?.counters.attachment, 2, 'committed with doc.json');
  });

  test('a replies-only revise that fails on a later reply (an invalid "at") writes nothing: no reply, no file, no id', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    await deliver(ctx);
    writeFiles({ 'chart.png': PNG });
    const doc0 = JSON.stringify(await ctx.store.getDoc(DOC));
    const t1Before = JSON.stringify(await ctx.store.getThread(DOC, 't1'));
    await assert.rejects(
      ops.revise(ctx, DOC, {
        threads: {
          t1: { status: 'answered', reply: 'See the chart.', attachments: ['chart.png'] },
          t2: { status: 'answered', reply: 'Lower latency.', at: 'garbage' },
        },
      }),
      /reply to t2: invalid "at" "garbage"/,
    );
    assert.equal(JSON.stringify(await ctx.store.getThread(DOC, 't1')), t1Before, 'no reply posted on t1');
    assert.equal(JSON.stringify(await ctx.store.getDoc(DOC)), doc0, 'no id allocated');
    assert.deepEqual(attachmentFiles(ctx), [], 'no file stored');
  });

  test('a replies-only revise that fails part way (a thread write fails) never hands an attachment id out again', async () => {
    const { ctx, v1 } = await opened();
    await twoThreads(ctx, v1);
    await deliver(ctx);
    const PNG2 = Buffer.concat([PNG, Buffer.from('second file')]);
    writeFiles({ 'chart.png': PNG, 'other.png': PNG2 });
    // the disk fails on the second thread file (t1 is written, t2 is not)
    const save = ctx.store.saveThread.bind(ctx.store);
    ctx.store.saveThread = async (/** @type {string} */ docId, /** @type {any} */ t) => {
      if (t.id === 't2') throw new Error('EIO: injected write failure');
      return save(docId, t);
    };
    await assert.rejects(
      ops.revise(ctx, DOC, {
        threads: {
          t1: { status: 'answered', reply: 'See the chart.', attachments: ['chart.png'] },
          t2: { status: 'answered', reply: 'Lower latency.' },
        },
      }),
      /injected write failure/,
    );
    ctx.store.saveThread = save;
    const t1 = /** @type {any} */ (await ctx.store.getThread(DOC, 't1'));
    assert.deepEqual(t1.comments.at(-1).attachments, [{ path: 'attachments/a1.png', name: 'chart.png', kind: 'image' }], 't1 was posted');
    assert.deepEqual((await ctx.store.getDoc(DOC))?.counters.attachment, 1, 'the counters were saved before the thread');
    // the agent retries t2 with another file: a new id, and t1's chart is still its own
    await ops.reply(ctx, DOC, 't2', { body: 'Here is the latency plot.', status: 'answered', attachments: ['other.png'] });
    const t2 = /** @type {any} */ (await ctx.store.getThread(DOC, 't2'));
    assert.deepEqual(t2.comments.at(-1).attachments, [{ path: 'attachments/a2.png', name: 'other.png', kind: 'image' }]);
    assert.ok(fs.readFileSync(ctx.store.attachmentPath(DOC, 'attachments/a1.png')).equals(PNG), "t1's chart was not overwritten");
    const ids = [...t1.comments, ...t2.comments].map((/** @type {any} */ c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `comment ids are unique: ${ids.join(' ')}`);
  });

  test('a project inside a dot-directory (a git worktree under .claude/worktrees/) attaches its own files; its hidden ones stay refused', async () => {
    const wt = path.join(path.dirname(ws.root), 'repo', '.claude', 'worktrees', 'w1');
    fs.mkdirSync(path.join(wt, 'out'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.private'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'out', 'chart.png'), PNG);
    fs.writeFileSync(path.join(wt, '.private', 'chart.png'), PNG);
    const agent = /** @type {any} */ ({ cwd: wt, root: wt });
    assert.deepEqual((await loadAttachments(agent, ['out/chart.png', path.join(wt, 'out', 'chart.png')])).map((a) => [a.name, a.kind]), [['chart.png', 'image'], ['chart.png', 'image']]);
    await assert.rejects(loadAttachments(agent, ['.private/chart.png']), /refusing to attach \.private\/chart\.png: it is a hidden \(dot\) file or directory/);
    // seen from another project, the path goes through the dot-directory: refused
    await assert.rejects(loadAttachments(/** @type {any} */ ({ cwd: ws.root, root: ws.root }), [path.join(wt, 'out', 'chart.png')]), /hidden \(dot\) file or directory/);
  });

  test('parseReviseInput checks the attachment lists', () => {
    const base = { status: 'answered', reply: 'x' };
    assert.deepEqual(ops.parseReviseInput({ threads: { t1: { ...base, attachments: ['a.png'] } } }).threads.t1, { ...base, attachments: ['a.png'] });
    assert.deepEqual(ops.parseReviseInput({ threads: { t1: { ...base, attachments: [] } } }).threads.t1, base);
    assert.throws(() => ops.parseReviseInput({ threads: { t1: { ...base, attachments: 'a.png' } } }), /threads\.t1\.attachments" must be a list of file paths/);
    assert.throws(() => ops.parseReviseInput({ threads: { t1: { ...base, attachments: [''] } } }), /must be a list of file paths/);
    assert.throws(() => ops.parseReviseInput({ threads: { t1: { ...base, attachments: Array(7).fill('a.png') } } }), /at most 6 files per reply/);
    assert.equal(ops.parseReviseInput({ threads: { t1: { status: 'planned', reply: 'I will.' } } }).threads.t1.status, 'planned');
  });
});

describe('replies-only revise', () => {
  test('an "addressed" reply with nothing recorded warns: a file the document loads at runtime is not versioned', async () => {
    const ctx = await engineCtx(ws.root);
    writeFiles({
      'report/live.html': '<!doctype html><html><head><title>Live</title></head><body><h1>Live figures</h1><p>Monthly spreads, from the feed.</p><table id="t"></table><script>fetch("live-data.json").then((r) => r.json()).then((rows) => { document.getElementById("t").innerHTML = rows.map((x) => `<tr><td>${x.m}</td><td>${x.v}</td></tr>`).join(""); });</script></body></html>\n',
      'report/live-data.json': '[{"m":"2024-03","v":31.2}]\n',
    });
    const { doc } = await ops.openDoc(ctx, { path: 'report/live.html' });
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Monthly spreads'), body: 'Add April 2024 to the table.' });
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'Which feed?' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment' });
    // the agent changes only the data file the page fetches: the document itself is unchanged
    writeFiles({ 'report/live-data.json': '[{"m":"2024-03","v":31.2},{"m":"2024-04","v":30.8}]\n' });
    const input = { threads: { t1: { status: 'addressed', reply: 'Added April 2024.' }, t2: { status: 'answered', reply: 'The trading desk feed.' } } };
    const dry = await ops.revise(ctx, doc.id, { ...input, dryRun: true });
    const warning =
      't1 is marked addressed but nothing was recorded: the document did not change. A file the document loads at runtime (fetch, XHR) is not versioned; change the document itself, or reply "answered".';
    assert.deepEqual(dry.guards.warnings, [{ code: 'not-recorded', thread: 't1', message: warning }], 'the dry run says it too');
    const r = await ops.revise(ctx, doc.id, input);
    assert.equal(r.repliesOnly, true);
    assert.equal((await ctx.store.getDoc(doc.id))?.head, 1, 'no version');
    assert.equal(
      ops.formatReviseReport(r),
      `suiko: working copy matches v1; posted 2 replies (no new version)\n  t1 addressed\n  t2 answered\n  WARN ${warning}\nnext: suiko wait ${doc.id} (background)\n`,
    );
    // planned, answered, declined and needs_input replies are what a replies-only round is for: no warning
    await ops.saveDraft(ctx, doc.id, { kind: 'reply', thread: 't1', body: 'It is not in the table.', reopen: true });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment' });
    const planned = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'planned', reply: 'I will add the row to the document itself.' } } });
    assert.deepEqual(planned.guards.warnings, []);
    assert.doesNotMatch(ops.formatReviseReport(planned), /WARN/);
  });
});

describe('use in doc', () => {
  /** t1 with an agent reply carrying a.svg (a1) and b.html (a2). */
  async function withPreview() {
    const o = await opened();
    await twoThreads(o.ctx, o.v1);
    writeFiles({ 'out/chart.svg': SVG, 'out/chart.html': HTML });
    await ops.reply(o.ctx, DOC, 't1', { body: 'Two versions of the chart.', status: 'answered', attachments: ['out/chart.svg', 'out/chart.html'] });
    return o;
  }

  test('a reply draft keeps use (attachments of its thread only); the comment stores it; the packet prints use: lines', async () => {
    const { ctx } = await withPreview();
    await assert.rejects(ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't2', body: 'Put this in the doc.', use: ['attachments/a2.html'] }), /use: attachments\/a2\.html is not an attachment of t2/);
    await assert.rejects(ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'x', use: 'a2.html' }), UsageError);
    const d = await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Put this in the doc.', use: ['a2.html', 'attachments/a2.html'] });
    assert.deepEqual(/** @type {any} */ (d).use, ['attachments/a2.html'], 'normalised, no duplicates');
    const patched = await ops.updateDraft(ctx, DOC, d.id, { body: 'Put this one in the doc.' });
    assert.deepEqual(/** @type {any} */ (patched).use, ['attachments/a2.html'], 'kept across a patch');
    await ops.submitReview(ctx, DOC, { verdict: 'comment', draftIds: [d.id] });
    const c = /** @type {any} */ (await ctx.store.getThread(DOC, 't1')).comments.at(-1);
    assert.deepEqual([c.by.kind, c.body, c.use], ['human', 'Put this one in the doc.', ['attachments/a2.html']]);

    const w = await deliver(ctx, { allowDirty: true });
    const item = itemOf(w.text, 't1');
    const abs = ctx.store.attachmentPath(DOC, 'attachments/a2.html');
    assert.match(item, /^\[t1\] REPLY · /);
    assert.ok(
      item.split('\n').includes(`  use: ${abs} (chart.html) — put this into the doc at this thread's place (copy it next to the doc or inline it)`),
      item,
    );
    assert.deepEqual(w.packets[0].threads.find((/** @type {any} */ t) => t.id === 't1').comments.at(-1).use, [{ path: abs, name: 'chart.html' }]);
    assert.match(ops.formatThread(await ops.show(ctx, DOC, { thread: 't1' })), new RegExp(`^ {4}use: ${escapeRe(abs)} \\(chart\\.html\\)$`, 'm'));
  });

  test('a "Use in doc" reply that comes with a final approval: the use: line asks about a next version, not for an edit', async () => {
    const { ctx } = await withPreview();
    await deliver(ctx, { allowDirty: true });
    // the reviewer clicks "Use in doc" (a draft in batch sending mode), then approves v1 as final with everything
    await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Put this in the doc.', use: ['attachments/a2.html'] });
    await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, expectHead: 1 });
    const w = await deliver(ctx, { allowDirty: true });
    const abs = ctx.store.attachmentPath(DOC, 'attachments/a2.html');
    const lines = w.text.split('\n');
    assert.ok(lines.includes(`  use: ${abs} (chart.html) — the doc is final (v1); say in your reply whether this should go into a next version`), w.text);
    assert.ok(!w.text.includes('put this into the doc'), 'no request to edit the final doc');
    assert.match(w.text, /^APPROVED with FINAL = v1: reply to each thread; do not edit the doc/m);
    // a code review says the same of its files
    assert.equal(useLine({ path: '/abs/a1.png', name: 'chart.png' }, { code: true, final: 3 }), '  use: /abs/a1.png (chart.png) — the review is final (v3); say in your reply whether this should go into a next version');
  });

  test('a use reply on a resolved thread reopens it so the request reaches the agent', async () => {
    const { ctx } = await withPreview();
    await ops.resolveThread(ctx, DOC, 't1', {});
    await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'Put this in the doc.', use: ['attachments/a1.svg'] });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'comment' });
    assert.deepEqual(rv.reopened, ['t1']);
    const t1 = /** @type {any} */ (await ctx.store.getThread(DOC, 't1'));
    assert.equal(t1.status, 'open');
    assert.equal(isActionable(t1), true);
  });
});

describe('versions: lines and textChars', () => {
  test('new versions record their visible text characters; DocState carries lines and textChars; old versions have none', async () => {
    const report = ['<!doctype html><html><head><title>R</title><style>body { color: red; }</style></head><body>',
      '<h1>Report</h1>', '<p>Short   answer:   yes.</p>', `<script>const DATA = ${JSON.stringify('x'.repeat(5000))};</script>`, '</body></html>', ''].join('\n');
    fs.writeFileSync(path.join(ws.docsDir, 'report.html'), report);
    const ctx = await engineCtx(ws.root);
    const { doc, version } = await ops.openDoc(ctx, { path: 'docs/report.html' });
    // "Report" + "Short answer: yes." (whitespace collapsed); the title, style and the 5000-char data blob do not count
    assert.equal(version.textChars, 'Report Short answer: yes.'.length);
    assert.equal(version.lines, 5);
    fs.writeFileSync(path.join(ws.docsDir, 'report.html'), report.replace('yes.', 'yes, with caveats.'));
    const r = await ops.revise(ctx, doc.id, {});
    assert.equal(r.version, 2);
    const m2 = (await ctx.store.readVersion(doc.id, 2)).manifest;
    assert.equal(m2.textChars, 'Report Short answer: yes, with caveats.'.length);

    // a version recorded before textChars existed: no field (the UI falls back to lines)
    const f1 = path.join(ctx.store.versionsDir(doc.id), '0001.json');
    const m1 = JSON.parse(fs.readFileSync(f1, 'utf8'));
    delete m1.textChars;
    fs.writeFileSync(f1, JSON.stringify(m1));
    const st = await ops.docState(ctx, doc.id);
    assert.deepEqual(st.versions.map((/** @type {any} */ v) => [v.v, v.lines, v.textChars]), [[1, 5, undefined], [2, 5, m2.textChars]]);
    assert.equal('textChars' in st.versions[0], false);
  });
});

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
