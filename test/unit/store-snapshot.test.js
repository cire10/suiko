// @ts-check
// Snapshot docs (store/snapshot.js, ops/snapshot.js): doc.json kind/origin and the synthetic path, identity by
// origin key (deduped under the workspace lock), findDoc never matching a snapshot, the working copy being head
// (never dirty, never written), openSnapshot / recordSnapshot (attribution, re-anchoring and guards that only warn),
// the refusals of the file-only ops, snapshot packets (no misleading File: line, kind-specific next:, the plan
// feedback citing the plan file) and the plan gate's `minVersion` wait.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/index.js';
import { formatPacket, formatPlanFeedback } from '../../src/core/review/packet.js';
import { NotFoundError, RefusedError, UsageError } from '../../src/core/store/errors.js';
import { docRefFor, isScratchRoot, normalizeOrigin, scratchBase, snapshotPath } from '../../src/core/store/snapshot.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
});
afterEach(async () => {
  await ws.cleanup();
});

const PLAN = ['# Plan: token refresh', '', '## Steps', '', '1. Rotate refresh tokens on every use.', '2. Keep a 30 s grace window.', '3. Ship behind a flag.', ''].join('\n');

/** A 45-line Markdown text: replacing its word changes enough to trip the unexplained-deletion guard. */
function longText(word = 'alpha') {
  const lines = ['# Long text', ''];
  for (let i = 1; i <= 43; i++) lines.push(`Line ${i} says ${word} ${word} ${word} number ${i}.`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {Awaited<ReturnType<typeof engineCtx>>} ctx
 * @param {string} docId
 * @param {string} quote
 * @param {{ verdict?: 'changes_requested' | 'comment' | 'approved', body?: string }} [o]
 */
async function reviewOn(ctx, docId, quote, { verdict = 'changes_requested', body = '' } = {}) {
  const doc = await ctx.store.requireDoc(docId);
  const render = await ctx.render(doc, doc.head);
  await ops.saveDraft(ctx, docId, { kind: 'thread', type: 'comment', capture: textCapture(render, quote), body: `About "${quote}".` });
  return ops.submitReview(ctx, docId, { verdict, body });
}

describe('snapshot store', () => {
  test('createSnapshotDoc writes kind, origin and a synthetic path without a dot segment', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc, created } = await ctx.store.createSnapshotDoc({ title: 'My Plan', origin: { type: 'plan', key: 'claude-plan:s1:inline', session: 's1' } });
    assert.equal(created, true);
    assert.equal(doc.id, 'my-plan');
    assert.equal(doc.kind, 'snapshot');
    assert.deepEqual(doc.origin, { type: 'plan', key: 'claude-plan:s1:inline', session: 's1' });
    assert.equal(doc.path, 'plans/my-plan.md');
    assert.equal(doc.head, 0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws.root, '.specreview', 'docs', 'my-plan', 'doc.json'), 'utf8'));
    assert.equal(onDisk.kind, 'snapshot');
    assert.equal(onDisk.origin.key, 'claude-plan:s1:inline');
    assert.equal(fs.existsSync(path.join(ws.root, 'plans')), false, 'nothing is written at the synthetic path');

    assert.equal(snapshotPath('message', 'x', 'markdown'), 'messages/x.md');
    assert.equal(snapshotPath('stdin', 'x', 'html'), 'text/x.html');
    assert.equal(snapshotPath('diff', 'x', 'markdown'), 'snapshots/x.md', 'unknown types get the default directory');
  });

  test('the origin key is the identity: concurrent creations dedupe, keyless ones get a new id', async () => {
    const ctx = await engineCtx(ws.root);
    const origin = { type: 'stdin', key: 'stdin:notes', name: 'notes' };
    const results = await Promise.all([1, 2, 3, 4].map(() => ctx.store.createSnapshotDoc({ title: 'Notes', origin })));
    assert.equal(new Set(results.map((r) => r.doc.id)).size, 1, 'one doc');
    assert.equal(results.filter((r) => r.created).length, 1, 'created once');
    assert.equal((await ctx.store.findDocByOrigin('stdin:notes'))?.id, 'notes');
    assert.equal(await ctx.store.findDocByOrigin('stdin:other'), null);

    const a = await ctx.store.createSnapshotDoc({ title: 'Notes', origin: { type: 'stdin', key: null } });
    assert.equal(a.created, true);
    assert.equal(a.doc.id, 'notes-2');
    const b = await ctx.store.createSnapshotDoc({ slug: '../../etc/passwd', origin: { type: 'stdin' } });
    assert.match(b.doc.id, /^[a-z0-9-]+$/, 'a slug never escapes the docs directory');
    assert.equal(b.doc.path, `text/${b.doc.id}.md`);
  });

  test('normalizeOrigin validates type and key', () => {
    assert.throws(() => normalizeOrigin(null), UsageError);
    assert.throws(() => normalizeOrigin({ type: 'Plan' }), UsageError);
    assert.throws(() => normalizeOrigin({ type: 'plan', key: '' }), UsageError);
    assert.throws(() => normalizeOrigin({ type: 'plan', key: 'a\nb' }), UsageError);
    assert.throws(() => normalizeOrigin({ type: 'plan', key: 'x'.repeat(1025) }), UsageError);
    assert.deepEqual(normalizeOrigin({ type: 'url', extra: 1 }), { type: 'url', key: null, extra: 1 });
  });

  test('findDoc never matches a snapshot by path or basename; a real file at the synthetic path stays separate', async () => {
    const ctx = await engineCtx(ws.root);
    const snap = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'plan', key: 'k1' }, title: 'Plan' });
    assert.equal(snap.doc.path, 'plans/plan.md');
    assert.equal(await ctx.store.findDoc('plans/plan.md'), null);
    assert.equal(await ctx.store.findDoc('plan.md'), null);
    assert.equal((await ctx.store.findDoc('plan'))?.id, 'plan', 'the id still finds it');

    fs.mkdirSync(path.join(ws.root, 'plans'), { recursive: true });
    ws.write('plans/plan.md', '# A real file\n\nWith text.\n');
    const real = await ops.openDoc(ctx, { path: 'plans/plan.md' });
    assert.equal(real.created, true);
    assert.notEqual(real.doc.id, 'plan');
    assert.equal(real.doc.kind, undefined);
    assert.equal((await ctx.store.findDoc('plans/plan.md'))?.id, real.doc.id);
  });

  test('the working copy of a snapshot is its head version; writeWorking and workingPath refuse', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc: empty } = await ctx.store.createSnapshotDoc({ title: 'Empty', origin: { type: 'message' } });
    await assert.rejects(ctx.store.readWorking(empty), NotFoundError);

    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'stdin', key: 'stdin:w' } });
    await ops.recordSnapshot(ctx, doc.id, { source: PLAN.replace('30 s', '60 s') });
    const d = await ctx.store.requireDoc(doc.id);
    const w = await ctx.store.readWorking(d);
    const head = await ctx.store.readVersion(d.id, 2);
    assert.equal(w.text, head.source);
    assert.equal(w.stable, true);
    assert.throws(() => ctx.store.workingPath(d), RefusedError);
    await assert.rejects(ctx.store.writeWorking(d, 'x', { expectSha256: null }), (err) => err instanceof RefusedError && /snapshot \(piped text\)/.test(err.message) && /--source/.test(err.message));
    const st = await ops.status(ctx, d.id);
    assert.deepEqual([st.docs[0].working, st.docs[0].kind, st.docs[0].origin, st.docs[0].file], ['clean', 'snapshot', 'stdin', null]);
  });
});

