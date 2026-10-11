// @ts-check
// Attribution and the round report of code reviews (design 4.6, 4.8, 4.9): `at` hints link a file's hunks to
// threads, overlaps link without a hint, `other` entries in the code forms, unlinked hunks and deletions are code
// profile notes (never refusals), the report text, replies-only rounds, the missing step of modes that cannot see
// working-tree edits, ambiguous paths, dry runs and a moved base.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RefusedError, UsageError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/ops.js';
import { lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(40), 'lib/a.js': lines(10, (i) => `lib ${i}`), 'src/b.js': lines(10, (i) => `b ${i}`) } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * An uncommitted review of src/a.js L10 and src/b.js L3 with two submitted threads (t1 on a.js L10, t2 on b.js L3).
 */
async function reviewed() {
  r.write('src/a.js', lines(40, (i) => (i === 10 ? 'ten' : `line ${i}`)));
  r.write('src/b.js', lines(10, (i) => (i === 3 ? 'b three' : `b ${i}`)));
  r.write('lib/a.js', lines(10, (i) => (i === 1 ? 'lib one' : `lib ${i}`)));
  const ctx = await r.ctx();
  const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
  await lineDraft(ctx, doc.id, { file: 'src/a.js', lines: 10, body: 'ten?' });
  await lineDraft(ctx, doc.id, { file: 'src/b.js', lines: 3, body: 'three?' });
  await submit(ctx, doc.id);
  return { ctx, id: doc.id };
}

describe('linking hunks to threads', () => {
  test('hints, overlaps, other entries and unlinked hunks; the report rows', async () => {
    const { ctx, id } = await reviewed();
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'TEN' : i === 30 ? 'thirty' : i === 35 ? 'thirty-five' : `line ${i}`)));
    r.write('src/b.js', lines(10, (i) => (i === 3 ? 'b THREE' : `b ${i}`)));
    r.write('lib/a.js', lines(10, (i) => (i === 1 ? 'lib one' : i === 8 ? 'lib eight' : `lib ${i}`)));
    const rep = /** @type {any} */ (await ops.revise(ctx, id, {
      summary: 'fixes',
      threads: { t1: { status: 'addressed', reply: 'TEN now', at: 'src/a.js:L10' }, t2: { status: 'addressed', reply: 'THREE' } },
      other: [{ at: 'src/a.js:L30', why: 'rename' }],
    }));
    assert.equal(rep.version, 2);
    assert.equal(rep.kind, 'code');
    const row = (/** @type {RegExp} */ re) => rep.text.split('\n').find((/** @type {string} */ l) => re.test(l)) ?? '';
    assert.match(row(/src\/a\.js#h1 /), /L10\s+-> t1 addressed\s+\(hint\)/);
    assert.match(row(/src\/b\.js#h1 /), /L3\s+-> t2 addressed\s+\(overlap\)/);
    assert.match(row(/src\/a\.js#h2 /), /L30\s+-> other: rename/);
    assert.match(row(/src\/a\.js#h3 /), /L35\s+-> \(no thread\)/);
    assert.match(row(/lib\/a\.js#h1 /), /L8\s+-> \(no thread\)/);
    assert.match(rep.text, /^guards: code profile · ok \(2 notes\)\n  note: lib\/a\.js#h1 is linked to no thread\n  note: src\/a\.js#h3 is linked to no thread$/m);
    assert.match(rep.text, /^base: HEAD [0-9a-f]{7} \(unchanged\) · files in review: 3/m);
    assert.match(rep.text, /responds to rv1/);
    // the manifest carries the per-file hunks; threads record the change
    const m = (await ctx.store.readVersion(id, 2)).manifest;
    const h1 = /** @type {any} */ (m.hunks).find((/** @type {any} */ h) => h.id === 'src/a.js#h1');
    assert.equal(h1.file, 'src/a.js');
    assert.deepEqual(h1.threads, ['t1']);
    const t1 = /** @type {any} */ (await ctx.store.getThread(id, 't1'));
    assert.deepEqual(t1.changes.map((/** @type {any} */ c) => [c.version, c.hunk]), [[2, 'src/a.js#h1']]);
    assert.equal(t1.status, 'addressed');
    assert.equal(t1.comments.at(-1).body, 'TEN now');
  });

  test('an `at` path that matches several files is refused; a bare hunk id with one changed file is fine', async () => {
    const { ctx, id } = await reviewed();
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'TEN' : `line ${i}`)));
    r.write('lib/a.js', lines(10, (i) => (i === 1 ? 'lib one' : i === 9 ? 'lib nine' : `lib ${i}`)));
    await assert.rejects(
      ops.revise(ctx, id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'r', at: 'a.js:L10' } } }),
      (e) => e instanceof RefusedError && /matches/.test(e.message) && /src\/a\.js/.test(e.message),
    );
    r.write('lib/a.js', lines(10, (i) => (i === 1 ? 'lib one' : `lib ${i}`)));
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'ten' : i === 30 ? 'thirty' : `line ${i}`)));
    const rep = /** @type {any} */ (await ops.revise(ctx, id, { summary: 's', other: [{ at: 'h1', why: 'only file' }] }));
    assert.match(rep.text, /src\/a\.js#h1\s+L30\s+-> other: only file/);
    assert.match(rep.text, /note: t1 needs action but has no reply/);
    await assert.rejects(ops.revise(ctx, id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'r', at: 'src/a.js:Lx' } } }), UsageError);
  });

  test('dry run predicts the round and records nothing', async () => {
    const { ctx, id } = await reviewed();
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'TEN' : `line ${i}`)));
    const rep = /** @type {any} */ (await ops.revise(ctx, id, { summary: 's', dryRun: true, threads: { t1: { status: 'addressed', reply: 'r', at: 'src/a.js:L10' } } }));
    assert.equal(rep.dryRun, true);
    assert.match(rep.text, /dry run - would record v2/);
    assert.equal((await ctx.store.requireDoc(id)).head, 1);
    assert.equal((/** @type {any} */ (await ctx.store.getThread(id, 't1'))).comments.length, 1);
  });
});

