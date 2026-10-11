// @ts-check
// Data-safety regressions of the review engine: suggestions are only applied where their thread is anchored
// (never into another copy of the same text), inserted text follows a CRLF file's line endings, stale staged
// suggestions / tagged edits never fabricate "Applied" replies, `at` hints of an earlier round are not reused,
// deletions linked by overlap are only explained inside the thread's lines, revise and submit are crash-safe, a
// legacy-charset file is never rewritten, and approving + "Mark final" refuses a version the reviewer did not see.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConflictError, RefusedError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/index.js';
import { editFile, engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
});
afterEach(async () => {
  await ws.cleanup();
});

/**
 * Opens docs/<name> with `text` and returns the ctx, doc and v1 render.
 * @param {string} name
 * @param {string | Buffer} text
 */
async function openWith(name, text) {
  fs.writeFileSync(ws.file(`docs/${name}`), text);
  const ctx = await engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: `docs/${name}` });
  const v1 = await ctx.render(doc, 1);
  return { ctx, doc, v1 };
}

const TIMEOUTS = `# Spec

## Timeouts

The request timeout is 30 seconds for all calls.

## Retries

Clients retry after 30 seconds on failure.
`;

describe('suggestions are applied only where the thread is anchored (DS-1)', () => {
  /** A suggestion '30 seconds' -> '60 seconds' on the Timeouts sentence, delivered. */
  async function suggested() {
    const o = await openWith('spec.md', TIMEOUTS);
    await ops.saveDraft(o.ctx, o.doc.id, {
      kind: 'thread', type: 'suggestion', capture: textCapture(o.v1, '30 seconds', 0), body: 'make it 60',
      suggestion: { mode: 'text', new: '60 seconds' },
    });
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, 'request timeout'), body: 'say "s"' });
    await ops.submitReview(o.ctx, o.doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(o.ctx, o.doc.id, {});
    return o;
  }

  test('agent apply: the anchored sentence was edited -> conflict, the Retries sentence is untouched', async () => {
    const { ctx, doc } = await suggested();
    editFile(ws.file('docs/spec.md'), 'The request timeout is 30 seconds for all calls.', 'The request timeout is 45 s for all calls.');
    const r = await ops.applySuggestions(ctx, doc.id, ['t1']);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.conflicts.map((c) => c.id), ['t1']);
    assert.match(ws.read('docs/spec.md'), /Clients retry after 30 seconds on failure\./);
    assert.deepEqual(await ctx.store.readPendingEdits(doc.id), []);
  });

  test('agent apply still follows the anchor when text above it moved it', async () => {
    const { ctx, doc } = await suggested();
    editFile(ws.file('docs/spec.md'), '## Timeouts\n', '## Timeouts\n\nIntro paragraph that mentions 30 seconds too.\n');
    const r = await ops.applySuggestions(ctx, doc.id, ['t1']);
    assert.deepEqual(r.applied.map((a) => [a.id, a.how]), [['t1', 'exact']]);
    const text = ws.read('docs/spec.md');
    assert.match(text, /The request timeout is 60 seconds for all calls\./);
    assert.match(text, /mentions 30 seconds too/);
    assert.match(text, /Clients retry after 30 seconds/);
  });

  test('reviewer "Apply now": refuses when the anchored text is gone instead of editing another section', async () => {
    const { ctx, doc } = await suggested();
    editFile(ws.file('docs/spec.md'), 'The request timeout is 30 seconds for all calls.', 'The request timeout is 45 s for all calls.');
    const rv = await ops.revise(ctx, doc.id, { threads: { t2: { status: 'addressed', reply: 'done' }, t1: { status: 'declined', reply: 'chose 45 s instead' } } });
    assert.equal(rv.version, 2);
    await assert.rejects(ops.applySuggestionAsReviewer(ctx, doc.id, 't1', { by: 'Eric' }), RefusedError);
    assert.match(ws.read('docs/spec.md'), /Clients retry after 30 seconds on failure\./);
    assert.equal((await ctx.store.listVersions(doc.id)).length, 2, 'no version recorded');
    assert.equal((await ctx.store.getThread(doc.id, 't1'))?.status, 'declined');
  });
});

