// @ts-check
// Dirty state of code reviews (design 4.13, codeWorkingState): clean right after a round, dirty with the changed
// files after an edit (seen at once despite the memo), clean again when the edit is undone, untracked files, the
// staged mode (worktree edits are not its new side; `git add` is), branch mode (a new commit), a fixed --commit
// round 1 (never dirty), and `wait` refusing a dirty review (exit 3 path) unless allowDirty.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/ops.js';
import { codeWorkingState } from '../../src/core/code/state.js';
import { readHead } from '../../src/core/review/ops/common.js';
import { lines, makeRepo } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'a.js': lines(10), 'b.js': lines(5, (i) => `b ${i}`) } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * @param {any} ctx
 * @param {string} id
 */
async function state(ctx, id) {
  const doc = await ctx.store.requireDoc(id);
  return codeWorkingState(ctx, doc, await readHead(ctx, doc));
}

describe('codeWorkingState', () => {
  test('worktree: clean after the round, dirty with changedFiles after an edit, clean again once undone', async () => {
    r.write('a.js', lines(10, (i) => (i === 3 ? 'three' : `line ${i}`)));
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    const clean = await state(ctx, doc.id);
    assert.equal(clean.dirty, false);
    assert.deepEqual(clean.changedFiles, []);
    r.write('a.js', lines(10, (i) => (i === 3 ? 'three!' : `line ${i}`)));
    const dirty = await state(ctx, doc.id); // within the 2 s memo: the stat change is seen
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.changedFiles, ['a.js']);
    assert.match(dirty.text, /\+three!/);
    r.write('a.js', lines(10, (i) => (i === 3 ? 'three' : `line ${i}`)));
    assert.equal((await state(ctx, doc.id)).dirty, false);
    // docState carries it for the UI; a tracked file outside the round counts too (seen once the memo expires:
    // the stat signature covers the round's files)
    r.write('b.js', 'changed\n');
    await new Promise((res) => setTimeout(res, 2100));
    const st = /** @type {any} */ (await ops.docState(ctx, doc.id));
    assert.equal(st.working.dirty, true);
    assert.deepEqual(st.working.changedFiles, ['b.js']);
  });

  test('a new untracked file and a deleted reviewed file make it dirty', async () => {
    r.write('a.js', lines(11));
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    r.write('new.js', 'n\n');
    await new Promise((res) => setTimeout(res, 2100)); // past the memo (an untracked file has no stat in the head round)
    const s1 = await state(ctx, doc.id);
    assert.equal(s1.dirty, true);
    assert.deepEqual(s1.changedFiles, ['new.js']);
    r.rm('new.js');
    r.rm('a.js');
    const s2 = await state(ctx, doc.id);
    assert.equal(s2.dirty, true);
    assert.deepEqual(s2.changedFiles, ['a.js']);
  });

  test('staged: working-tree edits are not its new side; git add is', async () => {
    r.write('a.js', lines(11));
    r.git('add', 'a.js');
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'staged' } });
    r.write('a.js', lines(12));
    assert.equal((await state(ctx, doc.id)).dirty, false);
    r.git('add', 'a.js');
    await new Promise((res) => setTimeout(res, 2100)); // the index side has no stat signature: past the memo
    const s = await state(ctx, doc.id);
    assert.equal(s.dirty, true);
    assert.deepEqual(s.changedFiles, ['a.js']);
  });

  test('branch: a new commit makes it dirty; a --commit round 1 never is', async () => {
    r.git('checkout', '-q', '-b', 'feat');
    r.write('a.js', lines(11));
    const c = r.commit('one');
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'branch', base: 'main' } });
    const fixed = (await ops.openCodeReview(ctx, { input: { mode: 'commit', commit: c } })).doc;
    r.write('a.js', lines(12));
    assert.equal((await state(ctx, doc.id)).dirty, false, 'worktree edits are not the branch');
    assert.equal((await state(ctx, fixed.id)).dirty, false);
    r.commit('two');
    await new Promise((res) => setTimeout(res, 2100));
    assert.equal((await state(ctx, doc.id)).dirty, true);
    assert.equal((await state(ctx, fixed.id)).dirty, false, 'a fixed commit review is never dirty at v1');
  });

  test('wait refuses a dirty code review unless allowDirty; wait --all skips the check', async () => {
    r.write('a.js', lines(11));
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    r.write('a.js', lines(12));
    const res = await ops.waitForFeedback(ctx, { docIds: [doc.id], timeoutMs: 30, pollMs: 10 });
    assert.equal(res.status, 'dirty');
    const allowed = await ops.waitForFeedback(ctx, { docIds: [doc.id], timeoutMs: 30, pollMs: 10, allowDirty: true });
    assert.equal(allowed.status, 'timeout');
    const all = await ops.waitForFeedback(ctx, { docIds: null, timeoutMs: 30, pollMs: 10 });
    assert.equal(all.status, 'timeout');
  });
});
