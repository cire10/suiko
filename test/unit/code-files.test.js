// @ts-check
// The per-file views of a code review (design 4.12, daemon routes of WP4): codeFiles for a round and between two
// rounds (changed / added / dropped / renamed with linked threads), codeFileDiff for a round (namespaced hunk ids,
// row threads, stubs) and between rounds (thread chips from the round's hunks), codeFileSource (both sides, paths as
// agents write them), codeChanges (the ChangeSet shape), the unified interdiff and the thread mini diff.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, UsageError } from '../../src/core/store/errors.js';
import * as ops from '../../src/core/review/ops.js';
import { fileDraft, lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
/** @type {any} */
let ctx;
const ID = 'cr-uncommitted';

before(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(30), 'src/b.js': lines(10, (i) => `b ${i}`), 'old/name.js': lines(8, (i) => `n ${i}`) } });
  // round 1: a.js changed, b.js changed, c.js added, logo binary
  r.write('src/a.js', lines(30, (i) => (i === 10 ? 'ten' : `line ${i}`)));
  r.write('src/b.js', lines(10, (i) => (i === 2 ? 'b two' : `b ${i}`)));
  r.write('src/c.js', 'c1\nc2\n');
  r.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  ctx = await r.ctx();
  await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
  await lineDraft(ctx, ID, { file: 'src/a.js', lines: 10, body: 'ten?' });
  await lineDraft(ctx, ID, { file: 'src/b.js', side: 'old', lines: 2, body: 'why change b 2?' });
  await fileDraft(ctx, ID, { file: 'logo.png', body: 'smaller' });
  await submit(ctx, ID);
  // round 2: a.js changes again (linked to t1), b.js restored (dropped), name.js renamed, c.js unchanged
  r.write('src/a.js', lines(30, (i) => (i === 10 ? 'TEN' : `line ${i}`)));
  r.write('src/b.js', lines(10, (i) => `b ${i}`));
  r.write('new/name.js', r.read('old/name.js'));
  r.rm('old/name.js');
  await ops.revise(ctx, ID, { summary: 'r2', threads: { t1: { status: 'addressed', reply: 'TEN', at: 'src/a.js:L10' }, t2: { status: 'addressed', reply: 'restored' } } });
});
after(async () => {
  await r.cleanup();
});

describe('codeFiles', () => {
  test('a round: its files with the threads on them, and the skipped entries', async () => {
    const res = /** @type {any} */ (await ops.codeFiles(ctx, ID, { v: 1 }));
    assert.equal(res.v, 1);
    assert.deepEqual(res.files.map((/** @type {any} */ f) => [f.path, f.status, f.threads]), [
      ['logo.png', 'A', ['t3']],
      ['src/a.js', 'M', ['t1']],
      ['src/b.js', 'M', ['t2']],
      ['src/c.js', 'A', []],
    ]);
    assert.deepEqual(res.skipped, [{ path: 'logo.png', reason: 'binary' }]);
  });

  test('between rounds: changed, renamed, carried files, linked threads', async () => {
    const res = /** @type {any} */ (await ops.codeFiles(ctx, ID, { from: 1, to: 2 }));
    assert.deepEqual([res.from, res.to], [1, 2]);
    const rows = Object.fromEntries(res.files.map((/** @type {any} */ f) => [f.path, f]));
    assert.deepEqual([rows['src/a.js'].change, rows['src/a.js'].added, rows['src/a.js'].removed, rows['src/a.js'].threads], ['changed', 1, 1, ['t1']]);
    // restored to base, but kept in the round (status '=') while t2 is open: its new side changed
    assert.equal(rows['src/b.js'].change, 'changed');
    const v2 = /** @type {any} */ (await ops.codeFiles(ctx, ID, { v: 2 }));
    assert.equal(v2.files.find((/** @type {any} */ f) => f.path === 'src/b.js').status, '=');
    assert.deepEqual([rows['new/name.js'].change, rows['new/name.js'].oldPath, rows['new/name.js'].added], ['renamed', 'old/name.js', 0]);
    assert.ok(!rows['src/c.js'], 'unchanged between the rounds');
    // default range: the last reviewed round .. head
    assert.deepEqual([(/** @type {any} */ (await ops.codeFiles(ctx, ID, {}))).v], [2]);
  });
});