describe('line endings (DS-10)', () => {
  test('a multi-line suggestion and an edit on a CRLF file keep CRLF', async () => {
    const crlf = '# Spec\r\n\r\nFirst line of para.\r\nSecond line of para.\r\n\r\nTail line.\r\n';
    const { ctx, doc, v1 } = await openWith('crlf.md', crlf);
    await ops.saveDraft(ctx, doc.id, {
      kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'First line of para.'), body: '',
      suggestion: { mode: 'text', new: 'New first line.\nNew second line.' },
    });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    await ops.applySuggestions(ctx, doc.id, ['t1']);
    await ops.taggedEdit(ctx, doc.id, { threads: ['t1'], oldString: 'Tail line.', newString: 'Tail line.\nAnother tail line.' });
    // an old_string written with '\n' still matches the CRLF text
    await ops.taggedEdit(ctx, doc.id, { threads: ['t1'], oldString: 'Second line of para.\n\nTail', newString: 'Second line.\n\nTail' });
    const text = ws.read('docs/crlf.md');
    assert.equal(text, '# Spec\r\n\r\nNew first line.\r\nNew second line.\r\nSecond line.\r\n\r\nTail line.\r\nAnother tail line.\r\n');
    assert.doesNotMatch(text, /[^\r]\n/);
    const rv = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'done' } } });
    assert.equal(rv.refused, false);
    const v2 = await ctx.store.readVersion(doc.id, 2);
    assert.equal(v2.source, text);
  });
});

describe('stale staged suggestions and tagged edits (DS-5)', () => {
  const LIMITS = '# Spec\n\n## Limits\n\nThe API allows 100 requests per minute per key.\n\n## Auth\n\nKeys are rotated every 90 days.\n';

  async function limits() {
    const o = await openWith('limits.md', LIMITS);
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, '100 requests per minute'), body: 'Per key or per account?' });
    await ops.saveDraft(o.ctx, o.doc.id, {
      kind: 'thread', type: 'suggestion', capture: textCapture(o.v1, '100 requests'), body: 'Raise it',
      suggestion: { mode: 'text', new: '500 requests' },
    });
    await ops.submitReview(o.ctx, o.doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(o.ctx, o.doc.id, {});
    return o;
  }

  test('apply, revert, replies-only decline: the suggestion is un-staged and its tag cannot claim a later edit', async () => {
    const { ctx, doc } = await limits();
    await ops.applySuggestions(ctx, doc.id, ['t2']);
    await ops.revert(ctx, doc.id, { hunk: 'h1' });
    assert.equal(ws.read('docs/limits.md'), LIMITS);
    const r1 = await ops.revise(ctx, doc.id, { threads: { t2: { status: 'declined', reply: 'Product wants to keep 100/min.' } } });
    assert.equal(r1.repliesOnly, true);
    assert.equal((await ctx.store.getThread(doc.id, 't2'))?.suggestion?.status, 'pending');
    assert.deepEqual(await ctx.store.readPendingEdits(doc.id), []);

    editFile(ws.file('docs/limits.md'), '100 requests per minute per key.', '100 requests per minute per API key (not per account).');
    const r2 = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Clarified: per API key.' } } });
    assert.equal(r2.version, 2);
    assert.deepEqual(r2.hunks.map((/** @type {any} */ h) => [h.id, h.threads]), [['h1', ['t1']]]);
    const t2 = await ctx.store.getThread(doc.id, 't2');
    assert.deepEqual([t2?.suggestion?.status, t2?.suggestion?.appliedIn, t2?.status], ['pending', null, 'declined']);
    assert.ok(!t2?.comments.some((c) => /Applied the suggestion/.test(c.body)), 'no fabricated "applied" reply');
  });

  test('a staged suggestion undone by hand before revise is not reported as applied', async () => {
    const { ctx, doc } = await limits();
    await ops.applySuggestions(ctx, doc.id, ['t2']);
    // the agent undoes the apply with its editor and clarifies the line for t1 instead
    editFile(ws.file('docs/limits.md'), '500 requests per minute per key.', '100 requests per minute per API key.');
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Clarified.' } } });
    assert.equal(r.version, 2);
    assert.ok(r.hunks.every((/** @type {any} */ h) => h.linkedBy !== 'tagged'), 'the stale tag links nothing');
    const t2 = await ctx.store.getThread(doc.id, 't2');
    assert.deepEqual([t2?.suggestion?.status, t2?.status], ['pending', 'open']);
    assert.ok(!t2?.comments.some((c) => /Applied the suggestion/.test(c.body)));
    // and it can be applied for real later
    const again = await ops.applySuggestions(ctx, doc.id, ['t2']);
    assert.deepEqual(again.applied.map((a) => a.id), ['t2']);
  });

  test('a staged suggestion that is in the version is applied with the automatic reply', async () => {
    const { ctx, doc } = await limits();
    await ops.applySuggestions(ctx, doc.id, ['t2']);
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'answered', reply: 'Per key.' } } });
    assert.equal(r.version, 2);
    const t2 = await ctx.store.getThread(doc.id, 't2');
    assert.deepEqual([t2?.suggestion?.status, t2?.suggestion?.appliedIn, t2?.status], ['applied', 2, 'addressed']);
  });
});

