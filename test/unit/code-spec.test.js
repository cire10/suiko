// @ts-check
// Review specs (design 4.2): the default mode and default base detection (code.defaultBase, origin/HEAD, local
// main/master/trunk/develop, none), every explicit mode, refs that do not exist (exit 4), the origin key, doc ids
// and the labels.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, UsageError } from '../../src/core/store/errors.js';
import { openRepo } from '../../src/core/code/git.js';
import { baseName, detectDefaultBase, docIdFor, isFixedEndpoint, packetLabel, resolveSpec, specKey, specLabel } from '../../src/core/code/spec.js';
import { lines, makeRepo } from '../helpers/git-repo.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
/** @type {string} */
let c1;
/** @type {string} */
let c2;
before(async () => {
  r = await makeRepo({ files: { 'a.txt': lines(3) } });
  c1 = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', '-b', 'feat/Token_Refresh');
  r.write('a.txt', lines(4));
  c2 = r.commit('two');
});
after(async () => {
  await r.cleanup();
});

describe('default mode and base', () => {
  test('on a feature branch with a local main: since-base main; on main itself: uncommitted', async () => {
    const repo = await openRepo(r.root);
    assert.deepEqual(await resolveSpec(repo, {}, {}), { mode: 'since-base', base: 'main', context: 3 });
    r.git('checkout', '-q', 'main');
    try {
      assert.deepEqual(await resolveSpec(repo, {}, {}), { mode: 'uncommitted', context: 3 });
    } finally {
      r.git('checkout', '-q', 'feat/Token_Refresh');
    }
  });

  test('origin/HEAD wins over local branches (verified); code.defaultBase wins over both and must exist', async () => {
    const repo = await openRepo(r.root);
    r.git('update-ref', 'refs/remotes/origin/develop', c1);
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    try {
      assert.equal(await detectDefaultBase(repo, {}), 'origin/develop');
      assert.equal(await detectDefaultBase(repo, { code: { defaultBase: 'main' } }), 'main');
      await assert.rejects(detectDefaultBase(repo, { code: { defaultBase: 'nope' } }), NotFoundError);
      // a dangling origin/HEAD is ignored
      r.git('update-ref', '-d', 'refs/remotes/origin/develop');
      assert.equal(await detectDefaultBase(repo, {}), 'main');
    } finally {
      r.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    }
  });

  test('detached HEAD, an unborn HEAD or no base at all: uncommitted', async () => {
    const repo = await openRepo(r.root);
    r.git('checkout', '-q', '--detach');
    try {
      assert.equal((await resolveSpec(repo, {}, {})).mode, 'uncommitted');
    } finally {
      r.git('checkout', '-q', 'feat/Token_Refresh');
    }
    const unborn = await makeRepo();
    try {
      assert.equal((await resolveSpec(await openRepo(unborn.root), {}, {})).mode, 'uncommitted');
    } finally {
      await unborn.cleanup();
    }
    const lone = await makeRepo({ files: { x: 'x\n' } });
    try {
      lone.git('branch', '-m', 'main', 'work');
      const repo2 = await openRepo(lone.root);
      assert.equal(await detectDefaultBase(repo2, {}), null);
      assert.equal((await resolveSpec(repo2, {}, {})).mode, 'uncommitted');
      await assert.rejects(resolveSpec(repo2, { mode: 'since-base' }, {}), (e) => e instanceof NotFoundError && /pass --base/.test(e.message));
    } finally {
      await lone.cleanup();
    }
  });
});

