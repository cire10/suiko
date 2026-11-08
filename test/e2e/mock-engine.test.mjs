// @ts-check
// Unit tests (node:test) for the e2e mock engine's parity with the daemon on batched edits and rich replies (the
// shapes and errors of src/core/review/ops/submit.js, drafts.js, attachments.js and daemon api.js): a review's
// `instant` and `edits`, `apply` of planned threads, reply drafts' `use`, the agent's reply attachments, and the
// version sizes in DocState. The UI e2e specs rely on these answers.  node --test test/e2e/mock-engine.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScenario, CHART_HTML, LIFETIMES_PNG } from './mock-data.mjs';

/** The kitchen-sink doc of a scenario. @param {'round2'|'rich'} scenario */
const ks = (scenario) => buildScenario(scenario)[0];

/** @param {() => unknown} fn @param {number} status @param {RegExp} [message] */
function rejects(fn, status, message) {
  assert.throws(fn, (/** @type {any} */ err) => {
    assert.equal(err.status, status, String(err.message));
    if (message) assert.match(String(err.message), message);
    return true;
  });
}

test('V1: a one-item send (instant: true) leaves "since your last review"; a review from the Send dialog moves it; else 422', () => {
  const d = ks('round2');
  assert.equal(d.doc.lastReviewedVersion, 1);
  rejects(() => d.submitReview({ verdict: 'comment', body: 'x', instant: 'yes' }), 422, /instant must be a boolean/);
  const draft = d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'one', version: 2 });
  const review = d.submitReview({ verdict: 'comment', body: '', draftIds: [draft.id], reviewedVersion: 2, edits: 'now', instant: true });
  assert.equal(review.instant, true);
  assert.equal(d.doc.lastReviewedVersion, 1, 'v2 is still new to the reviewer');
  const dialog = d.submitReview({ verdict: 'comment', body: 'the whole review', reviewedVersion: 2, instant: false });
  assert.equal('instant' in dialog, false);
  assert.equal(d.doc.lastReviewedVersion, 2);
  // an approval is never instant
  assert.equal('instant' in d.submitReview({ verdict: 'approved', body: '', reviewedVersion: 2, instant: true }), false);
});

test('reviews carry edits (now | batch, else 422); an approval is always now', () => {
  const d = ks('round2');
  d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'a', version: 2 });
  rejects(() => d.submitReview({ verdict: 'comment', edits: 'later' }), 422, /edits must be one of now, batch/);
  assert.equal(d.submitReview({ verdict: 'comment', edits: 'batch' }).edits, 'batch');
  assert.equal(d.submitReview({ verdict: 'comment', body: 'b' }).edits, 'now', 'absent: now');
  assert.equal(d.submitReview({ verdict: 'approved', edits: 'batch', reviewedVersion: 2 }).edits, 'now');
});

test('apply: planned threads only (409), known ids (404), a list of ids (422), never with an approval or a resolve of it (422)', () => {
  const d = ks('rich');
  rejects(() => d.submitReview({ verdict: 'comment', draftIds: [], apply: 't3' }), 422, /apply must be an array of thread ids/);
  rejects(() => d.submitReview({ verdict: 'comment', draftIds: [], apply: ['x1'] }), 422);
  rejects(() => d.submitReview({ verdict: 'approved', draftIds: [], apply: ['t3'], reviewedVersion: 2 }), 422, /cannot come with an approval/);
  rejects(() => d.submitReview({ verdict: 'comment', draftIds: [], apply: ['t99'] }), 404, /t99 not found/);
  rejects(() => d.submitReview({ verdict: 'comment', draftIds: [], apply: ['t2'] }), 409, /t2 is answered, not planned/);
  const resolveDraft = d.saveDraft({ kind: 'resolve', thread: 't3' });
  rejects(() => d.submitReview({ verdict: 'comment', draftIds: [resolveDraft.id], apply: ['t3'] }), 422, /also resolved by this review/);
  d.deleteDraft(resolveDraft.id);
  // nothing changed by the refusals
  assert.equal(d.thread('t3').status, 'planned');

  // a pending draft stays a draft when the Apply sends draftIds: []
  const pending = d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'later', version: 2 });
  const before = d.thread('t8').comments.length;
  const review = d.submitReview({ verdict: 'comment', body: '', draftIds: [], apply: ['t8', 't3', 't3'], edits: 'now' });
  assert.deepEqual(review.apply, ['t3', 't8']);
  assert.deepEqual(review.newThreads, []);
  assert.deepEqual(d.drafts.items.map((/** @type {any} */ x) => x.id), [pending.id]);
  for (const id of ['t3', 't8']) {
    const t = d.thread(id);
    assert.equal(t.status, 'open');
    assert.deepEqual(t.comments.at(-1), { ...t.comments.at(-1), body: 'Apply this change.', apply: true, by: { kind: 'human', name: 'Eric' } });
  }
  assert.equal(d.thread('t8').comments.length, before + 1);
});