/** Parts 1..n, each a heading plus a 3-line body (9 words per line). */
function parts(n) {
  let out = '# Guide\n';
  for (let i = 1; i <= n; i++) {
    out += `\n## Part ${i}\n\nPart ${i} line one has some words in it here.\nPart ${i} line two has some words in it here.\nPart ${i} line three has some words in it here.\n`;
  }
  return out;
}

describe('`at` hints of an earlier round are not reused (stale-at-hints)', () => {
  test('a resolved thread\'s old "at" lines neither link nor explain a later deletion there', async () => {
    const { ctx, doc, v1 } = await openWith('guide.md', parts(8));
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Part 1 line one'), body: 'Fix parts 1 and 6.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    const li = ws.read('docs/guide.md').split('\n');
    const l6 = li.indexOf('Part 6 line one has some words in it here.') + 1;
    editFile(ws.file('docs/guide.md'), 'Part 1 line one has some', 'Part 1 line one has fixed');
    editFile(ws.file('docs/guide.md'), 'Part 6 line one has some', 'Part 6 line one has fixed');
    const r1 = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Fixed both.', at: `L${li.indexOf('Part 1 line one has some words in it here.') + 1},L${l6}` } } });
    assert.equal(r1.version, 2);

    // round 2: t1 resolved, t2 on Part 2
    const v2 = await ctx.render(doc, 2);
    await ops.saveDraft(ctx, doc.id, { kind: 'resolve', thread: 't1' });
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v2, 'Part 2 line one'), body: 'Reword.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    editFile(ws.file('docs/guide.md'), 'Part 2 line one has some', 'Part 2 line one has reworded');
    const text = ws.read('docs/guide.md');
    const body6 = 'Part 6 line one has fixed words in it here.\nPart 6 line two has some words in it here.\nPart 6 line three has some words in it here.\n';
    assert.ok(text.includes(body6));
    ws.write('docs/guide.md', text.replace(body6, 'Part 6 is TBD.\n'));
    const dry = await ops.revise(ctx, doc.id, { dryRun: true, threads: { t2: { status: 'addressed', reply: 'Reworded.' } } });
    const h6 = dry.hunks.find((/** @type {any} */ h) => h.section === 'Part 6');
    assert.ok(h6);
    assert.deepEqual(h6.threads, [], 'the old t1 hint does not link the Part 6 hunk');
    assert.equal(dry.refused, true);
    assert.ok(dry.guards.errors.some((/** @type {any} */ e) => e.code === 'deletion' && e.hunk === h6.id));
  });

  test('a reply --at made against head (not stored with it) still links', async () => {
    const { ctx, doc, v1 } = await openWith('guide.md', parts(3));
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'Can part 3 go?' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    void v1;
    const lines = ws.read('docs/guide.md').split('\n');
    const l = lines.indexOf('Part 3 line one has some words in it here.') + 1;
    await ops.reply(ctx, doc.id, 't1', { body: 'Dropping the first line of part 3.', status: 'addressed', at: `L${l}` });
    editFile(ws.file('docs/guide.md'), 'Part 3 line one has some words in it here.\n', '');
    const r = await ops.revise(ctx, doc.id, { dryRun: true, threads: {} });
    assert.deepEqual(r.hunks.map((/** @type {any} */ h) => [h.threads, h.linkedBy]), [[['t1'], 'hint']]);
  });
});