describe('snapshot ops', () => {
  test('openSnapshot records v1 with the origin on the manifest; reopening reports the existing doc', async () => {
    const ctx = await engineCtx(ws.root);
    const origin = { type: 'plan', key: 'claude-plan:s:inline', session: 's' };
    const first = await ops.openSnapshot(ctx, { source: PLAN, origin });
    assert.equal(first.created, true);
    assert.equal(first.doc.title, 'Plan: token refresh', 'title from the first heading');
    assert.equal(first.doc.id, 'plan-token-refresh');
    assert.equal(first.version.v, 1);
    assert.equal(first.version.capturedBy, 'open');
    assert.deepEqual(first.version.origin, origin);
    const again = await ops.openSnapshot(ctx, { source: 'other text', origin });
    assert.equal(again.created, false);
    assert.equal(again.doc.head, 1, 'openSnapshot never records a second version');
    await assert.rejects(ops.openSnapshot(ctx, { source: '  \n', origin: { type: 'stdin' } }), UsageError);
  });

  test('recordSnapshot records vN+1: attribution, re-anchoring, replies, origin; identical bytes record nothing', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'message', key: 'claude-msg:s:m1' } });
    const review = await reviewOn(ctx, doc.id, 'Keep a 30 s grace window.');
    assert.equal(review.id, 'rv1');

    const v2 = PLAN.replace('Keep a 30 s grace window.', 'Keep a 60 s grace window.');
    const r = await ops.recordSnapshot(ctx, doc.id, {
      source: v2,
      origin: { type: 'message', key: 'claude-msg:s:m1', messageId: 'm2' },
      replies: { t1: { status: 'addressed', reply: 'Now 60 s.' } },
    });
    assert.equal(r.version, 2);
    assert.equal(r.refused, false);
    assert.equal(r.snapshot, true);
    assert.equal(r.respondsTo, 'rv1');
    const { manifest } = await ctx.store.readVersion(doc.id, 2);
    assert.equal(manifest.capturedBy, 'snapshot');
    assert.equal(manifest.origin.messageId, 'm2');
    assert.deepEqual(manifest.hunks.map((h) => h.threads), [['t1']]);
    const t1 = await ctx.store.getThread(doc.id, 't1');
    assert.deepEqual(t1?.changes.map((c) => [c.version, c.hunk]), [[2, 'h1']]);
    assert.ok(t1?.anchors['2'], 're-anchored on v2');
    assert.notEqual(t1?.anchors['2'].state, 'orphaned');
    assert.equal(t1?.comments.at(-1)?.body, 'Now 60 s.');

    const ch = await ops.changes(ctx, doc.id, { from: 1, to: 2 });
    assert.equal(ch.hunks.length, 1);
    assert.deepEqual(ch.hunks[0].threads, ['t1']);
    const mini = await ops.threadMiniDiff(ctx, doc.id, 't1');
    assert.equal(mini.kind, 'text');
    assert.match(mini.before, /30 s/);
    assert.match(mini.after, /60 s/);

    const same = await ops.recordSnapshot(ctx, doc.id, { source: v2 });
    assert.equal(same.nothing, true);
    assert.equal((await ctx.store.requireDoc(doc.id)).head, 2);
    await assert.rejects(ops.recordSnapshot(ctx, doc.id, { source: '' }), UsageError);
  });

  test('guards only warn for snapshots: a change a file doc refuses is recorded, its errors kept as warnings', async () => {
    const ctx = await engineCtx(ws.root);
    // the same unexplained 129-word replacement, as a file doc and as a snapshot
    ws.write('docs/long.md', longText('alpha'));
    const file = await ops.openDoc(ctx, { path: 'docs/long.md' });
    ws.write('docs/long.md', longText('omega'));
    const refused = await ops.revise(ctx, file.doc.id, {});
    assert.equal(refused.refused, true);
    const codes = refused.guards.errors.map((/** @type {any} */ e) => e.code);
    assert.ok(codes.includes('deletion'), `file doc refused for: ${codes}`);

    const { doc } = await ops.openSnapshot(ctx, { source: longText('alpha'), origin: { type: 'stdin', key: 'stdin:long' } });
    const r = await ops.recordSnapshot(ctx, doc.id, { source: longText('omega') });
    assert.equal(r.refused, false);
    assert.equal(r.version, 2);
    assert.deepEqual(r.guards.errors, []);
    for (const c of codes) assert.ok(r.guards.warnings.some((/** @type {any} */ w) => w.code === c), `${c} kept as a warning`);
    const { manifest } = await ctx.store.readVersion(doc.id, 2);
    assert.deepEqual(manifest.guards.errors, []);
    assert.ok(manifest.guards.warnings.some((w) => /linked to no thread/.test(w)));
    assert.equal(manifest.guards.forced, false);
  });

  test('takeSnapshot opens, then records vN+1 of the doc with the same key', async () => {
    const ctx = await engineCtx(ws.root);
    const origin = { type: 'stdin', key: 'stdin:x' };
    const a = await ops.takeSnapshot(ctx, { source: 'one\n', origin, title: 'X' });
    assert.deepEqual([a.created, a.doc.head, a.report], [true, 1, null]);
    const b = await ops.takeSnapshot(ctx, { source: 'two\n', origin });
    assert.deepEqual([b.created, b.doc.head, b.version.v, b.report.version], [false, 2, 2, 2]);
    const c = await ops.takeSnapshot(ctx, { source: 'two\n', origin });
    assert.deepEqual([c.created, c.doc.head, c.report.nothing], [false, 2, true]);
  });

  test('file-only ops are refused with what to do instead; revise needs --source exactly for snapshots', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'stdin', key: 'stdin:r' } });
    await reviewOn(ctx, doc.id, 'Ship behind a flag.');
    const refusal = (/** @type {string} */ verb) => (/** @type {any} */ err) => err instanceof RefusedError && err.message.includes(`cannot ${verb} it`) && err.message.includes('--source');
    await assert.rejects(ops.applySuggestions(ctx, doc.id, ['t1']), refusal('apply suggestions to'));
    await assert.rejects(ops.taggedEdits(ctx, doc.id, [{ threads: ['t1'], old: 'Ship', new: 'Release' }]), refusal('edit'));
    await assert.rejects(ops.revert(ctx, doc.id, { hunk: 'h1' }), refusal('revert'));
    await assert.rejects(ops.revise(ctx, doc.id, {}), (/** @type {any} */ err) => err instanceof UsageError && /no working file to record/.test(err.message) && /--source <file>/.test(err.message));

    ws.write('docs/f.md', '# F\n\ntext\n');
    const f = await ops.openDoc(ctx, { path: 'docs/f.md' });
    await assert.rejects(ops.revise(ctx, f.doc.id, {}, { source: 'x' }), (/** @type {any} */ err) => err instanceof UsageError && /tracks the file docs\/f\.md/.test(err.message));
    await assert.rejects(ops.recordSnapshot(ctx, f.doc.id, { source: 'x' }), UsageError);
  });
});

