// @ts-check
// Batched edits and rich replies on a code review (doc kind 'code', a real scripted repository): the EDITS line
// ("do not edit the files yet"), `planned` replies posted by a replies-only round with attachments, the reviewer's
// "Use in doc" reply and Apply in one review (APPLY line and label, the planned reply quoted, the `use:` line in its
// code form), then the round that records the change and the usual Verify flow.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/ops.js';
import { formatPacket, formatReviseReport } from '../../src/core/review/packet.js';
import { setClock } from '../../src/core/util/time.js';
import { designRepo, lineDraft, packetOf } from '../helpers/git-repo.js';

/** @type {() => void} */
let restoreClock;
beforeEach(() => {
  let t = Date.parse('2026-11-08T10:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
});
afterEach(() => restoreClock());

/**
 * @param {string} text
 * @param {string} tid
 */
function itemOf(text, tid) {
  return text.split('\n\n').find((b) => b.startsWith(`[${tid}]`)) ?? '';
}

test('code review: EDITS batch, planned replies with attachments, Use in doc + Apply, then the recorded round', async () => {
  const r = await designRepo();
  try {
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: {} });
    const id = doc.id;
    await lineDraft(ctx, id, { file: 'src/auth/refresh.js', lines: [41, 44], body: 'Allow reuse within 30 s before revoking the family.' });
    const rv1 = await ops.submitReview(ctx, id, { verdict: 'changes_requested', edits: 'batch', by: 'Eric' });
    assert.equal(rv1.edits, 'batch');
    let { text } = await packetOf(ctx, id);
    assert.ok(
      text.split('\n').includes('EDITS: batch. Answer every thread now. For a change you agree to make, do not edit the files yet: reply with status "planned" and say exactly what you will change; questions get "answered". The edits come later in one APPLY packet.'),
      text,
    );
    assert.match(text, new RegExp(`^NEXT: replies only, no edits yet -> suiko revise ${id} --replies - \\(JSON, one entry per thread\\) -> suiko wait ${id} \\(background\\)$`, 'm'));
    await ops.feedback(ctx, id, {}); // delivered

    // the agent plans the change and attaches a sketch: a replies-only round (the working tree is unchanged)
    const sketch = path.join(r.base, 'grace-window.svg');
    fs.writeFileSync(sketch, '<svg xmlns="http://www.w3.org/2000/svg"><text y="12">reuse window</text></svg>');
    const planned = await ops.revise(ctx, id, { threads: { t1: { status: 'planned', reply: 'I will allow reuse within 30 s (a grace window) before revoking.', attachments: [sketch] } } });
    assert.equal(planned.repliesOnly, true, formatReviseReport(planned));
    let t1 = /** @type {any} */ (await ctx.store.getThread(id, 't1'));
    assert.equal(t1.status, 'planned');
    assert.deepEqual(t1.comments.at(-1).attachments, [{ path: 'attachments/a1.svg', name: 'grace-window.svg', kind: 'image' }]);

    // the reviewer asks for the sketch in the change too, and applies the plan (one review)
    const d = await ops.saveDraft(ctx, id, { kind: 'reply', thread: 't1', body: 'Put this in the doc.', use: ['attachments/a1.svg'] });
    const rv2 = await ops.submitReview(ctx, id, { verdict: 'comment', draftIds: [d.id], apply: ['t1'], edits: 'batch', by: 'Eric' });
    assert.deepEqual(rv2.apply, ['t1']);
    const built = await packetOf(ctx, id);
    text = built.text;
    assert.equal(formatPacket(built.packet), text);
    const lines = text.split('\n');
    assert.ok(lines.includes('APPLY: make every planned change below in one pass, then record ONE version as NEXT says (status addressed).'), text);
    assert.ok(!lines.some((l) => l.startsWith('EDITS:')), 'only the applied thread to act on');
    assert.match(text, /^NEXT: edit the files -> suiko revise /m, 'the APPLY round edits now');
    const item = itemOf(text, 't1');
    assert.match(item, /^\[t1\] APPLY · comment · src\/auth\/refresh\.js:L41-44/);
    assert.match(item, /^ {2}claude \(v1, planned\): I will allow reuse within 30 s/m);
    const abs = ctx.store.attachmentPath(id, 'attachments/a1.svg');
    assert.ok(item.split('\n').includes(`  use: ${abs} (grace-window.svg) — put this into the file at this thread's place (copy it into the repo or inline it)`), item);
    assert.doesNotMatch(item, /Apply this change\./);

    // the agent makes the change and records the round: addressed, then Verify as usual
    const file = path.join(r.root, 'src', 'auth', 'refresh.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('if (stored.used) {', 'if (stored.used && !withinGrace(stored)) {'));
    const round = await ops.revise(ctx, id, { threads: { t1: { status: 'addressed', reply: 'Reuse is allowed within 30 s.', at: 'src/auth/refresh.js:L41' } } });
    assert.equal(round.version, 2);
    t1 = /** @type {any} */ (await ctx.store.getThread(id, 't1'));
    assert.equal(t1.status, 'addressed');
  } finally {
    await r.cleanup();
  }
});