describe('deletion guard on linked hunks (DS-4)', () => {
  const SECS = ['Overview', 'Goals', 'Architecture', 'Security', 'Storage', 'API', 'Rollout', 'Monitoring', 'Costs', 'Open questions'];
  const para = (/** @type {string} */ s, /** @type {number} */ i) => `In the ${s} area, requirement ${i} states that the system must handle case ${i} reliably and report failures to the operator.`;
  const SPEC = `# Spec\n\n${SECS.map((s) => `## ${s}\n\n${para(s, 1)}\n\n${para(s, 2)}\n\n${para(s, 3)}\n`).join('\n')}`;

  async function commented() {
    const o = await openWith('spec.md', SPEC);
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, 'In the Security area, requirement 1'), body: 'Tighten the wording of this sentence.' });
    await ops.submitReview(o.ctx, o.doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(o.ctx, o.doc.id, {});
    return o;
  }

  test('deleting four sections in one hunk that touches the commented sentence is refused', async () => {
    const { ctx, doc } = await commented();
    const t = ws.read('docs/spec.md');
    ws.write('docs/spec.md', t.slice(0, t.indexOf('## Security')) + t.slice(t.indexOf('## Monitoring')));
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Tightened.' } } });
    assert.equal(r.refused, true);
    const e = r.guards.errors.find((/** @type {any} */ x) => x.code === 'deletion');
    assert.ok(e, JSON.stringify(r.guards.errors));
    assert.match(e.message, /outside the text of t1/);
    assert.equal((await ctx.store.listVersions(doc.id)).length, 1);
    // an explicit "other" entry explains it
    const ok = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Tightened.' } }, other: [{ at: `del:${e.hunk}`, why: 'the reviewer asked to drop them in chat' }] });
    assert.equal(ok.refused, false);
  });

  test('a comment on a heading explains deleting its section; a GENERAL comment explains anything', async () => {
    const { ctx, doc, v1 } = await openWith('spec.md', SPEC);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Storage'), body: 'Drop this section.' });
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Also drop Costs.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    let t = ws.read('docs/spec.md');
    t = t.slice(0, t.indexOf('## Storage')) + t.slice(t.indexOf('## API'));
    t = t.slice(0, t.indexOf('## Costs')) + t.slice(t.indexOf('## Open questions'));
    ws.write('docs/spec.md', t);
    const costsAt = ws.read('docs/spec.md').split('\n').indexOf('## Open questions');
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Dropped.' }, t2: { status: 'addressed', reply: 'Dropped.', at: `L${costsAt}` } } });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
  });

  test('rewording the commented paragraph (inside its scope) is not refused', async () => {
    const { ctx, doc } = await commented();
    editFile(ws.file('docs/spec.md'), para('Security', 1), 'Security requirement 1: the system handles case 1 and reports failures to the operator, always, with no exceptions at all for anyone.');
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Tightened.' } } });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.equal(r.version, 2);
  });
});

/**
 * Makes the next call of a store method throw after (optionally) running it, like a process killed there.
 * @param {any} store
 * @param {string} method
 * @param {{ run?: boolean }} [opts] run the real method first (crash right after it)
 */
function crashOnce(store, method, { run = false } = {}) {
  const orig = store[method].bind(store);
  store[method] = async (/** @type {any[]} */ ...args) => {
    store[method] = orig;
    if (run) await orig(...args);
    throw new Error(`simulated crash in ${method}`);
  };
}