describe('snapshot packets', () => {
  test('a message snapshot packet has no File: line, no apply, and a --source next step', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'message', key: 'claude-msg:s:m' } });
    await reviewOn(ctx, doc.id, 'Ship behind a flag.');
    const packet = await ops.feedback(ctx, doc.id, { peek: true });
    assert.equal(packet.kind, 'snapshot');
    assert.equal(packet.origin, 'message');
    assert.equal(packet.file, null);
    assert.equal(packet.ref, doc.id);
    assert.ok(packet.threads.every((t) => t.apply === null));
    assert.equal(packet.next, `write the complete revised text to a file -> specreview revise ${doc.id} --source <file> --replies - -> specreview wait ${doc.id} (background)`);
    const text = formatPacket(packet);
    assert.doesNotMatch(text, /^File:/m);
    assert.match(text, new RegExp(`^SPECREVIEW FEEDBACK · ${doc.id} \\(agent message\\)`, 'm'));
    assert.match(text, /^Line numbers = v1 of this message \(`specreview show [a-z0-9-]+` prints it\)\.$/m);
  });

  test('a plan snapshot packet and the plan feedback cite the real plan file', async () => {
    const ctx = await engineCtx(ws.root);
    const planFile = path.join(ws.root, 'plan-file.md');
    fs.writeFileSync(planFile, PLAN);
    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin: { type: 'plan', key: `claude-plan:s:${planFile}`, planFilePath: planFile } });
    await reviewOn(ctx, doc.id, 'Keep a 30 s grace window.', { body: 'Close, but not yet.' });
    const packet = await ops.feedback(ctx, doc.id, { peek: true });
    assert.equal(packet.file, planFile);
    assert.equal(packet.pathFromCwd, planFile);
    assert.match(packet.next, /^targeted Edit-tool changes to the plan file .*plan-file\.md \(never rewrite it\) -> call ExitPlanMode again/);
    const text = formatPacket(packet);
    assert.match(text, new RegExp(`^Plan file: ${planFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.doesNotMatch(text, /^File:/m);

    const msg = formatPlanFeedback(packet);
    const lines = msg.split('\n');
    assert.equal(lines[0], 'YOUR PLAN WAS NOT APPROVED: the reviewer requested changes (SpecReview rv1 on v1).');
    assert.equal(lines[1], `Plan file: ${planFile}   (line numbers below are lines of this file)`);
    assert.equal(lines[2], 'Reviewer summary: Close, but not yet.');
    assert.match(msg, /\[t1\] .*L6/);
    assert.match(msg, /src> 2\. Keep a 30 s grace window\./);
    assert.match(msg, /- Make targeted changes to .*plan-file\.md with the Edit tool/);
    assert.match(msg, /Address every thread above/);
    assert.match(msg, /Then call ExitPlanMode again\. The reviewer will see a diff of your changes \(v1 -> v2\)/);
  });

  test('docRefFor names scratch workspaces with --workspace', () => {
    const scratch = path.join(scratchBase(), 'abcd1234');
    assert.equal(isScratchRoot(scratch), true);
    assert.equal(isScratchRoot(scratchBase()), false);
    assert.equal(isScratchRoot(ws.root), false);
    assert.equal(docRefFor('notes', ws.root), 'notes');
    assert.equal(docRefFor('notes', scratch), `notes --workspace ${scratch}`);
  });
});

describe('wait minVersion (plan gate)', () => {
  test('an older delivered-or-not review does not satisfy a wait for a newer version', async () => {
    const ctx = await engineCtx(ws.root);
    const origin = { type: 'stdin', key: 'stdin:mv' };
    const { doc } = await ops.openSnapshot(ctx, { source: PLAN, origin });
    await reviewOn(ctx, doc.id, 'Ship behind a flag.', { verdict: 'approved' });
    await ops.recordSnapshot(ctx, doc.id, { source: `${PLAN}4. Document it.\n` });

    const early = await ops.waitForFeedback(ctx, { docIds: [doc.id], allowDirty: true, minVersion: 2, timeoutMs: 300, pollMs: 20, write: () => {} });
    assert.equal(early.status, 'timeout');
    assert.equal((await ctx.store.getReview(doc.id, 'rv1'))?.deliveredTo?.claude, undefined, 'the old review is not delivered');

    /** @type {any[]} */
    const written = [];
    const waiting = ops.waitForFeedback(ctx, { docIds: [doc.id], allowDirty: true, minVersion: 2, timeoutMs: 5000, pollMs: 20, write: (_t, p) => void written.push(p) });
    await new Promise((r) => setTimeout(r, 100));
    await reviewOn(ctx, doc.id, 'Document it.', { verdict: 'changes_requested' });
    const r = await waiting;
    assert.equal(r.status, 'delivered');
    assert.deepEqual(written[0].reviews.map((x) => x.id), ['rv1', 'rv2'], 'the older review comes along');
    assert.equal(written[0].verdict, 'changes_requested');
  });
});