describe('rounds that record nothing', () => {
  test('unchanged with replies: the replies only; unchanged without: nothing', async () => {
    const { ctx, id } = await reviewed();
    const rep = /** @type {any} */ (await ops.revise(ctx, id, { summary: 's', threads: { t1: { status: 'answered', reply: 'it is intended' } } }));
    assert.equal(rep.repliesOnly, true);
    assert.match(rep.text, /the round matches v1; posted 1 reply \(no new version\)/);
    assert.equal((await ctx.store.requireDoc(id)).head, 1);
    assert.equal((/** @type {any} */ (await ctx.store.getThread(id, 't1'))).status, 'answered');
    const none = /** @type {any} */ (await ops.revise(ctx, id, { summary: 's' }));
    assert.equal(none.nothing, true);
  });

  test('staged / branch: an addressed reply with an unchanged round names the missing step (exit 3)', async () => {
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'ten' : `line ${i}`)));
    r.git('add', 'src/a.js');
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'staged' } });
    await lineDraft(ctx, doc.id, { file: 'src/a.js', lines: 10 });
    await submit(ctx, doc.id);
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'TEN' : `line ${i}`)));
    await assert.rejects(ops.revise(ctx, doc.id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'done' } } }), (e) => e instanceof RefusedError && /stage your changes with `git add`/.test(e.message));
    r.git('add', 'src/a.js');
    const rep = /** @type {any} */ (await ops.revise(ctx, doc.id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'done' } } }));
    assert.equal(rep.version, 2);

    r.git('commit', '-q', '-m', 'staged');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('src/b.js', lines(10, (i) => (i === 3 ? 'b three' : `b ${i}`)));
    r.commit('feat');
    const br = (await ops.openCodeReview(ctx, { input: { mode: 'branch', base: 'main' } })).doc;
    await lineDraft(ctx, br.id, { file: 'src/b.js', lines: 3 });
    await submit(ctx, br.id);
    r.write('src/b.js', lines(10, (i) => (i === 3 ? 'b THREE' : `b ${i}`)));
    await assert.rejects(ops.revise(ctx, br.id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'done' } } }), (e) => e instanceof RefusedError && /commit your changes/.test(e.message));
  });
});

describe('the base', () => {
  test('a moved base (rebase) is reported, and the old side follows the new merge-base', async () => {
    r.git('checkout', '-q', '-b', 'feat');
    r.write('src/a.js', lines(40, (i) => (i === 10 ? 'ten' : `line ${i}`)));
    r.commit('feat');
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'since-base', base: 'main' } });
    r.git('checkout', '-q', 'main');
    r.write('src/b.js', lines(10, (i) => (i === 1 ? 'b upstream' : `b ${i}`)));
    r.commit('upstream');
    r.git('checkout', '-q', 'feat');
    r.git('rebase', '-q', 'main');
    const rep = /** @type {any} */ (await ops.revise(ctx, doc.id, { summary: 'rebased' }));
    assert.ok(rep.code.baseMoved);
    assert.match(rep.text, /base: merge-base [0-9a-f]{7} \(moved from [0-9a-f]{7}\)/);
  });
});