describe('crash safety of revise (DS-3)', () => {
  const FILLER = Array.from({ length: 30 }, (_, i) => `Filler paragraph number ${i + 1}.`).join('\n\n');
  const DOC = `# Spec\n\n## Cache\n\nThe cache TTL is 5 minutes.\n\n## Other\n\n${FILLER}\n`;

  async function reviewed() {
    const o = await openWith('cache.md', DOC);
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, 'The cache TTL is 5 minutes.'), body: 'Too short?' });
    await ops.submitReview(o.ctx, o.doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(o.ctx, o.doc.id, {});
    // insert text above the comment and change it, tagged
    editFile(ws.file('docs/cache.md'), '## Cache\n', `## Cache\n\n${FILLER}\n`);
    await ops.taggedEdit(o.ctx, o.doc.id, { threads: ['t1'], oldString: 'TTL is 5 minutes', newString: 'TTL is 15 minutes' });
    return o;
  }

  test('killed right after the version commit point: the next op rolls the revision forward', async () => {
    const { ctx, doc } = await reviewed();
    crashOnce(ctx.store, 'applyJournal');
    await assert.rejects(ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Raised to 15.' } } }), /simulated crash/);
    assert.deepEqual((await ctx.store.listVersions(doc.id)).map((m) => m.v), [1, 2], 'the version is committed');

    const ctx2 = await engineCtx(ws.root); // a fresh process
    // a pure reader already sees the rolled-forward state
    const listed = await ops.threads(ctx2, doc.id, { status: 'all' });
    const row = /** @type {any} */ (listed.threads.find((/** @type {any} */ t) => t.id === 't1'));
    const lines = ws.read('docs/cache.md').split('\n');
    assert.equal(lines[row.lines[0] - 1], 'The cache TTL is 15 minutes.');
    const t1 = await ctx2.store.getThread(doc.id, 't1');
    assert.deepEqual(Object.keys(t1?.anchors ?? {}), ['1', '2'], 'thread re-anchored at head');
    assert.equal(t1?.anchors['2'].src.text, 'The cache TTL is 15 minutes.');
    assert.equal(t1?.status, 'addressed');
    assert.deepEqual(t1?.comments.map((c) => c.body), ['Too short?', 'Raised to 15.']);
    assert.deepEqual(await ctx2.store.readPendingEdits(doc.id), []);
    assert.equal((await ctx2.store.getDoc(doc.id))?.head, 2);
    assert.equal(fs.existsSync(ctx2.store.journalFile(doc.id)), false);
    const events = (await ctx2.store.readEvents(doc.id, 0)).filter((e) => e.type === 'version.created');
    assert.ok(events.some((e) => e.v === 2), 'the version.created event is appended on roll-forward');
  });

  test('a failure before the commit point records nothing', async () => {
    const { ctx, doc } = await reviewed();
    crashOnce(ctx.store, 'writeJournal');
    await assert.rejects(ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Raised to 15.' } } }), /simulated crash/);
    const ctx2 = await engineCtx(ws.root);
    await ctx2.store.recoverDoc(doc.id);
    assert.deepEqual((await ctx2.store.listVersions(doc.id)).map((m) => m.v), [1]);
    assert.equal((await ctx2.store.getDoc(doc.id))?.head, 1);
    const t1 = await ctx2.store.getThread(doc.id, 't1');
    assert.deepEqual(Object.keys(t1?.anchors ?? {}), ['1']);
    assert.equal(t1?.comments.length, 1);
    assert.equal((await ctx2.store.readPendingEdits(doc.id)).length, 1, 'the tagged edit is still pending');
    // and the revise succeeds when retried
    const r = await ops.revise(ctx2, doc.id, { threads: { t1: { status: 'addressed', reply: 'Raised to 15.' } } });
    assert.equal(r.version, 2);
  });
});

