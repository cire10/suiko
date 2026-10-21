// @ts-check
// Agent working-copy ops and replies (design 9.2, 9.4, 9.5; BUILD_AMENDMENTS 5): `apply` (CAS conflict + retry,
// give-up after 3 attempts, conflicts when the text is gone, dry run), `edit` (unique old_string, stale
// expectSha256, all-or-nothing batches for `edit --stdin`), `revert --hunk` / `--lock`, `revise` with no changes
// (replies only / nothing to record), `reply`, `ask` and `reanchor` (applied to head or staged until revise).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SSE } from '../../src/shared/protocol.js';
import { ConflictError, RefusedError } from '../../src/core/store/errors.js';
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

/**
 * open + rv1 with t1 (comment on "rotated on every use") and t2 (suggestion on "Prototype the issuer."), delivered.
 */
async function reviewed() {
  const ctx = await engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: FILE });
  const v1 = await ctx.render(doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Add a grace window.' });
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Say where.',
    suggestion: { mode: 'text', new: 'Prototype the issuer behind the gateway.' },
  });
  await ops.addLock(ctx, DOC, { capture: textCapture(v1, 'the gateway never stores tokens') });
  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  await ops.feedback(ctx, DOC, {});
  return { ctx, doc, v1 };
}

/**
 * Makes the next `n` working-copy writes race with a concurrent edit (the file changes just before the CAS write).
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 * @param {number} n
 */
function raceWrites(ctx, n) {
  const store = /** @type {any} */ (ctx.store);
  const orig = store.writeWorking.bind(store);
  const state = { calls: 0 };
  store.writeWorking = async (/** @type {any[]} */ ...args) => {
    state.calls += 1;
    if (state.calls <= n) fs.appendFileSync(ws.file(FILE), `\nConcurrent edit ${state.calls}.\n`);
    return orig(...args);
  };
  return state;
}

describe('apply', () => {
  test('a concurrent change makes the CAS write fail; apply re-reads and retries', async () => {
    const { ctx } = await reviewed();
    const race = raceWrites(ctx, 1);
    const r = await ops.applySuggestions(ctx, DOC, ['t2']);
    assert.equal(race.calls, 2, 'one conflict, one successful retry');
    assert.deepEqual(r.applied.map((a) => [a.id, a.lines, a.how]), [['t2', [23, 23], 'exact']]);
    const text = ws.read(FILE);
    assert.match(text, /^1\. Prototype the issuer behind the gateway\.$/m);
    assert.match(text, /Concurrent edit 1\.\n$/, 'the concurrent change is kept');
    assert.equal((await ctx.store.getThread(DOC, 't2'))?.suggestion?.status, 'staged');
    const pending = await ctx.store.readPendingEdits(DOC);
    assert.equal(pending.length, 1);
    assert.deepEqual([pending[0].via, pending[0].threads], ['apply', ['t2']]);
  });

  test('gives up with ConflictError after 3 conflicting attempts and changes nothing', async () => {
    const { ctx } = await reviewed();
    const race = raceWrites(ctx, 99);
    await assert.rejects(ops.applySuggestions(ctx, DOC, ['t2']), (err) => err instanceof ConflictError && /** @type {any} */ (err).exit === 3);
    assert.equal(race.calls, 3);
    assert.doesNotMatch(ws.read(FILE), /behind the gateway/);
    assert.equal((await ctx.store.getThread(DOC, 't2'))?.suggestion?.status, 'pending');
    assert.deepEqual(await ctx.store.readPendingEdits(DOC), []);
  });

  test('a suggestion whose text is gone is a conflict; non-suggestions and staged ones are skipped', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), '1. Prototype the issuer.', '1. Build a prototype issuer.');
    const dry = await ops.applySuggestions(ctx, DOC, ['t2'], { dryRun: true });
    assert.equal(dry.dryRun, true);
    const r = await ops.applySuggestions(ctx, DOC, ['t2', 't1']);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.conflicts.map((c) => c.id), ['t2']);
    assert.match(r.conflicts[0].reason, /^expected text not found near L23; treat as a normal comment$/);
    assert.deepEqual(r.skipped.map((s) => s.id), ['t1']);
    assert.equal((await ctx.store.getThread(DOC, 't2'))?.suggestion?.status, 'conflict');
    assert.match(ops.formatApply(r), /conflict t2: expected text not found near L23/);
  });

  test('a dry run reports without writing; applying twice skips the staged suggestion', async () => {
    const { ctx } = await reviewed();
    const before = ws.read(FILE);
    const dry = await ops.applySuggestions(ctx, DOC, ['t2'], { dryRun: true });
    assert.deepEqual(dry.applied.map((a) => a.id), ['t2']);
    assert.equal(ws.read(FILE), before);
    await ops.applySuggestions(ctx, DOC, ['t2']);
    const again = await ops.applySuggestions(ctx, DOC, ['t2']);
    assert.deepEqual(again.skipped, [{ id: 't2', reason: 'already applied to the working copy (staged)' }]);
  });
});

