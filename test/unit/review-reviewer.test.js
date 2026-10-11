// @ts-check
// Reviewer-side ops (design 10.2, 11; BUILD_AMENDMENTS 3.4, 4.5, 6): capture preview + "Widen to block", drafts
// (save / patch / delete, events), "Send now" (submit one draft), locks (Mark agreed / Unlock / Relock), "Move
// here", DOM targets for a version and for the live working copy, changed images (changes.assets + image
// mini-diff), "Record as my revision", "Apply now", attachments, doc state / status / log / source lines,
// close and reopen, and the HTML fixture end to end.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SSE } from '../../src/shared/protocol.js';
import { ConflictError, NotFoundError, UsageError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/index.js';
import { TINY_PNG, editFile, elementCapture, engineCtx, findSrid, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
const FILE = 'docs/kitchen-sink.md';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: ['kitchen-sink.md', 'img/arch.png', 'app-spec.html'] });
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

describe('drafts and submit', () => {
  test('preview, widen, save / patch / delete, send one draft now', async () => {
    const { ctx, v1 } = await opened();
    const cap = textCapture(v1, 'rotated on every use');
    const narrow = await ops.resolveCapture(ctx, DOC, { capture: cap });
    assert.equal(narrow.anchor.src.text, 'rotated on every use');
    const wide = await ops.resolveCapture(ctx, DOC, { capture: cap, widen: true });
    assert.equal(wide.anchor.kind, 'element');
    assert.deepEqual([wide.anchor.src.startLine, wide.anchor.src.endLine], [51, 52]);

    const d1 = await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: cap, body: 'first' });
    const d2 = await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'General question?' });
    assert.deepEqual([d1.id, d2.id], ['d1', 'd2']);
    const patched = await ops.updateDraft(ctx, DOC, 'd1', { body: 'patched', severity: 'blocking' });
    assert.deepEqual(patched.kind === 'thread' && [patched.body, patched.severity, patched.anchor.src.text], ['patched', 'blocking', 'rotated on every use']);
    await assert.rejects(ops.updateDraft(ctx, DOC, 'd9', { body: 'x' }), NotFoundError);
    await assert.rejects(ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'bogus', capture: cap, body: 'x' }), UsageError);
    assert.equal((await ops.deleteDraft(ctx, DOC, 'd2')).deleted, true);
    assert.equal((await ops.deleteDraft(ctx, DOC, 'd2')).deleted, false);
    const events = (await ctx.store.readEvents(DOC, 0)).filter((e) => e.type === SSE.DRAFTS_CHANGED);
    assert.ok(events.length >= 4, 'every draft change is an event');

    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'later' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'comment', body: '', draftIds: ['d1'] });
    assert.deepEqual(rv.newThreads, ['t1']);
    assert.deepEqual((await ctx.store.getDrafts(DOC)).items.map((d) => d.id), ['d3'], 'the other draft stays');
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'comment', body: '', draftIds: ['d1'] }), NotFoundError);
    await assert.rejects(ops.submitReview(ctx, DOC, { verdict: 'nope' }), /invalid verdict/);
  });

  test('a draft made on an older version is carried forward on submit', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Load test the issuer'), body: 'which load?' });
    editFile(ws.file(FILE), '## 1 Goals\n', '## 1 Goals\n\nNew intro.\n');
    await ops.recordReviewerVersion(ctx, DOC, { summary: 'intro' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
    const t1 = await ctx.store.getThread(DOC, rv.newThreads[0]);
    assert.deepEqual(Object.keys(t1?.anchors ?? {}), ['1', '2']);
    assert.equal(t1?.anchors['2'].state, 'moved');
    assert.equal(t1?.anchors['2'].src.startLine, 71);
  });
});