describe('crash safety of submit (DS-9)', () => {
  async function drafted() {
    const o = await openWith('spec.md', TIMEOUTS);
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, 'request timeout'), body: 'A?' });
    await ops.saveDraft(o.ctx, o.doc.id, { kind: 'thread', type: 'comment', capture: textCapture(o.v1, 'Clients retry'), body: 'B?' });
    return o;
  }

  test('approve + Mark final killed before the review commit: no phantom approval or final', async () => {
    const { ctx, doc } = await drafted();
    crashOnce(ctx.store, 'saveReview');
    await assert.rejects(ops.submitReview(ctx, doc.id, { verdict: 'approved', body: 'ok', markFinal: true }), /simulated crash/);
    const ctx2 = await engineCtx(ws.root);
    await ctx2.store.recoverDoc(doc.id);
    const d = await ctx2.store.getDoc(doc.id);
    assert.equal(d?.final ?? null, null);
    assert.notEqual(d?.state, 'approved');
    assert.deepEqual(await ctx2.store.listReviews(doc.id), []);
    assert.deepEqual(await ctx2.store.listThreads(doc.id, { includeUncommitted: true }), []);
    assert.equal((await ctx2.store.getDrafts(doc.id)).items.length, 2, 'the drafts are still there');
    await assert.rejects(ops.finalize(ctx2, doc.id, {}), /final/i);
  });

  test('killed after the review commit: recovery consumes the drafts, so a resubmit duplicates nothing', async () => {
    const { ctx, doc } = await drafted();
    crashOnce(ctx.store, 'applyJournal');
    await assert.rejects(ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' }), /simulated crash/);
    const ctx2 = await engineCtx(ws.root);
    await ctx2.store.recoverDoc(doc.id);
    assert.deepEqual((await ctx2.store.getDrafts(doc.id)).items, []);
    assert.equal((await ctx2.store.getDoc(doc.id))?.lastReviewedVersion, 1);
    await assert.rejects(ops.submitReview(ctx2, doc.id, { verdict: 'comment', body: '' }), /nothing to submit/);
    assert.deepEqual((await ctx2.store.listThreads(doc.id)).map((t) => t.id), ['t1', 't2']);
  });

  test('recovery drops a doc.final whose review was never committed', async () => {
    const { ctx, doc } = await drafted();
    const d = /** @type {any} */ (await ctx.store.getDoc(doc.id));
    d.state = 'approved';
    d.final = { version: 1, review: 'rv1', at: '2026-01-01T00:00:00Z', by: 'Eric' };
    await ctx.store.saveDoc(d);
    const report = await ctx.store.recoverDoc(doc.id);
    assert.deepEqual(report.final, { review: 'rv1' });
    const after = await ctx.store.getDoc(doc.id);
    assert.deepEqual([after?.final ?? null, after?.state], [null, 'in_review']);
  });
});

describe('approve + Mark final of a version the reviewer did not see (DS-7)', () => {
  test('refused when another version was recorded since the reviewer opened the dialog', async () => {
    const { ctx, doc } = await openWith('spec.md', TIMEOUTS);
    editFile(ws.file('docs/spec.md'), 'for all calls.', 'for all calls, at our discretion.');
    await ops.recordReviewerVersion(ctx, doc.id, { summary: 'agent change' });
    await assert.rejects(ops.submitReview(ctx, doc.id, { verdict: 'approved', body: '', markFinal: true, expectHead: 1 }), ConflictError);
    const d = await ctx.store.getDoc(doc.id);
    assert.deepEqual([d?.final ?? null, d?.state === 'approved'], [null, false]);
    assert.deepEqual(await ctx.store.listReviews(doc.id), []);
    // a comment-only review of the older view is fine; an approval of the version shown is fine
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Looks fine.' });
    const c = await ops.submitReview(ctx, doc.id, { verdict: 'comment', body: '', expectHead: 1 });
    assert.equal(c.version, 2);
    const ok = await ops.submitReview(ctx, doc.id, { verdict: 'approved', body: '', markFinal: true, expectHead: 2 });
    assert.equal((await ctx.store.getDoc(doc.id))?.final?.review, ok.id);
  });
});