describe('codeFileDiff', () => {
  test('a round: namespaced hunk ids, row threads (new and old side), stubs, unknown paths', async () => {
    const a = /** @type {any} */ (await ops.codeFileDiff(ctx, ID, { path: 'src/a.js', v: 1 }));
    assert.equal(a.path, 'src/a.js');
    assert.equal(a.hunks.length, 1);
    assert.match(a.hunks[0].id, /^src\/a\.js#h\d+$/);
    assert.deepEqual(a.hunks[0].threads, ['t1']);
    assert.ok(a.hunks[0].rows.some((/** @type {any} */ row) => row.op === '+' && row.text === 'ten' && row.newNo === 10));
    const b = /** @type {any} */ (await ops.codeFileDiff(ctx, ID, { path: 'src/b.js', v: 1 }));
    assert.deepEqual(b.hunks[0].threads, ['t2']);
    const wide = /** @type {any} */ (await ops.codeFileDiff(ctx, ID, { path: 'src/a.js', v: 1, context: 100 }));
    assert.equal(wide.hunks[0].rows.length, 31);
    assert.deepEqual(await ops.codeFileDiff(ctx, ID, { path: 'logo.png', v: 1 }), { path: 'logo.png', v: 1, stub: 'binary', hunks: [] });
    await assert.rejects(ops.codeFileDiff(ctx, ID, { path: 'nope.js', v: 1 }), NotFoundError);
    await assert.rejects(ops.codeFileDiff(ctx, ID, /** @type {any} */ ({ v: 1 })), UsageError);
    const renamed = /** @type {any} */ (await ops.codeFileDiff(ctx, ID, { path: 'new/name.js', v: 2 }));
    assert.equal(renamed.oldPath, 'old/name.js');
  });

  test('between rounds: the interdiff with thread chips from the round\'s hunks', async () => {
    const d = /** @type {any} */ (await ops.codeFileDiff(ctx, ID, { path: 'src/a.js', from: 1, to: 2 }));
    assert.deepEqual([d.from, d.to], [1, 2]);
    const rows = d.hunks.flatMap((/** @type {any} */ h) => h.rows);
    assert.ok(rows.some((/** @type {any} */ row) => row.op === '-' && row.text === 'ten'));
    assert.ok(rows.some((/** @type {any} */ row) => row.op === '+' && row.text === 'TEN'));
    assert.deepEqual(d.hunks[0].threads, ['t1']);
  });
});

describe('sources, changes and patches', () => {
  test('codeFileSource: both sides; a path as the agent writes it', async () => {
    const n = await ops.codeFileSource(ctx, ID, { path: 'src/b.js', v: 1, side: 'new' });
    assert.deepEqual([n.path, n.side, n.v, n.lines], ['src/b.js', 'new', 1, 10]);
    assert.ok(n.text.includes('b two'));
    const o = await ops.codeFileSource(ctx, ID, { path: 'src/b.js', v: 1, side: 'old' });
    assert.ok(o.text.includes('b 2\n'));
    const viaSuffix = await ops.codeFileSource(ctx, ID, { path: 'b.js', v: 1, side: 'new' });
    assert.equal(viaSuffix.path, 'src/b.js');
    await assert.rejects(ops.codeFileSource(ctx, ID, { path: 'logo.png', v: 1, side: 'new' }), UsageError);
    await assert.rejects(ops.codeFileSource(ctx, ID, { path: 'src/c.js', v: 1, side: 'old' }), (e) => e instanceof UsageError && /added/.test(e.message));
  });

  test('changes: ChangeSet hunks with file, section and links; the unified interdiff; the mini diff', async () => {
    const ch = /** @type {any} */ (await ops.changes(ctx, ID, { from: 1, to: 2 }));
    assert.deepEqual([ch.from, ch.to], [1, 2]);
    const a = ch.hunks.find((/** @type {any} */ h) => h.file === 'src/a.js');
    assert.match(a.id, /^src\/a\.js#h\d+$/);
    assert.deepEqual(a.section, ['src/a.js']);
    assert.deepEqual(a.threads, ['t1']);
    assert.deepEqual(ch.threadLinks.t1, [a.id]);
    const patch = /** @type {any} */ (await ops.unifiedDiff(ctx, ID, { from: 1, to: 2 }));
    assert.match(patch.patch, /^--- a\/src\/a\.js@v1\n\+\+\+ b\/src\/a\.js@v2\n/m);
    assert.match(patch.patch, /-ten\n\+TEN/);
    assert.match(patch.patch, /--- a\/old\/name\.js@v1\n\+\+\+ b\/new\/name\.js@v2\n\(renamed, content unchanged\)\n/);
    const mini = /** @type {any} */ (await ops.threadMiniDiff(ctx, ID, 't1'));
    assert.deepEqual([mini.kind, mini.from, mini.version, mini.before, mini.after], ['text', 1, 2, 'ten', 'TEN']);
    assert.equal(mini.file.path, 'src/a.js');
  });
});
