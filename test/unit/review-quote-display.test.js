// @ts-check
// A selection cut mid-word ('otated on every u') is shown widened to whole words everywhere a quote is printed: the
// composer preview, the packet's DRAFTS lines, a thread's `on:` and the decisions.md context (also for a recorded
// decision). The stored anchor keeps the exact selection. (Bug report 2026-10-11, item 4.)

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

test('mid-word selections read as whole words in the preview, drafts, on: and decisions.md', async () => {
  const ctx = await engineCtx(ws.root);
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  const capture = textCapture(v1, 'otated on every u');

  const preview = await ops.resolveCapture(ctx, DOC, { capture });
  assert.match(preview.preview.text, /"rotated on every use"$/);

  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture, body: 'Use a grace window.' });
  let peeked = '';
  await ops.feedback(ctx, DOC, { peek: true, includeDrafts: true, write: (t) => { peeked = t; } });
  assert.match(peeked, /on: "rotated on every use"|"rotated on every use"/, peeked);
  assert.doesNotMatch(peeked, /"otated/, peeked);

  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  const w = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
  assert.match(w.text, /^ {2}on: "rotated on every use"$/m);
  const stored = await ctx.store.getThread(DOC, 't1');
  assert.equal(stored?.anchors['1'].quote?.exact, 'otated on every u', 'the anchor keeps the exact selection');

  editFile(ws.file('docs/kitchen-sink.md'), 'rotated on every use', 'rotated on every use (30 s grace window)');
  await ops.revise(ctx, DOC, { summary: 'grace', threads: { t1: { status: 'addressed', reply: 'Added.' } } });
  await ops.resolveThread(ctx, DOC, 't1', { decision: '30 s grace window' });
  await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true });
  await ops.finalize(ctx, DOC, { decisions: true });
  const md = ws.read('docs/kitchen-sink.decisions.md');
  assert.match(md, /^ {2}> rotated on every use/m, md);
  assert.doesNotMatch(md, /^ {2}> otated/m, md);
});