describe('edit', () => {
  test('a stale expectSha256 fails at once with ConflictError', async () => {
    const { ctx, doc } = await reviewed();
    const { sha256 } = await ctx.store.readWorking(doc);
    editFile(ws.file(FILE), '3. Remove the legacy session store.', '3. Remove the legacy session store (Q3).');
    await assert.rejects(
      ops.taggedEdit(ctx, DOC, { threads: ['t1'], oldString: 'rotated on every use', newString: 'rotated with a grace window', expectSha256: sha256 }),
      ConflictError,
    );
    assert.match(ws.read(FILE), /rotated on every use/);
  });

  test('old_string must exist and be unique unless all', async () => {
    const { ctx } = await reviewed();
    await assert.rejects(ops.taggedEdit(ctx, DOC, { threads: ['t1'], oldString: 'no such text', newString: 'x' }), /old_string not found/);
    await assert.rejects(ops.taggedEdit(ctx, DOC, { threads: ['t1'], oldString: 'token', newString: 'credential' }), /not unique \(\d+ occurrences\)/);
    await assert.rejects(ops.taggedEdit(ctx, DOC, { threads: ['t9'], oldString: 'token', newString: 'x' }), /thread t9 not found/);
    const r = await ops.taggedEdit(ctx, DOC, { threads: ['t1'], oldString: '15 min', newString: '10 min', replaceAll: true });
    assert.equal(r.count, 2);
    assert.deepEqual(r.lines, [45, 47]);
  });

  test('edit --stdin batches are all or nothing and tag every splice', async () => {
    const { ctx } = await reviewed();
    const before = ws.read(FILE);
    await assert.rejects(
      ops.taggedEdits(ctx, DOC, [
        { threads: ['t1'], old: 'rotated on every use', new: 'rotated with a grace window' },
        { threads: 't2', old: 'missing text', new: 'x' },
      ]),
      (err) => err instanceof RefusedError && /^edit 2: old_string not found/.test(err.message),
    );
    assert.equal(ws.read(FILE), before, 'the first edit was not written');
    const r = await ops.taggedEdits(ctx, DOC, [
      { threads: ['t1'], old: 'rotated on every use', new: 'rotated with a grace window' },
      { threads: 't1,t2', old: '1. Prototype the issuer.', new: '1. Prototype the issuer.\n   Run it behind the gateway.' },
    ]);
    assert.deepEqual(r.edits.map((e) => [e.threads, e.lines, e.count]), [[['t1'], [52, 52], 1], [['t1', 't2'], [23, 24], 1]]);
    assert.deepEqual((await ctx.store.readPendingEdits(DOC)).map((p) => [p.via, p.threads]), [['edit', ['t1']], ['edit', ['t1', 't2']]]);
  });
});

describe('revert', () => {
  test('--hunk restores one hunk; --lock restores the agreed text', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), '2. Ship rotation behind a flag.', '2. Ship rotation.');
    editFile(ws.file(FILE), 'never stores tokens', 'caches tokens');
    const r = await ops.revert(ctx, DOC, { hunk: 'h1' });
    assert.deepEqual(r, { hunk: 'h1', lines: [24, 24] });
    assert.match(ws.read(FILE), /^2\. Ship rotation behind a flag\.$/m);
    await assert.rejects(ops.revert(ctx, DOC, { hunk: 'h7' }), /hunk h7 not found between v1 and the working copy \(hunks: h1\)/);
    const l = await ops.revert(ctx, DOC, { lock: 'L1' });
    assert.equal(l.lock, 'L1');
    assert.match(ws.read(FILE), /the gateway never stores tokens; it only forwards them/);
    assert.equal((await ctx.store.readVersion(DOC, 1)).source, ws.read(FILE), 'back to v1');
    const noop = await ops.revert(ctx, DOC, { lock: 'L1' });
    assert.equal(noop.noop, true);
  });

  test('--lock on agreed text extended at its edge names the hunk instead of calling it intact', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'never stores tokens;', 'never stores tokens or keys;');
    await assert.rejects(ops.revert(ctx, DOC, { lock: 'L1' }), (err) => err instanceof RefusedError && /suiko revert kitchen-sink --hunk h1/.test(err.message));
    await ops.revert(ctx, DOC, { hunk: 'h1' });
    assert.equal((await ctx.store.readVersion(DOC, 1)).source, ws.read(FILE), 'back to v1');
  });
});