describe('explicit modes', () => {
  test('each mode resolves; context and paths are kept', async () => {
    const repo = await openRepo(r.root);
    assert.deepEqual(await resolveSpec(repo, { mode: 'uncommitted', paths: ['src'], context: 5 }, {}), { mode: 'uncommitted', context: 5, paths: ['src'] });
    assert.deepEqual(await resolveSpec(repo, { mode: 'staged' }, { code: { context: 7 } }), { mode: 'staged', context: 7 });
    assert.deepEqual(await resolveSpec(repo, { mode: 'since-base', base: 'main' }, {}), { mode: 'since-base', base: 'main', context: 3 });
    assert.deepEqual(await resolveSpec(repo, { mode: 'branch', base: 'main' }, {}), { mode: 'branch', base: 'main', context: 3 });
    assert.deepEqual(await resolveSpec(repo, { mode: 'range', range: 'main..HEAD' }, {}), { mode: 'range', from: 'main', to: 'HEAD', context: 3 });
    assert.deepEqual(await resolveSpec(repo, { mode: 'range', range: 'main...HEAD' }, {}), { mode: 'range', from: 'main', to: 'HEAD', threeDot: true, context: 3 });
    assert.deepEqual(await resolveSpec(repo, { mode: 'commit', commit: c2.slice(0, 9) }, {}), { mode: 'commit', commit: c2, context: 3 });
  });

  test('a base, range end or commit that does not exist is NotFoundError (exit 4); malformed input UsageError', async () => {
    const repo = await openRepo(r.root);
    await assert.rejects(resolveSpec(repo, { mode: 'since-base', base: 'nope' }, {}), (e) => e instanceof NotFoundError && /base not found/.test(e.message));
    await assert.rejects(resolveSpec(repo, { mode: 'range', range: 'main..nope' }, {}), (e) => e instanceof NotFoundError && /range end not found/.test(e.message));
    await assert.rejects(resolveSpec(repo, { mode: 'range', range: 'nope..main' }, {}), (e) => e instanceof NotFoundError && /range start/.test(e.message));
    await assert.rejects(resolveSpec(repo, { mode: 'commit', commit: 'deadbeef' }, {}), (e) => e instanceof NotFoundError && /commit not found/.test(e.message));
    await assert.rejects(resolveSpec(repo, { mode: 'range', range: 'main' }, {}), UsageError);
    await assert.rejects(resolveSpec(repo, { mode: 'pr' }, {}), UsageError);
    // a revision that looks like an option is never taken as one
    await assert.rejects(resolveSpec(repo, { mode: 'commit', commit: '--all' }, {}), NotFoundError);
  });
});

describe('identity and labels', () => {
  test('origin keys and doc ids', () => {
    const cases = /** @type {Array<[any, string, string]>} */ ([
      [{ mode: 'since-base', base: 'origin/main' }, 'diff:since-base:origin/main', 'cr-feat-token-refresh'],
      [{ mode: 'branch', base: 'main' }, 'diff:branch:main', 'cr-feat-token-refresh'],
      [{ mode: 'uncommitted' }, 'diff:uncommitted', 'cr-uncommitted'],
      [{ mode: 'staged', paths: ['src', 'lib'] }, 'diff:staged+paths=lib,src', 'cr-staged'],
      [{ mode: 'range', from: 'main', to: 'HEAD' }, 'diff:range:main..HEAD', 'cr-main-head'],
      [{ mode: 'range', from: 'v1.0', to: 'v2.0', threeDot: true }, 'diff:range:v1.0...v2.0', 'cr-v1-0-v2-0'],
      [{ mode: 'commit', commit: 'abcdef0123456789abcdef0123456789abcdef01' }, 'diff:commit:abcdef0123456789abcdef0123456789abcdef01', 'cr-abcdef0'],
    ]);
    for (const [spec, key, id] of cases) {
      assert.equal(specKey(spec), key);
      assert.equal(docIdFor(spec, 'feat/Token_Refresh'), id);
    }
    assert.equal(docIdFor({ mode: 'since-base', base: 'main' }, null), 'cr-head');
  });

  test('labels, base names and fixed endpoints', () => {
    const code = /** @type {any} */ ({ baseSha: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d', newSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', newSide: 'worktree' });
    assert.equal(specLabel({ mode: 'since-base', base: 'origin/main' }, code), 'since-base origin/main (merge-base 1a2b3c4) .. working tree');
    assert.equal(specLabel({ mode: 'staged' }, { ...code, newSide: 'index' }), 'staged HEAD 1a2b3c4 .. index');
    assert.equal(specLabel({ mode: 'uncommitted' }, { ...code, baseSha: EMPTY_TREE }), 'uncommitted (no commits yet) .. working tree');
    assert.equal(specLabel({ mode: 'uncommitted', paths: ['src'] }, code), 'uncommitted HEAD 1a2b3c4 .. working tree · paths: src');
    assert.equal(packetLabel({ mode: 'since-base', base: 'origin/main' }, code), 'since-base origin/main, merge-base 1a2b3c4');
    assert.equal(packetLabel({ mode: 'commit', commit: code.newSha }, code), 'commit 9f8e7d6, now the working tree');
    assert.equal(baseName('uncommitted', code.baseSha), 'HEAD 1a2b3c4');
    assert.equal(baseName('commit', code.baseSha), 'parent 1a2b3c4');
    assert.equal(baseName('range', code.baseSha), 'range start 1a2b3c4');
    assert.equal(baseName('range', code.baseSha, true), 'merge-base 1a2b3c4');
    assert.equal(baseName('commit', EMPTY_TREE), '(empty tree)');
    assert.ok(isFixedEndpoint({ mode: 'commit', commit: code.newSha }));
    assert.ok(isFixedEndpoint({ mode: 'range', from: 'main', to: '9f8e7d6' }));
    assert.ok(!isFixedEndpoint({ mode: 'range', from: 'main', to: 'HEAD' }));
  });
});