describe('legacy-charset files are never rewritten (DS-8)', () => {
  test('apply / edit refuse a windows-1252 file and leave its bytes alone', async () => {
    const html = Buffer.concat([
      Buffer.from('<!doctype html><html><head><meta charset="windows-1252"><title>Menu</title></head><body>\n<p>Caf'),
      Buffer.from([0xe9]),
      Buffer.from(' cr'),
      Buffer.from([0xe8]),
      Buffer.from('me '),
      Buffer.from([0xa3]),
      Buffer.from('</p>\n<p>Open 9 to 5.</p>\n</body></html>\n'),
    ]);
    const { ctx, doc, v1 } = await openWith('menu.html', html);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'suggestion', capture: textCapture(v1, '9 to 5'), body: '', suggestion: { mode: 'text', new: '8 to 6' } });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    await assert.rejects(ops.applySuggestions(ctx, doc.id, ['t1']), (err) => err instanceof RefusedError && /not valid UTF-8/.test(err.message));
    await assert.rejects(ops.taggedEdit(ctx, doc.id, { threads: ['t1'], oldString: '9 to 5', newString: '8 to 6' }), RefusedError);
    assert.ok(fs.readFileSync(ws.file('docs/menu.html')).equals(html), 'bytes untouched');
  });
});

describe('re-anchoring never moves onto another copy of the same text (DS-2)', () => {
  const REP = 'Requires approval from an administrator before use.';
  const SPEC = `# Spec\n\n## Export\n\nUsers can export reports as CSV.\n\n${REP}\n\n## Delete\n\nUsers can delete their own reports.\n\n${REP}\n\n## Share\n\nUsers can share a report link.\n`;

  for (const variant of ['actionable', 'resolved with a decision']) {
    test(`deleting the commented copy's section (${variant}): t1 does not jump to the Export copy`, async () => {
      const { ctx, doc, v1 } = await openWith('spec.md', SPEC);
      await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, REP, 1), body: 'Which admin role, for deletion?' });
      const del = v1.outline.find((/** @type {any} */ o) => o.text === 'Delete');
      await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: { kind: 'section', headingSrid: del.srid }, body: 'Drop the Delete section.' });
      await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
      await ops.feedback(ctx, doc.id, {});
      if (variant !== 'actionable') await ops.resolveThread(ctx, doc.id, 't1', { decision: 'Deletion needs the workspace-owner role' });
      const t = ws.read('docs/spec.md');
      ws.write('docs/spec.md', t.slice(0, t.indexOf('## Delete')) + t.slice(t.indexOf('## Share')));
      /** @type {Record<string, any>} */
      const threads = { t2: { status: 'addressed', reply: 'Removed.' } };
      if (variant === 'actionable') threads.t1 = { status: 'addressed', reply: 'Moot: section removed.' };
      const r = await ops.revise(ctx, doc.id, { threads });
      assert.equal(r.version, 2);
      const a2 = (await ctx.store.getThread(doc.id, 't1'))?.anchors['2'];
      assert.ok(a2);
      assert.notDeepEqual(a2.section, ['Spec', 'Export'], `t1 moved to the Export copy (${a2.state} L${a2.src.startLine})`);
      assert.notEqual(a2.src.text, REP);
      assert.ok(['orphaned', 'edited'].includes(a2.state), a2.state);

      // a later version does not re-attach the orphan / lastKnown to the surviving copy either
      editFile(ws.file('docs/spec.md'), 'Users can share a report link.', 'Users can share a read-only report link.');
      await ops.recordReviewerVersion(ctx, doc.id, { summary: 'v3' });
      const a3 = (await ctx.store.getThread(doc.id, 't1'))?.anchors['3'];
      assert.notEqual(a3?.src.text, REP);
    });
  }

  test('a copy moved to a new place is still followed', async () => {
    const { ctx, doc, v1 } = await openWith('spec.md', SPEC);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, REP, 1), body: 'Which role?' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    // move the Delete section (with its copy of the sentence) after Share
    const t = ws.read('docs/spec.md');
    const delSec = t.slice(t.indexOf('## Delete'), t.indexOf('## Share'));
    ws.write('docs/spec.md', `${t.slice(0, t.indexOf('## Delete')) + t.slice(t.indexOf('## Share'))}\n${delSec.trimEnd()}\n`);
    await ops.recordReviewerVersion(ctx, doc.id, { summary: 'moved' });
    const a2 = (await ctx.store.getThread(doc.id, 't1'))?.anchors['2'];
    assert.equal(a2?.state, 'moved');
    assert.deepEqual(a2?.section, ['Spec', 'Delete']);
  });
});