describe('revise without changes, reply, ask, reanchor', () => {
  test('revise with an unchanged working copy records replies only; nothing at all is a no-op', async () => {
    const { ctx } = await reviewed();
    const nothing = await ops.revise(ctx, DOC, {});
    assert.equal(nothing.nothing, true);
    assert.equal(nothing.version, null);
    // a dry run says what it would post, and posts nothing
    const dry = await ops.revise(ctx, DOC, { threads: { t1: { status: 'needs_input', reply: 'Which one?' } }, dryRun: true });
    assert.equal(ops.formatReviseReport(dry), 'suiko: working copy matches v1; would post 1 reply (no new version)\n  t1 needs_input\ndry run: nothing posted.\n');
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.comments.length, 1);
    const r = await ops.revise(ctx, DOC, {
      threads: {
        t1: { status: 'needs_input', reply: 'Grace window of 30 s or configurable?' },
        t2: { status: 'declined', reply: 'Where it runs is covered in section 2.' },
      },
    });
    assert.equal(r.repliesOnly, true);
    assert.equal(r.version, null);
    assert.equal(r.notified, true);
    assert.equal((await ctx.store.getDoc(DOC))?.head, 1, 'no version recorded');
    const t1 = await ctx.store.getThread(DOC, 't1');
    assert.equal(t1?.status, 'needs_input');
    assert.deepEqual(t1?.comments.at(-1) && [t1.comments.at(-1)?.by.kind, t1.comments.at(-1)?.status, t1.comments.at(-1)?.version], ['agent', 'needs_input', 1]);
    assert.equal((await ctx.store.getThread(DOC, 't2'))?.status, 'declined');
    assert.equal(
      ops.formatReviseReport(r),
      'suiko: working copy matches v1; posted 2 replies (no new version)\n  t1 needs_input\n  t2 declined\n' +
        'next: suiko wait kitchen-sink (background)\n',
    );
    const events = (await ctx.store.readEvents(DOC, 0)).filter((e) => e.type === SSE.THREAD_UPDATED && e.replies);
    assert.equal(events.length, 1);
  });

  test('revise rejects malformed input', async () => {
    const { ctx } = await reviewed();
    await assert.rejects(ops.revise(ctx, DOC, { threads: { t1: { status: 'done', reply: 'x' } } }), /threads\.t1\.status/);
    await assert.rejects(ops.revise(ctx, DOC, { threads: { t1: { status: 'addressed', reply: '' } } }), /threads\.t1\.reply/);
    await assert.rejects(ops.revise(ctx, DOC, { threads: { t9: { status: 'addressed', reply: 'x' } } }), /thread t9 not found/);
    await assert.rejects(ops.revise(ctx, DOC, { other: [{ at: 'L3' }] }), /"at" and "why"/);
    await assert.rejects(ops.revise(ctx, DOC, { breakLocks: { L7: 'x' } }), /L7: no such lock/);
  });

  test('reply sets the status; ask creates an agent-question thread on head', async () => {
    const { ctx } = await reviewed();
    const r = await ops.reply(ctx, DOC, 't1', { body: 'A 30 s window, see L51.', status: 'answered', at: 'L51' });
    assert.equal(r.status, 'answered');
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.status, 'answered');
    await assert.rejects(ops.reply(ctx, DOC, 't1', { body: 'x', status: 'resolved' }), /invalid reply status/);

    const q = await ops.ask(ctx, DOC, { quote: 'Load test the issuer', body: 'Which load profile?' });
    assert.equal(q.thread.id, 't3');
    assert.deepEqual([q.thread.type, q.thread.status, q.thread.review, q.lines], ['agent-question', 'needs_input', null, [69, 69]]);
    const listed = await ops.threads(ctx, DOC, { status: 'needs_input' });
    assert.deepEqual(listed.threads.map((t) => t.id), ['t3']);
    await assert.rejects(ops.ask(ctx, DOC, { quote: 'not in the doc', body: 'x' }), /text not found in v1/);
  });

  test('reanchor applies to head on a clean copy and is staged on a dirty one', async () => {
    const { ctx } = await reviewed();
    const r = await ops.reanchorThread(ctx, DOC, 't1', { lines: 'L51-52' });
    assert.equal(r.staged, false);
    assert.deepEqual([r.anchor?.state, r.anchor?.mappedBy, r.anchor?.src.startLine, r.anchor?.src.endLine], ['exact', 'override', 51, 52]);

    editFile(ws.file(FILE), '3. Remove the legacy session store.', '3. Remove the legacy session store.\n4. Delete old tokens.');
    const s = await ops.reanchorThread(ctx, DOC, 't2', { quote: 'Delete old tokens.' });
    assert.equal(s.staged, true);
    const rev = await ops.revise(ctx, DOC, { threads: { t2: { status: 'answered', reply: 'Added step 4 instead.' } }, other: [{ at: 'L26', why: 'step 4' }] });
    assert.equal(rev.version, 2);
    const t2 = await ctx.store.getThread(DOC, 't2');
    assert.deepEqual([t2?.anchors['2'].state, t2?.anchors['2'].mappedBy, t2?.anchors['2'].src.text], ['exact', 'override', 'Delete old tokens.']);
  });
});