describe('locks and threads', () => {
  test('Mark agreed / Unlock / Relock and Move here', async () => {
    const { ctx, v1 } = await opened();
    const sec = findSrid(v1, (n) => n.t === 'h2' && n.h?.text === '4 Rollout checklist');
    const lock = await ops.addLock(ctx, DOC, { capture: { kind: 'section', headingSrid: sec }, note: 'agreed with infra' });
    assert.deepEqual([lock.id, lock.active, lock.note, lock.anchors['1'].src.startLine], ['L1', true, 'agreed with infra', 66]);
    await assert.rejects(ops.addLock(ctx, DOC, { capture: { kind: 'doc' } }), UsageError);
    assert.equal((await ops.removeLock(ctx, DOC, 'L1')).lock.active, false);
    assert.equal((await ops.relock(ctx, DOC, 'L1')).active, true);
    await assert.rejects(ops.removeLock(ctx, DOC, 'L5'), NotFoundError);

    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'x' });
    await ops.submitReview(ctx, DOC, { verdict: 'comment', body: '' });
    const moved = await ops.moveThread(ctx, DOC, 't1', { capture: textCapture(v1, 'Ship rotation behind a flag.') });
    assert.deepEqual([moved.anchors['1'].src.text, moved.anchors['1'].mappedBy], ['Ship rotation behind a flag.', 'override']);
    assert.equal(moved.override?.by, 'human');

    // resolve with a decision, reopen
    await ops.resolveThread(ctx, DOC, 't1', { decision: 'ship behind a flag' });
    let t1 = await ctx.store.getThread(DOC, 't1');
    assert.deepEqual([t1?.status, t1?.decision?.id, t1?.decision?.text], ['resolved', 'D1', 'ship behind a flag']);
    await ops.unresolveThread(ctx, DOC, 't1', {});
    t1 = await ctx.store.getThread(DOC, 't1');
    assert.equal(t1?.status, 'open');
  });

  test('DOM targets for a version and for the live working copy', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'x' });
    await ops.addLock(ctx, DOC, { capture: textCapture(v1, 'the gateway never stores tokens') });
    let targets = await ops.domTargets(ctx, DOC, 1);
    assert.deepEqual(targets.drafts.map((d) => [d.id, d.state, d.quote]), [['d1', 'draft', 'Prototype the issuer.']]);
    assert.deepEqual(targets.locks.map((l) => [l.id, l.state]), [['L1', 'lock']]);
    assert.ok(targets.outline.length > 5);
    await ops.submitReview(ctx, DOC, { verdict: 'comment', body: '' });
    targets = await ops.domTargets(ctx, DOC, 'v1');
    assert.deepEqual(targets.threads.map((t) => [t.id, t.num, t.state, t.kind, t.quote]), [['t1', 1, 'open', 'text', 'Prototype the issuer.']]);
    const srid1 = targets.threads[0].srid;

    editFile(ws.file(FILE), '## 1 Goals\n', '## 1 Goals\n\nA new paragraph.\n');
    const live = await ops.domTargets(ctx, DOC, 'live');
    assert.equal(live.version, 'live');
    assert.equal(live.threads[0].quote, 'Prototype the issuer.');
    assert.notEqual(live.threads[0].srid, srid1, 'srids come from the live render');
    assert.deepEqual(live.drafts, []);
  });

  test('DOM targets carry drafts written on an older version forward; a draft whose text is gone is not painted', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Load test the issuer'), body: 'which load?' });
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'gone in v2' });
    editFile(ws.file(FILE), '## 1 Goals\n', '## 1 Goals\n\nNew intro.\n');
    editFile(ws.file(FILE), 'Prototype the issuer.', 'Build the issuer.');
    await ops.recordReviewerVersion(ctx, DOC, { summary: 'intro' });
    const v2 = await ctx.render(await ctx.store.getDoc(DOC), 2);
    const t2 = await ops.domTargets(ctx, DOC, 2);
    assert.deepEqual(t2.drafts.map((d) => [d.id, d.state, d.quote]), [['d1', 'draft', 'Load test the issuer']]);
    const v1Target = (await ops.domTargets(ctx, DOC, 1)).drafts.find((d) => d.id === 'd1');
    assert.equal(t2.drafts[0].srid, textCapture(v2, 'Load test the issuer').startSrid, 'painted at its v2 element');
    assert.notEqual(t2.drafts[0].srid, v1Target?.srid);
    // memoised: the same result again
    assert.deepEqual((await ops.domTargets(ctx, DOC, 2)).drafts, t2.drafts);
    // on v1 both drafts are painted with their own anchors; a draft from a later version never paints on an older one
    assert.deepEqual((await ops.domTargets(ctx, DOC, 1)).drafts.map((d) => d.id), ['d1', 'd2']);
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v2, 'New intro.'), body: 'on v2' });
    assert.deepEqual((await ops.domTargets(ctx, DOC, 1)).drafts.map((d) => d.id), ['d1', 'd2']);
    assert.deepEqual((await ops.domTargets(ctx, DOC, 2)).drafts.map((d) => d.id), ['d1', 'd3']);
  });
});