test('an Apply without draftIds sends no drafts (like the daemon); a review without draftIds and without apply sends them all', () => {
  const d = ks('rich');
  const pending = d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'half-written', version: 2 });
  const review = d.submitReview({ verdict: 'comment', body: '', apply: ['t3'] });
  assert.deepEqual(review.apply, ['t3']);
  assert.deepEqual(review.newThreads, [], 'the pending draft did not go out with the Apply');
  assert.deepEqual(d.drafts.items.map((/** @type {any} */ x) => x.id), [pending.id]);
  const all = d.submitReview({ verdict: 'comment', body: '' });
  assert.equal(all.newThreads.length, 1, 'a plain review still sends every draft');
  assert.deepEqual(d.drafts.items, []);
});

test('reply drafts keep use: a7.ext or attachments/a7.ext, attachments of their thread only (422), at most 6', () => {
  const d = ks('rich');
  // t7's answer carries attachments/a1.png and attachments/a2.html
  const draft = d.saveDraft({ kind: 'reply', thread: 't7', body: 'Put this in the doc.', use: ['a2.html'] });
  assert.deepEqual(draft.use, ['attachments/a2.html']);
  rejects(() => d.saveDraft({ kind: 'reply', thread: 't3', body: 'x', use: ['attachments/a2.html'] }), 422, /not an attachment of t3/);
  rejects(() => d.saveDraft({ kind: 'reply', thread: 't7', body: 'x', use: 'a2.html' }), 422);
  rejects(() => d.patchDraft(draft.id, { use: ['attachments/a9.png'] }), 422, /not an attachment of t7/);
  // a patch without use keeps it
  assert.deepEqual(d.patchDraft(draft.id, { body: 'Use this one.' }).use, ['attachments/a2.html']);
  // sent: the comment keeps it; a use reply reopens a resolved thread
  d.resolve('t7');
  const review = d.submitReview({ verdict: 'comment', body: '', draftIds: [draft.id] });
  assert.deepEqual(d.thread('t7').comments.at(-1).use, ['attachments/a2.html']);
  assert.equal(d.thread('t7').status, 'open');
  assert.deepEqual(review.reopened, ['t7']);
});

test('the agent\'s attachments: stored as attachments/aN.<ext> with their name and kind; versions carry lines and textChars', () => {
  const docs = buildScenario('rich');
  const d = docs[0];
  const t7 = d.thread('t7');
  assert.deepEqual(t7.comments.at(-1).attachments, [
    { path: 'attachments/a1.png', name: 'lifetimes.png', kind: 'image' },
    { path: 'attachments/a2.html', name: 'chart.html', kind: 'html' },
  ]);
  assert.equal(d.attachments.get('attachments/a1.png'), `data:image/png;base64,${LIFETIMES_PNG.toString('base64')}`);
  assert.equal(d.attachments.get('attachments/a2.html'), `data:text/html;base64,${Buffer.from(CHART_HTML).toString('base64')}`);
  assert.deepEqual(d.addAgentAttachment('notes.htm', '<p>x</p>'), { path: 'attachments/a3.html', name: 'notes.htm', kind: 'html' });
  rejects(() => d.addAgentAttachment('run.sh', 'echo'), 422);
  // a planned thread is drawn as "Will change" in the doc (state 'planned', like the engine's threadState), not as an
  // open thread; the others keep theirs
  const targets = d.domTargets(2).threads;
  /** @param {string} id */
  const stateOf = (id) => targets.find((/** @type {any} */ x) => x.id === id)?.state;
  assert.equal(stateOf('t3'), 'planned');
  assert.equal(stateOf('t8'), 'planned');
  assert.equal(stateOf('t1'), 'addressed');
  assert.equal(stateOf('t6'), 'needs_input');
  // a declined thread (t4, still in place in v1) is drawn as declined ("Claude didn't change it"), like the engine
  assert.equal(d.domTargets(1).threads.find((/** @type {any} */ x) => x.id === 't4')?.state, 'declined');
  const st = d.docState();
  assert.ok(st.versions.every((/** @type {any} */ v) => Number.isInteger(v.lines) && Number.isInteger(v.textChars)));
  assert.ok(st.versions.at(-1).textChars < 20000, 'kitchen-sink is short');
  const long = docs.find((x) => x.id === 'long-spec');
  assert.ok(long && long.docState().versions[0].textChars > 20000, 'long-spec is long');
});
