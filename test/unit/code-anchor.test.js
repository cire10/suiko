// @ts-check
// Anchoring in file space across rounds (design 4.7) on real repositories: lines that move, lines that are edited,
// a renamed file, a deleted file (orphaned, lastKnown kept), old-side anchors with an unchanged base, whole-file
// anchors, a draft made on an older round, the agent's ask/reanchor with working-file lines (mapped to the head
// round; staged overrides applied by the next round).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RefusedError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/ops.js';
import { fileDraft, lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
/** @type {any} */
let ctx;
const ID = 'cr-uncommitted';

beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(30), 'src/b.js': lines(20, (i) => `b ${i}`), 'src/c.js': lines(10, (i) => `c ${i}`), 'src/d.js': lines(10, (i) => `d ${i}`) } });
  r.write('src/a.js', lines(30, (i) => (i === 10 ? 'ten' : i === 20 ? 'twenty' : `line ${i}`)));
  r.write('src/b.js', lines(20, (i) => (i === 5 ? 'b five' : `b ${i}`)));
  r.write('src/c.js', lines(10, (i) => (i === 3 ? 'c three' : `c ${i}`)));
  r.write('src/d.js', lines(10, (i) => (i === 7 ? 'd seven' : `d ${i}`)));
  ctx = await r.ctx();
  await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * The anchor of a thread at round v: [path, side, startLine, endLine, state].
 * @param {string} tid
 * @param {number} v
 */
async function at(tid, v) {
  const t = /** @type {any} */ (await ctx.store.getThread(ID, tid));
  const a = t.anchors[String(v)];
  if (!a) return null;
  return [a.file?.path ?? null, a.file?.side ?? null, a.kind === 'doc' ? null : a.src?.startLine, a.kind === 'doc' ? null : a.src?.endLine, a.state];
}

describe('re-anchoring across rounds', () => {
  test('moved, edited, renamed, deleted, old side and whole file', async () => {
    await lineDraft(ctx, ID, { file: 'src/a.js', lines: 20, body: 'moves' }); // t1
    await lineDraft(ctx, ID, { file: 'src/a.js', lines: 10, body: 'edited' }); // t2
    await lineDraft(ctx, ID, { file: 'src/b.js', lines: 5, body: 'renamed' }); // t3
    await lineDraft(ctx, ID, { file: 'src/c.js', lines: 3, body: 'deleted' }); // t4
    await lineDraft(ctx, ID, { file: 'src/d.js', side: 'old', lines: 7, body: 'old side' }); // t5
    await fileDraft(ctx, ID, { file: 'src/b.js', body: 'whole file' }); // t6
    await submit(ctx, ID);

    r.write('src/a.js', `// one\n// two\n// three\n${lines(30, (i) => (i === 10 ? 'TEN!' : i === 20 ? 'twenty' : `line ${i}`))}`);
    r.write('src/renamed.js', `// moved here\n${r.read('src/b.js')}`);
    r.rm('src/b.js');
    r.rm('src/c.js');
    r.write('src/d.js', lines(10, (i) => (i === 7 ? 'd seven' : i === 1 ? 'd one!' : `d ${i}`)));
    await ops.revise(ctx, ID, { summary: 'r2', threads: { t2: { status: 'addressed', reply: 'changed', at: 'src/a.js:L13' } } });

    assert.deepEqual(await at('t1', 2), ['src/a.js', 'new', 23, 23, 'moved']);
    const t2 = /** @type {any[]} */ (await at('t2', 2));
    assert.deepEqual(t2.slice(0, 4), ['src/a.js', 'new', 13, 13]);
    assert.ok(['edited', 'changed'].includes(t2[4]), t2[4]);
    assert.deepEqual(await at('t3', 2), ['src/renamed.js', 'new', 6, 6, 'moved']);
    const t4 = /** @type {any} */ (await ctx.store.getThread(ID, 't4')).anchors['2'];
    assert.equal(t4.state, 'orphaned');
    assert.equal(t4.lastKnown.file.path, 'src/c.js');
    assert.equal(t4.lastKnown.src.startLine, 3);
    assert.deepEqual(await at('t5', 2), ['src/d.js', 'old', 7, 7, 'exact']);
    assert.deepEqual(await at('t6', 2), ['src/renamed.js', 'new', null, null, 'exact']);
  });

  test('a draft made on v1 and submitted at v2 is carried by the forwarder', async () => {
    await lineDraft(ctx, ID, { file: 'src/a.js', lines: 20, version: 1, body: 'late' });
    r.write('src/a.js', `// x\n${r.read('src/a.js')}`);
    await ops.revise(ctx, ID, { summary: 'r2' });
    await submit(ctx, ID);
    const t = /** @type {any} */ (await ctx.store.getThread(ID, 't1'));
    assert.equal(t.anchors['2'].file.path, 'src/a.js');
    assert.equal(t.anchors['2'].src.startLine, 21);
    assert.equal(t.anchors['2'].src.text, 'twenty');
  });
});

describe('agent threads with working-file lines', () => {
  test('ask: lines of the working file are mapped to the head round; lines only in the working tree are refused', async () => {
    r.write('src/a.js', `// new 1\n// new 2\n${r.read('src/a.js')}`);
    const res = /** @type {any} */ (await ops.ask(ctx, ID, { file: 'src/a.js', lines: [22, 22], body: 'is twenty right?' }));
    assert.deepEqual(res.lines, [20, 20]);
    assert.equal(res.thread.anchors['1'].src.text, 'twenty');
    assert.equal(res.thread.status, 'needs_input');
    await assert.rejects(ops.ask(ctx, ID, { file: 'src/a.js', lines: [1, 2], body: 'new?' }), (e) => e instanceof RefusedError && /exist only in your working tree/.test(e.message));
    const whole = /** @type {any} */ (await ops.ask(ctx, ID, { file: 'a.js', body: 'the file?' }));
    assert.equal(whole.thread.anchors['1'].kind, 'doc');
    assert.equal(whole.thread.anchors['1'].file.path, 'src/a.js');
    const review = /** @type {any} */ (await ops.ask(ctx, ID, { body: 'overall?' }));
    assert.equal(review.thread.anchors['1'].file ?? null, null);
  });

  test('reanchor: applied now when the working file equals head, staged until the next round otherwise', async () => {
    await lineDraft(ctx, ID, { file: 'src/a.js', lines: 10, body: 'x' });
    await submit(ctx, ID);
    const now = /** @type {any} */ (await ops.reanchorThread(ctx, ID, 't1', { lines: [11, 12] }));
    assert.equal(now.staged, false);
    assert.deepEqual([now.anchor.src.startLine, now.anchor.src.endLine, now.anchor.file.path], [11, 12, 'src/a.js']);

    r.write('src/a.js', `// top\n${r.read('src/a.js')}`);
    const staged = /** @type {any} */ (await ops.reanchorThread(ctx, ID, 't1', { file: 'src/a.js', lines: [21, 21] }));
    assert.equal(staged.staged, true);
    await ops.revise(ctx, ID, { summary: 'r2' });
    const a = /** @type {any} */ (await ctx.store.getThread(ID, 't1')).anchors['2'];
    assert.deepEqual([a.file.path, a.src.startLine, a.src.text, a.mappedBy], ['src/a.js', 21, 'twenty', 'override']);
  });
});