describe('changed images', () => {
  test('a replaced image is a change: changes.assets, thread link and an image mini-diff', async () => {
    const { ctx, v1 } = await opened();
    const img = findSrid(v1, (n) => n.t === 'img');
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: elementCapture(v1, img), body: 'Redraw the arrows.' });
    await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, DOC, {});
    fs.writeFileSync(ws.file('docs/img/arch.png'), Buffer.from(TINY_PNG.split(',')[1], 'base64'));
    const working = await ops.changes(ctx, DOC, { from: 1, to: 'live' });
    assert.deepEqual(working.assets.map((a) => [a.path, a.fromUrl, a.toUrl, a.threads]), [['docs/img/arch.png', 'v1/docs/img/arch.png', 'live/docs/img/arch.png', ['t1']]]);

    const r = await ops.revise(ctx, DOC, { threads: { t1: { status: 'addressed', reply: 'Redrew the diagram.' } } });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.equal(r.version, 2);
    assert.deepEqual(r.stats.hunks, 0);
    assert.deepEqual(r.assets, [{ path: 'docs/img/arch.png', threads: ['t1'] }]);
    assert.deepEqual(r.guards.warnings.filter((w) => w.code === 'addressed'), [], 'the asset change links t1');
    const ch = await ops.changes(ctx, DOC, { from: 1, to: 2 });
    assert.equal(ch.assets.length, 1);
    assert.equal(ch.assets[0].srids.length, 1);
    assert.deepEqual(ch.threadLinks, { t1: ['asset:docs/img/arch.png'] });
    const mini = await ops.threadMiniDiff(ctx, DOC, 't1');
    assert.deepEqual(mini, { kind: 'image', version: 2, from: 1, path: 'docs/img/arch.png', beforeUrl: 'v1/docs/img/arch.png', afterUrl: 'v2/docs/img/arch.png' });
    assert.match(ops.formatDiffStat(ch), /assets: docs\/img\/arch\.png changed/);
  });
});

describe('reviewer versions', () => {
  test('Record as my revision and Apply now', async () => {
    const { ctx, v1 } = await opened();
    await assert.rejects(ops.recordReviewerVersion(ctx, DOC, {}), /nothing to record/);
    await ops.saveDraft(ctx, DOC, {
      kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'), body: '',
      suggestion: { mode: 'text', new: 'Prototype the issuer in staging.' },
    });
    await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });

    editFile(ws.file(FILE), '3. Remove the legacy session store.', '3. Remove the legacy session store (Q4).');
    await assert.rejects(ops.applySuggestionAsReviewer(ctx, DOC, 't1', {}), ConflictError);
    const m2 = await ops.recordReviewerVersion(ctx, DOC, { summary: 'my wording', by: 'Eric' });
    assert.deepEqual([m2.v, m2.author.kind, m2.author.name, m2.capturedBy, m2.summary], [2, 'human', 'Eric', 'ui-record', 'my wording']);

    const m3 = await ops.applySuggestionAsReviewer(ctx, DOC, 't1', { by: 'Eric' });
    assert.deepEqual([m3.v, m3.capturedBy, m3.summary], [3, 'ui-apply', 'Applied suggestion t1']);
    assert.match(ws.read(FILE), /^1\. Prototype the issuer in staging\.$/m);
    const t1 = await ctx.store.getThread(DOC, 't1');
    assert.deepEqual([t1?.status, t1?.suggestion?.status, t1?.suggestion?.appliedIn, t1?.resolvedIn], ['resolved', 'applied', 3, 3]);
    await assert.rejects(ops.applySuggestionAsReviewer(ctx, DOC, 't1', {}), /already applied in v3/);
  });
});

