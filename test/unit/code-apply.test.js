// @ts-check
// Suggestions applied to real repo files (design 4.11): written where the thread is anchored now (the file moved
// on), CRLF kept, a trailing newline of the suggestion not doubled, conflicts (text gone, overlapping, missing
// file, symlink, not a code suggestion), dry runs, the CAS retry, the pending edit that links the next round's hunk
// ("tagged: apply") and marks the suggestion applied, and the reviewer's "Apply now" (a ui-apply round).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/ops.js';
import { applyCodeSuggestions, wholeLinesText } from '../../src/core/code/apply.js';
import { agentActor } from '../../src/core/review/ops/common.js';
import { fileDraft, lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(20, (i) => `const a${i} = ${i};`), 'b.txt': 'b1\r\nb2\r\nb3\r\n' } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * Opens an uncommitted review of a few changes and returns ctx + doc id.
 */
async function open() {
  r.write('src/a.js', lines(20, (i) => (i === 5 ? 'const a5 = 50;' : `const a${i} = ${i};`)));
  r.write('b.txt', 'b1\r\nB2\r\nb3\r\n');
  const ctx = await r.ctx();
  const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
  return { ctx, id: doc.id };
}

describe('apply on a code review', () => {
  test('writes the suggestion where the thread is anchored now; the next round links it and marks it applied', async () => {
    const { ctx, id } = await open();
    await lineDraft(ctx, id, { file: 'src/a.js', lines: 5, suggestion: 'const a5 = 5; // restored\n', body: 'restore' });
    await submit(ctx, id);
    // the agent edits above the line first
    r.write('src/a.js', `// header\n${r.read('src/a.js')}`);
    const dry = await ops.applySuggestions(ctx, id, ['t1'], { dryRun: true });
    assert.deepEqual(dry.applied, [{ id: 't1', file: 'src/a.js', lines: [6, 6], how: 'exact' }]);
    assert.ok(!r.read('src/a.js').includes('restored'), 'a dry run writes nothing');
    const res = await ops.applySuggestions(ctx, id, ['t1'], {});
    assert.deepEqual(res.applied, [{ id: 't1', file: 'src/a.js', lines: [6, 6], how: 'exact' }]);
    const text = r.read('src/a.js');
    assert.equal(text.split('\n')[5], 'const a5 = 5; // restored');
    assert.equal(text.split('\n')[6], 'const a6 = 6;', 'the trailing newline of the suggestion is not doubled');
    const t = await ctx.store.getThread(id, 't1');
    assert.equal(t?.suggestion?.status, 'staged');
    const pending = await ctx.store.readPendingEdits(id);
    assert.equal(pending.length, 1);
    assert.equal(/** @type {any} */ (pending[0]).file, 'src/a.js');
    // applying again is skipped
    assert.deepEqual((await ops.applySuggestions(ctx, id, ['t1'], {})).skipped, [{ id: 't1', reason: 'already applied to the working tree (staged)' }]);

    const report = /** @type {any} */ (await ops.revise(ctx, id, { summary: 'applied', threads: { t1: { status: 'addressed', reply: 'applied' } } }));
    assert.match(report.text, /src\/a\.js#h\d+\s+L6\s+-> t1 addressed\s+\(tagged: apply\)/);
    const after = await ctx.store.getThread(id, 't1');
    assert.equal(after?.suggestion?.status, 'applied');
    assert.equal(after?.suggestion?.appliedIn, 2);
    assert.equal((await ctx.store.readPendingEdits(id)).length, 0);
  });

  test('CRLF files keep CRLF', async () => {
    const { ctx, id } = await open();
    await lineDraft(ctx, id, { file: 'b.txt', lines: 2, suggestion: 'bee two\nbee two and a half', body: 'x' });
    await submit(ctx, id);
    const res = await ops.applySuggestions(ctx, id, ['t1'], {});
    assert.equal(res.applied.length, 1);
    assert.equal(r.read('b.txt'), 'b1\r\nbee two\r\nbee two and a half\r\nb3\r\n');
  });

  test('conflicts: the text is gone, overlapping suggestions, a missing file, a symlink; comments are skipped', async () => {
    const { ctx, id } = await open();
    await lineDraft(ctx, id, { file: 'src/a.js', lines: 5, suggestion: 'const a5 = 6;', body: 'one' });
    await lineDraft(ctx, id, { file: 'src/a.js', lines: [5, 6], suggestion: 'const a5 = 7;\nconst a6 = 7;', body: 'two' });
    await lineDraft(ctx, id, { file: 'b.txt', lines: 1, suggestion: 'B1', body: 'three' });
    await fileDraft(ctx, id, { file: 'src/a.js', body: 'whole file' });
    await lineDraft(ctx, id, { file: 'src/a.js', lines: 10, body: 'a comment' });
    await submit(ctx, id);
    const overlap = await ops.applySuggestions(ctx, id, ['t1', 't2'], { dryRun: true });
    assert.deepEqual(overlap.applied.map((a) => a.id), ['t1']);
    assert.match(overlap.conflicts[0].reason, /overlaps t1/);
    // comments (a whole file, lines) are not suggestions: skipped
    assert.deepEqual((await ops.applySuggestions(ctx, id, ['t4', 't5'], { dryRun: true })).skipped?.map((c) => c.id), ['t4', 't5']);

    r.write('src/a.js', lines(20, (i) => (i === 5 ? 'const a5 = 51;' : `const a${i} = ${i};`)));
    const gone = await ops.applySuggestions(ctx, id, ['t1'], {});
    assert.equal(gone.applied.length, 0);
    assert.match(gone.conflicts[0].reason, /no longer where t1 is anchored/);
    assert.equal((await ctx.store.getThread(id, 't1'))?.suggestion?.status, 'conflict');

    r.rm('b.txt');
    assert.match((await ops.applySuggestions(ctx, id, ['t3'], {})).conflicts[0].reason, /missing from your working tree/);
    fs.writeFileSync(path.join(r.base, 'target.txt'), 'b1\r\nB2\r\nb3\r\n');
    fs.symlinkSync(path.join(r.base, 'target.txt'), path.join(r.root, 'b.txt'));
    const sym = await ops.applySuggestions(ctx, id, ['t3'], {});
    assert.match(sym.conflicts[0].reason, /symlink/);
    assert.equal(fs.readFileSync(path.join(r.base, 'target.txt'), 'utf8'), 'b1\r\nB2\r\nb3\r\n', 'never written through a symlink');
  });

  test('a file changed between the read and the write is re-read and retried once (CAS)', async () => {
    const { ctx, id } = await open();
    await lineDraft(ctx, id, { file: 'src/a.js', lines: 5, suggestion: 'const a5 = 5;', body: 'x' });
    await submit(ctx, id);
    const store = ctx.store;
    const realRead = store.readRepoFile.bind(store);
    let calls = 0;
    store.readRepoFile = async (/** @type {string} */ rel, /** @type {any} */ o) => {
      const res = await realRead(rel, o);
      calls += 1;
      // first read: someone edits the file right after we read it
      if (calls === 1) r.write('src/a.js', `${r.read('src/a.js')}// appended concurrently\n`);
      return res;
    };
    try {
      const res = await applyCodeSuggestions(ctx, await ctx.store.requireDoc(id), ['t1'], { actor: agentActor(ctx) });
      assert.equal(res.applied.length, 1);
      assert.equal(calls, 2);
      const text = r.read('src/a.js');
      assert.ok(text.includes('const a5 = 5;\n') && text.endsWith('// appended concurrently\n'));
    } finally {
      store.readRepoFile = realRead;
    }
  });

  test('the reviewer applies a suggestion from the UI: a ui-apply round is recorded', async () => {
    const { ctx, id } = await open();
    await lineDraft(ctx, id, { file: 'src/a.js', lines: 5, suggestion: 'const a5 = 500;', body: 'x' });
    await submit(ctx, id);
    const res = /** @type {any} */ (await ops.applySuggestionAsReviewer(ctx, id, 't1', { by: 'Eric' }));
    assert.ok(res);
    assert.ok(r.read('src/a.js').includes('const a5 = 500;'));
    const doc = await ctx.store.requireDoc(id);
    assert.equal(doc.head, 2);
    const m = await ctx.store.readVersion(id, 2);
    assert.equal(m.manifest.capturedBy, 'ui-apply');
    assert.equal((await ctx.store.getThread(id, 't1'))?.suggestion?.status, 'applied');
  });

  test('wholeLinesText drops one trailing newline unless the replaced lines end with one', () => {
    assert.equal(wholeLinesText({ old: 'a', new: 'b\n' }), 'b');
    assert.equal(wholeLinesText({ old: 'a', new: 'b\r\n' }), 'b');
    assert.equal(wholeLinesText({ old: 'a', new: 'b\n\n' }), 'b\n');
    assert.equal(wholeLinesText({ old: 'a\n', new: 'b\n' }), 'b\n');
    assert.equal(wholeLinesText({ old: 'a', new: '' }), '');
  });
});
