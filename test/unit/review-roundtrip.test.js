// @ts-check
// Full in-process review loop on test/fixtures/docs/kitchen-sink.md (design 3, 16 M1):
// open -> drafts (text, element + region with crop, table cell, suggestion) + lock -> submit -> wait delivers the
// packet (golden test/fixtures/packets/round1.txt) -> apply + tagged edit -> revise with replies -> anchor states
// -> round 2 (accept with decisions, reopen, answer) -> revise -> approve + mark final -> final --decisions.
// Set UPDATE_GOLDEN=1 to rewrite the golden packet.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/index.js';
import { setClock } from '../../src/core/util/time.js';
import {
  PACKET_FIXTURES, TINY_PNG, cellCapture, editFile, elementCapture, engineCtx, findSrid, makeWorkspace, normalizePacket,
  textCapture,
} from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;
const DOC = 'kitchen-sink';

before(async () => {
  let t = Date.parse('2026-10-10T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
after(async () => {
  restoreClock();
  await ws.cleanup();
});

/** @param {Awaited<ReturnType<typeof engineCtx>>} ctx */
async function anchorsOf(ctx) {
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (const t of await ctx.store.listThreads(DOC)) {
    out[t.id] = Object.fromEntries(Object.entries(t.anchors).map(([v, a]) => [v, a.state]));
  }
  return out;
}

test('review round trip: open -> review -> wait -> apply/edit -> revise -> round 2 -> approve -> final', async () => {
  const ctx = await engineCtx(ws.root);

  // ---- open
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  assert.equal(opened.created, true);
  assert.equal(opened.doc.id, DOC);
  assert.equal(opened.version.v, 1);
  assert.deepEqual(Object.keys(opened.version.assets), ['docs/img/arch.png']);
  const again = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  assert.equal(again.created, false);
  assert.equal(again.workingDirty, false);

  // ---- reviewer drafts and a lock
  const v1 = await ctx.render(opened.doc, 1);
  const d1 = await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'comment', severity: 'blocking', capture: textCapture(v1, 'rotated on every use'),
    body: 'Rotation on every use breaks multi-tab sessions. Use a 30 s reuse-detection grace window.',
  });
  assert.equal(d1.id, 'd1');
  assert.equal(d1.kind === 'thread' && d1.anchor.src.text, 'rotated on every use');
  const crop = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
  assert.equal(crop.path, 'attachments/a1.png');
  const img = findSrid(v1, (n) => n.t === 'img');
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'question', capture: elementCapture(v1, img, { region: { x: 0.4, y: 0.1, w: 0.22, h: 0.2 } }),
    body: 'Does the gateway sit in front of the auth service or beside it? The arrow is ambiguous.', attachments: [crop.path],
  });
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Name where it runs.',
    suggestion: { mode: 'text', new: 'Prototype the issuer behind the gateway.' },
  });
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'comment', capture: cellCapture(v1, 'refresh_token', 'TTL', { row: 2, col: 1, text: '30 d' }),
    body: '30 days is too long for admin accounts; split by role.',
  });
  const lock = await ops.addLock(ctx, DOC, { capture: textCapture(v1, 'the gateway never stores tokens') });
  assert.equal(lock.id, 'L1');
  assert.equal(lock.text, 'the gateway never stores tokens');

  const preview = await ops.resolveCapture(ctx, DOC, { capture: textCapture(v1, 'rotated on every use') });
  assert.match(preview.preview.text, /^Agent will see: L51 §.*3\.2 Token refresh "rotated on every use"$/);

  // ---- submit + wait (delivery after write)
  const rv1 = await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: 'Good start. The note about the gateway is agreed - keep it.' });
  assert.deepEqual(rv1.newThreads, ['t1', 't2', 't3', 't4']);
  assert.deepEqual(rv1.locksAdded, ['L1']);
  assert.equal((await ctx.store.getDrafts(DOC)).items.length, 0);

  let written = '';
  let deliveredAtWrite = null;
  const w1 = await ops.waitForFeedback(ctx, {
    docIds: [DOC],
    pollMs: 20,
    write: async (text) => {
      written = text;
      deliveredAtWrite = (await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude ?? null;
    },
  });
  assert.equal(w1.status, 'delivered');
  assert.equal(deliveredAtWrite, null, 'marked delivered only after the write resolved');
  assert.ok((await ctx.store.getReview(DOC, 'rv1'))?.deliveredTo?.claude);
  assert.equal(w1.text, written);
  const golden = path.join(PACKET_FIXTURES, 'round1.txt');
  const actual = normalizePacket(written, ws.root);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(golden)) {
    fs.mkdirSync(PACKET_FIXTURES, { recursive: true });
    fs.writeFileSync(golden, actual);
  }
  assert.equal(actual, fs.readFileSync(golden, 'utf8'));
  const p1 = w1.packets[0];
  assert.deepEqual(p1.threads.map((t) => [t.id, t.why, t.lines]), [
    ['t3', 'new', [23, 23]],
    ['t2', 'new', [29, 29]],
    ['t4', 'new', [46, 46]],
    ['t1', 'new', [51, 51]],
  ]);
  assert.equal(p1.counts.actionable, 4);
  assert.ok(p1.threads[1].attachments[0].endsWith(path.join('attachments', 'a1.png')));

  // ---- agent: apply the suggestion, edit t1, answer t2 with a caption line, ask about t4
  const applied = await ops.applySuggestions(ctx, DOC, ['t3']);
  assert.deepEqual(applied.applied.map((a) => [a.id, a.lines, a.how]), [['t3', [23, 23], 'exact']]);
  assert.equal((await ctx.store.getReview(DOC, 'rv1'))?.ackedBy?.claude !== undefined, true, 'next agent op acks');
  const edited = await ops.taggedEdit(ctx, DOC, { threads: ['t1'], oldString: 'rotated on every use', newString: 'rotated with a 30 s reuse-detection grace window' });
  assert.deepEqual(edited.lines, [51, 51]);
  editFile(ws.file('docs/kitchen-sink.md'), '![System overview](./img/arch.png "Architecture overview")\n', '![System overview](./img/arch.png "Architecture overview")\n\n*Figure 1: the gateway sits in front of the auth service.*\n');

  const r1 = await ops.revise(ctx, DOC, {
    summary: 'rv1: grace window, issuer, caption',
    threads: {
      t1: { status: 'addressed', reply: 'Replaced rotate-every-use with a 30 s reuse-detection grace window.' },
      t2: { status: 'addressed', reply: 'Gateway sits in front of auth. Added a caption.', at: 'L30-31' },
      t3: { status: 'addressed', reply: 'Applied your suggestion.' },
      t4: { status: 'needs_input', reply: 'Split TTL by role: user 30d, admin 12h or 24h?' },
    },
  });
  assert.equal(r1.refused, false);
  assert.equal(r1.version, 2);
  assert.equal(r1.respondsTo, 'rv1');
  assert.deepEqual(r1.hunks.map((h) => [h.id, h.threads, h.linkedBy, h.via]), [
    ['h1', ['t3'], 'tagged', 'apply'],
    ['h2', ['t2'], 'hint', null],
    ['h3', ['t1'], 'tagged', 'edit'],
  ]);
  assert.deepEqual(r1.guards.errors, []);
  assert.deepEqual(r1.guards.intactLocks, ['L1']);
  assert.match(ops.formatReviseReport(r1), /^suiko: recorded v2 for kitchen-sink \(\+4 -2 lines, 3 hunks\) · responds to rv1\n/);
  assert.match(ops.formatReviseReport(r1), /t4 needs_input \(reply only\)/);

  const states = await anchorsOf(ctx);
  assert.deepEqual(states.t1, { 1: 'exact', 2: 'edited' });
  assert.deepEqual(states.t2, { 1: 'exact', 2: 'exact' });
  assert.deepEqual(states.t3, { 1: 'exact', 2: 'edited' });
  assert.deepEqual(states.t4, { 1: 'exact', 2: 'moved' });
  const l1 = await ctx.store.getLock(DOC, 'L1');
  assert.equal(l1?.anchors['2'].state, 'moved');
  const t3 = await ctx.store.getThread(DOC, 't3');
  assert.equal(t3?.suggestion?.status, 'applied');
  assert.equal(t3?.suggestion?.appliedIn, 2);
  const t4 = await ctx.store.getThread(DOC, 't4');
  assert.equal(t4?.status, 'needs_input');
  assert.deepEqual(t4?.anchors['2'].src.startLine, 48);

  // the manifest records attribution and guards
  const m2 = (await ctx.store.readVersion(DOC, 2)).manifest;
  assert.equal(m2.capturedBy, 'revise');
  assert.equal(m2.respondsTo, 'rv1');
  assert.deepEqual(m2.hunks?.map((h) => h.threads), [['t3'], ['t2'], ['t1']]);
  assert.equal(await ctx.store.readPendingEdits(DOC).then((e) => e.length), 0);

  // changes v1..v2 carry the thread links
  const ch = await ops.changes(ctx, DOC, { from: 1, to: 2 });
  assert.deepEqual(ch.threadLinks, { t3: ['h1'], t2: ['h2'], t1: ['h3'] });
  const mini = await ops.threadMiniDiff(ctx, DOC, 't1');
  assert.equal(mini.kind, 'text');
  assert.match(/** @type {any} */ (mini).after, /30 s reuse-detection grace window/);

  // ---- round 2: accept t1 / t3 with decisions, reopen t2, answer t4
  await ops.resolveThread(ctx, DOC, 't1', { decision: '30 s reuse-detection grace window' });
  await ops.resolveThread(ctx, DOC, 't3', { decision: 'Prototype the issuer behind the gateway' });
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't2', body: 'Caption still ambiguous: say which arrows are sync vs async.', reopen: true });
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't4', body: 'admin 12h.' });
  const rv2 = await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: 'Close. Caption still unclear.' });
  assert.deepEqual(rv2.reopened, ['t2']);
  assert.deepEqual(rv2.resolved, ['t1', 't3']);

  const w2 = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
  assert.equal(w2.status, 'delivered');
  const p2 = w2.packets[0];
  assert.deepEqual(p2.threads.map((t) => [t.id, t.why]), [['t2', 'reopened'], ['t4', 'answer']]);
  assert.match(w2.text, /^SPECREVIEW FEEDBACK · kitchen-sink · review rv2 on v2 · CHANGES REQUESTED$/m);
  assert.match(w2.text, /^2 threads need action: 1 reopened · 1 answer to your question {3}\(2 resolved this round\)$/m);
  assert.match(w2.text, /^\[t2\] REOPENED · question · L29 · §2 Architecture · <img alt="System overview"> region x40-62% y10-30%$/m);
  assert.match(w2.text, /^ {2}claude \(v2\): Gateway sits in front of auth\. Added a caption\.$/m);
  assert.match(w2.text, /^\[t4\] ANSWER · comment · L48 /m);
  assert.match(w2.text, /^ {2}claude \(v2, needs_input\): Split TTL by role/m);
  assert.match(w2.text, /^DECISIONS to keep true: D1 \(t1\) 30 s reuse-detection grace window · D2 \(t3\) Prototype the issuer behind the gateway$/m);
  assert.doesNotMatch(w2.text, /^PROTOCOL:/m, 'the protocol reminder is only in the first packet');

  // ---- agent round 2
  editFile(ws.file('docs/kitchen-sink.md'), '*Figure 1: the gateway sits in front of the auth service.*', '*Figure 1: the gateway sits in front of the auth service (sync calls); token storage is async.*');
  await ops.taggedEdit(ctx, DOC, { threads: ['t4'], oldString: '| refresh_token | 30 d | `token_store` |', newString: '| refresh_token (user) | 30 d | `token_store` |\n| refresh_token (admin) | 12 h | `token_store` |' });
  const r2 = await ops.revise(ctx, DOC, {
    summary: 'rv2: caption, admin TTL',
    threads: {
      t2: { status: 'addressed', reply: 'Caption now says which calls are sync.', at: 'L31' },
      t4: { status: 'addressed', reply: 'Split the row: user 30 d, admin 12 h.' },
    },
  });
  assert.equal(r2.refused, false);
  assert.equal(r2.version, 3);
  assert.deepEqual(r2.hunks.map((h) => h.threads), [['t2'], ['t4']]);

  // ---- approve + mark final
  const rv3 = await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, resolveAddressed: true });
  assert.equal(rv3.markFinal, true);
  assert.deepEqual(rv3.resolved, ['t2', 't4']);
  const doc = await ctx.store.getDoc(DOC);
  assert.equal(doc?.state, 'approved');
  assert.deepEqual(doc?.final && { v: doc.final.version, review: doc.final.review }, { v: 3, review: 'rv3' });
  const w3 = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
  assert.equal(w3.status, 'delivered');
  assert.equal(
    w3.text,
    'SPECREVIEW FEEDBACK · kitchen-sink · review rv3 on v3 · APPROVED · FINAL = v3\n' +
      '0 threads need action · 4 resolved · 0 open\n\n' +
      'NEXT: suiko final kitchen-sink --decisions   (then stop waiting)\n',
  );

  // ---- final
  const fin = await ops.finalize(ctx, DOC, { decisions: true });
  assert.equal(fin.final.version, 3);
  assert.equal(fin.versions, 3);
  assert.equal(fin.reviews, 3);
  assert.equal(fin.resolved, 4);
  assert.equal(fin.decisions, 2);
  assert.equal(fin.decisionsPath, 'docs/kitchen-sink.decisions.md');
  const md = ws.read('docs/kitchen-sink.decisions.md');
  assert.match(md, /^# Decisions: Token Service Implementation Spec$/m);
  assert.match(md, /^### D1: 30 s reuse-detection grace window$/m);
  assert.match(md, /^### D2: Prototype the issuer behind the gateway$/m);
  assert.match(md, /Resolution \(claude, v2, addressed\): Replaced rotate-every-use/);
  assert.match(md, /Changed in: v2 h3/);
  assert.match(ops.formatFinal(fin), /^final: kitchen-sink = v3 \(approved in rv3 by Eric; 3 versions, 3 reviews, 4 threads resolved, 2 decisions\)\nworking copy matches v3: ok\nwrote docs\/kitchen-sink\.decisions\.md\n$/);

  // the log shows the whole history
  const logText = ops.formatLog(await ops.log(ctx, DOC));
  assert.match(logText, /^v3 {2}agent claude/m);
  assert.match(logText, /rv3 {2}Eric .* APPROVED/);
  assert.match(logText, /^final: v3 \(rv3, Eric\)$/m);
});
