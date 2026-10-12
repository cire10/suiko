// @ts-check
// Rounds and their canonical diff text (design 4.3 - 4.5) from real repositories: every mode's sides, the file kinds
// (untracked, modified, deleted, renamed, binary, too large, mode change, symlink), skipped entries, and a text that
// depends only on the contents (sorted by path, no repo config: colours, prefixes, quoting, renames setting).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RefusedError } from '../../src/core/store/errors.js';
import { takeCodeSnapshot } from '../../src/core/code/snapshot.js';
import { codeStats, skippedText } from '../../src/core/code/diff-text.js';
import { lines, makeRepo } from '../helpers/git-repo.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(10), 'src/old name.js': lines(12, (i) => `keep ${i}`), 'gone.txt': 'bye\n', 'bin/run.sh': '#!/bin/sh\necho hi\n' } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * A dry round of `spec`.
 * @param {any} spec
 * @param {any} [opts]
 */
async function snap(spec, opts = {}) {
  const ctx = await r.ctx();
  if (opts.config) ctx.config = { ...ctx.config, code: opts.config };
  return takeCodeSnapshot(ctx, { context: 3, ...spec }, { dry: true, ...opts });
}

/**
 * @param {any} code
 */
function summary(code) {
  return code.files.map((/** @type {any} */ f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path}${f.binary ? ' (binary)' : ''}${f.tooLarge ? ' (too large)' : ''}`);
}

describe('file kinds', () => {
  test('untracked, modified, deleted, renamed, binary, mode change; secrets excluded', async () => {
    r.write('src/a.js', lines(10, (i) => (i === 4 ? 'four' : `line ${i}`)));
    r.git('mv', 'src/old name.js', 'src/new name.js');
    r.write('src/new name.js', lines(12, (i) => (i === 12 ? 'changed' : `keep ${i}`)));
    r.rm('gone.txt');
    r.write('fresh.js', 'export const fresh = 1;\n');
    r.write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    r.write('.env', 'TOKEN=secret\n');
    r.write('keys/deploy.pem', '-----BEGIN PRIVATE KEY-----\n');
    fs.chmodSync(path.join(r.root, 'bin/run.sh'), 0o755);
    const s = await snap({ mode: 'uncommitted' });
    assert.deepEqual(summary(s.code), ['M bin/run.sh', 'A fresh.js', 'D gone.txt', 'A img/logo.png (binary)', 'M src/a.js', 'R src/old name.js -> src/new name.js']);
    assert.deepEqual(s.code.skipped, [{ path: '.env', reason: 'excluded' }, { path: 'img/logo.png', reason: 'binary' }, { path: 'keys/deploy.pem', reason: 'excluded' }]);
    const byPath = Object.fromEntries(s.code.files.map((f) => [f.path, /** @type {any} */ (f)]));
    assert.deepEqual(byPath['bin/run.sh'].mode, { old: '100644', new: '100755' });
    assert.deepEqual([byPath['src/a.js'].added, byPath['src/a.js'].removed], [1, 1]);
    assert.equal(byPath['gone.txt'].new, undefined);
    assert.match(byPath['gone.txt'].old, /^sha256:[0-9a-f]{64}$/);
    assert.equal(byPath['img/logo.png'].new, undefined, 'binary sides are not stored');
    assert.match(byPath['img/logo.png'].ids.new, /^[0-9a-f]{40}$|^sha256:/);
    // texts hold the decoded sides
    assert.equal(s.texts.get(byPath['fresh.js'].new), 'export const fresh = 1;\n');
    // the text: header, skipped, one block per file sorted by path
    assert.match(s.text, /^suiko code review · uncommitted HEAD [0-9a-f]{12} \.\. working tree\nfiles: 6 · \+\d+ -\d+ · skipped: \.env \(excluded: looks like a secret\), img\/logo\.png \(binary\), keys\/deploy\.pem \(excluded: looks like a secret\)\n/);
    const heads = s.text.split('\n').filter((l) => l.startsWith('diff --suiko '));
    assert.deepEqual(heads, [
      'diff --suiko a/bin/run.sh b/bin/run.sh',
      'diff --suiko a/fresh.js b/fresh.js',
      'diff --suiko a/gone.txt b/gone.txt',
      'diff --suiko a/img/logo.png b/img/logo.png',
      'diff --suiko a/src/a.js b/src/a.js',
      'diff --suiko a/src/old name.js b/src/new name.js',
    ]);
    assert.match(s.text, /status: M\nmode: 100644 -> 100755/);
    assert.match(s.text, /--- \/dev\/null\n\+\+\+ b\/fresh\.js\n@@ -0,0 \+1 @@\n\+export const fresh = 1;/);
    assert.match(s.text, /-line 4\n\+four/);
    assert.ok(!s.text.includes('TOKEN=secret') && !s.text.includes('PRIVATE KEY'));
    assert.deepEqual(codeStats(s.code.files), { files: 6, added: 3, removed: 3 });
    assert.equal(skippedText([{ path: 'x', reason: 'too-large' }]), 'x (too large)');
  });

  test('too-large files are stubs; a symlink is its link text, never its target', async () => {
    r.write('big.txt', 'x'.repeat(300));
    fs.writeFileSync(path.join(r.base, 'outside.txt'), 'OUTSIDE CONTENT\n');
    fs.symlinkSync(path.join(r.base, 'outside.txt'), path.join(r.root, 'link.txt'));
    const s = await snap({ mode: 'uncommitted' }, { config: { maxFileBytes: 200 } });
    const big = /** @type {any} */ (s.code.files.find((f) => f.path === 'big.txt'));
    assert.deepEqual(big.tooLarge, { side: 'new', bytes: 300 });
    assert.ok(s.code.skipped.some((x) => x.path === 'big.txt' && x.reason === 'too-large'));
    const link = /** @type {any} */ (s.code.files.find((f) => f.path === 'link.txt'));
    assert.equal(s.texts.get(link.new), path.join(r.base, 'outside.txt'));
    assert.ok(!s.text.includes('OUTSIDE CONTENT'));
  });

  test('more files than --max-files is refused (exit 3)', async () => {
    for (let i = 0; i < 4; i++) r.write(`many/${i}.txt`, `${i}\n`);
    await assert.rejects(snap({ mode: 'uncommitted' }, { maxFiles: 3 }), (e) => e instanceof RefusedError && /--max-files|--path/.test(e.message));
  });

  test('--path limits the round to its pathspecs', async () => {
    r.write('src/a.js', lines(11));
    r.write('other.txt', 'o\n');
    const s = await snap({ mode: 'uncommitted', paths: ['src'] });
    assert.deepEqual(summary(s.code), ['M src/a.js']);
  });
});

describe('modes', () => {
  test('each mode compares the sides of design 4.2', async () => {
    const c1 = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('src/a.js', lines(10, (i) => (i === 2 ? 'committed' : `line ${i}`)));
    const c2 = r.commit('c2');
    r.write('src/a.js', lines(10, (i) => (i === 2 ? 'committed' : i === 9 ? 'staged' : `line ${i}`)));
    r.git('add', 'src/a.js');
    r.write('wt.txt', 'working tree only\n');

    const uncommitted = await snap({ mode: 'uncommitted' });
    assert.equal(uncommitted.code.baseSha, c2);
    assert.equal(uncommitted.code.newSide, 'worktree');
    assert.deepEqual(summary(uncommitted.code), ['M src/a.js', 'A wt.txt']);

    const staged = await snap({ mode: 'staged' });
    assert.equal(staged.code.newSide, 'index');
    assert.deepEqual(summary(staged.code), ['M src/a.js']);
    assert.match(staged.code.newTree ?? '', /^[0-9a-f]{40}$/);

    const since = await snap({ mode: 'since-base', base: 'main' });
    assert.equal(since.code.baseSha, c1);
    assert.deepEqual(summary(since.code), ['M src/a.js', 'A wt.txt']);
    assert.match(since.text, /\+committed/);

    const branch = await snap({ mode: 'branch', base: 'main' });
    assert.equal(branch.code.newSide, 'commit');
    assert.equal(branch.code.newSha, c2);
    assert.deepEqual(summary(branch.code), ['M src/a.js']);
    assert.ok(!branch.text.includes('staged'));

    const range = await snap({ mode: 'range', from: 'main', to: 'feat' });
    assert.deepEqual([range.code.baseSha, range.code.newSha], [c1, c2]);
    r.git('stash', '-q', '-u');
    r.git('checkout', '-q', 'main');
    r.write('main-only.txt', 'm\n');
    const c3 = r.commit('c3');
    const two = await snap({ mode: 'range', from: 'feat', to: 'main' });
    assert.deepEqual(summary(two.code), ['A main-only.txt', 'M src/a.js']);
    const three = await snap({ mode: 'range', from: 'feat', to: 'main', threeDot: true });
    assert.equal(three.code.baseSha, c1, 'three-dot: from the merge-base');
    assert.deepEqual(summary(three.code), ['A main-only.txt']);

    const commit = await snap({ mode: 'commit', commit: c3 });
    assert.deepEqual([commit.code.baseSha, commit.code.newSha, commit.code.newSide], [c1, c3, 'commit']);
    const root = await snap({ mode: 'commit', commit: c1 });
    assert.equal(root.code.baseSha, EMPTY_TREE);
    assert.match(root.text, /commit [0-9a-f]{12}/);
  });

  test('an unborn HEAD: uncommitted compares with the empty tree', async () => {
    const u = await makeRepo();
    try {
      u.write('first.js', 'one\n');
      const ctx = await u.ctx();
      const s = await takeCodeSnapshot(ctx, { mode: 'uncommitted', context: 3 }, { dry: true });
      assert.equal(s.code.baseSha, EMPTY_TREE);
      assert.equal(s.code.headSha, null);
      assert.deepEqual(summary(s.code), ['A first.js']);
      assert.match(s.text, /uncommitted \(no commits yet\) \.\. working tree/);
    } finally {
      await u.cleanup();
    }
  });
});

describe('canonical text', () => {
  test('depends only on the contents: repo config (colours, prefixes, quoting, renames) changes nothing', async () => {
    r.write('src/a.js', lines(10, (i) => (i === 7 ? 'seven' : `line ${i}`)));
    r.git('mv', 'src/old name.js', 'src/moved name.js');
    r.write('naïve "q".txt', 'q\n');
    const before = await snap({ mode: 'uncommitted' });
    for (const [k, v] of [['color.ui', 'always'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['core.quotePath', 'true'], ['diff.renames', 'false'], ['diff.context', '10'], ['diff.algorithm', 'patience']]) {
      r.git('config', k, v);
    }
    const after = await snap({ mode: 'uncommitted' });
    assert.equal(after.text, before.text);
    assert.ok(after.text.includes('diff --suiko a/naïve "q".txt b/naïve "q".txt'));
    assert.ok(after.text.includes('diff --suiko a/src/old name.js b/src/moved name.js'));
    assert.ok(!/\x1b\[/.test(after.text));
    // and twice in a row: the same bytes
    assert.deepEqual((await snap({ mode: 'uncommitted' })).buf, after.buf);
  });

  test('a changed binary changes the text (its blob ids are in it)', async () => {
    r.write('img.bin', Buffer.from([0, 1, 2, 3]));
    const a = await snap({ mode: 'uncommitted' });
    r.write('img.bin', Buffer.from([0, 1, 2, 4]));
    const b = await snap({ mode: 'uncommitted' });
    assert.notEqual(a.text, b.text);
    assert.match(a.text, /binary file \(none -> [0-9a-f]{12}\)/);
  });
});
