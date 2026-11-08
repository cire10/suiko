// @ts-check
// The DomTarget state of a thread (ops/changes.js threadState): the marks over the doc say whose turn the thread is,
// like its card's chip. A thread the agent declined is 'declined' ("Claude didn't change it", amber), not the green
// "check it" of an answered or changed thread; once the reviewer answers it, it is with the agent again ('open').

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/index.js';
import { setClock } from '../../src/core/util/time.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;

beforeEach(async () => {
  let t = Date.parse('2026-11-08T10:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
afterEach(async () => {
  restoreClock();
  await ws.cleanup();
});

test('declined threads are drawn as declined, answered ones as "check it"; a reviewer reply puts it back with the agent', async () => {
  const ctx = await engineCtx(ws.root);
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Prototype the issuer.'), body: 'Drop this step?' });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Ship rotation behind a flag.'), body: 'Name the flag.' });
  await ops.submitReview(ctx, DOC, { verdict: 'comment' });
  /** @param {string} id */
  const stateOf = async (id) => (await ops.domTargets(ctx, DOC, 1)).threads.find((/** @type {any} */ t) => t.id === id)?.state;
  assert.equal(await stateOf('t1'), 'open', 'sent: with the agent');

  await ops.reply(ctx, DOC, 't1', { body: 'The prototype stays: it is the first milestone.', status: 'declined' });
  await ops.reply(ctx, DOC, 't2', { body: 'The flag is rotation_v2.', status: 'answered' });
  assert.equal(await stateOf('t1'), 'declined');
  assert.equal(await stateOf('t2'), 'addressed', 'answered: for the reviewer to check');

  // the reviewer answers the decline: the thread is with the agent again
  await ops.saveDraft(ctx, DOC, { kind: 'reply', thread: 't1', body: 'It is not a milestone; drop it.' });
  await ops.submitReview(ctx, DOC, { verdict: 'comment' });
  assert.equal(await stateOf('t1'), 'open');
});