describe('doc state, status, log, source, attachments, close', () => {
  test('read views and session lifecycle', async () => {
    const { ctx, v1 } = await opened();
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'x' });
    await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: 'summary' });

    const st = await ops.docState(ctx, DOC);
    assert.deepEqual([st.ws, st.doc.id, st.versions.length, st.threads.length, st.reviews.length, st.working.dirty], [ctx.wsId, DOC, 1, 1, 1, false]);
    const status = await ops.status(ctx, DOC);
    assert.equal(status.docs.length, 1);
    const statusText = ops.formatStatus(status);
    assert.match(statusText, /^kitchen-sink {2}docs\/kitchen-sink\.md {2}head v1 /m);
    assert.match(statusText, /undelivered reviews: rv1/);
    assert.match(statusText, /working copy: clean/);

    const src = await ops.sourceLines(ctx, DOC, { version: 1, from: 7, to: 7 });
    assert.deepEqual(src, { v: 1, startLine: 7, lines: ['# Token Service Implementation Spec'], total: src.total });
    editFile(ws.file(FILE), '# Token Service Implementation Spec', '# Token Service Spec');
    const live = await ops.sourceLines(ctx, DOC, { version: 'live', from: 7, to: 7 });
    assert.deepEqual(live.lines, ['# Token Service Spec']);
    assert.match(ops.formatStatus(await ops.status(ctx, DOC)), /working copy: dirty/);

    const shown = await ops.show(ctx, DOC, { version: 1, lines: 'L7-L8' });
    assert.deepEqual(shown.kind === 'source' && shown.lines, ['# Token Service Implementation Spec', '']);

    const logged = await ops.log(ctx, DOC);
    assert.match(ops.formatLog(logged), /^v1 {2}agent claude .* initial draft/m);

    await assert.rejects(ops.saveAttachment(ctx, DOC, { dataUrl: 'data:text/plain;base64,aGk=' }), UsageError);
    const a = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
    assert.equal(a.path, 'attachments/a1.png');
    assert.ok(fs.existsSync(a.abs));

    const listed = await ops.listDocsAcrossWorkspaces(ctx);
    const mine = listed.find((d) => d.id === DOC && d.root === ws.root);
    assert.ok(mine, JSON.stringify(listed));
    assert.equal(mine.undelivered, 1);

    const closed = await ops.closeSession(ctx, DOC);
    assert.equal(closed.state, 'closed');
    assert.equal((await ctx.store.readEvents(DOC, 0)).filter((e) => e.type === SSE.SESSION_CLOSED).length, 1);
    const reopened = await ops.openDoc(ctx, { path: FILE });
    assert.deepEqual([reopened.created, reopened.doc.state, reopened.workingDirty], [false, 'in_review', true]);
  });
});

describe('HTML spec', () => {
  test('open, element comment, revise and re-anchor on app-spec.html', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openDoc(ctx, { path: 'docs/app-spec.html' });
    assert.equal(doc.format, 'html');
    const v1 = await ctx.render(doc, 1);
    const table = findSrid(v1, (n) => n.t === 'table');
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: elementCapture(v1, table), body: 'Add a column for owners.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    const packet = await ops.feedback(ctx, doc.id, {});
    assert.equal(packet.threads.length, 1);
    assert.equal(packet.threads[0].target, 'element');
    assert.match(String(packet.threads[0].src), /<table/);

    // a new paragraph on its own line above the table: the table itself is untouched
    const html = ws.read('docs/app-spec.html');
    const at = html.lastIndexOf('\n', html.indexOf('<table')) + 1;
    ws.write('docs/app-spec.html', `${html.slice(0, at)}  <p>Owners are listed per row.</p>\n${html.slice(at)}`);
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'answered', reply: 'Owners are listed per row instead.' } }, other: [{ at: `L${html.slice(0, at).split('\n').length}`, why: 'owner note' }] });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    const t1 = await ctx.store.getThread(doc.id, 't1');
    assert.equal(t1?.anchors['2'].state, 'moved', JSON.stringify(t1?.anchors['2']));
    assert.equal(t1?.anchors['2'].element?.tag, 'table');
    assert.equal(r.hunks.length, 1);
    // an insertion right at the anchor's first line links by overlap (design 8.3: anchor lines widened by 1), but
    // the untouched table keeps its place (amendments 4.2: a link alone never moves untouched text)
    assert.deepEqual([r.hunks[0].threads, r.hunks[0].linkedBy, r.hunks[0].other], [['t1'], 'overlap', 'owner note']);
  });
});
