// @ts-check
// Security of code reviews (design 4.16, 4.17, 8 "Repo reads"): secret-looking untracked files never reach the
// store or the object database, hostile file names (spaces, quotes, shell syntax, leading dashes, newlines) are
// carried or skipped but never interpreted, the repo's hooks / fsmonitor / external diff / textconv never run,
// symlinks are their link text (never their target's bytes), nested stores stay out, the real index is never
// written, and concurrent rounds use separate temp indexes.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/ops.js';
import { takeCodeSnapshot } from '../../src/core/code/snapshot.js';
import { lineDraft, lines, makeRepo, packetOf, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(10) } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * Every file below `dir` whose bytes contain `needle`.
 * @param {string} dir
 * @param {string} needle
 * @returns {string[]}
 */
function filesContaining(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

describe('secrets', () => {
  test('secret-looking untracked files are excluded: not in the round, the store, the home or the object database', async () => {
    const SECRET = 'TOKEN=super-secret-value-123';
    r.write('.env', `${SECRET}\n`);
    r.write('config/.env.production', `${SECRET}\n`);
    r.write('deploy/id_rsa', `${SECRET}\n`);
    r.write('certs/server.pem', `${SECRET}\n`);
    r.write('src/a.js', lines(11));
    const ctx = await r.ctx();
    const res = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    assert.deepEqual(res.code.files.map((f) => f.path), ['src/a.js']);
    assert.deepEqual(res.code.skipped.map((s) => [s.path, s.reason]), [
      ['.env', 'excluded'], ['certs/server.pem', 'excluded'], ['config/.env.production', 'excluded'], ['deploy/id_rsa', 'excluded'],
    ]);
    assert.deepEqual(filesContaining(path.join(r.root, '.specreview'), SECRET), []);
    assert.deepEqual(filesContaining(r.home, SECRET), []);
    const id = r.git('hash-object', '.env');
    assert.throws(() => r.git('cat-file', '-e', id), 'no blob object was written for the secret');
  });
});

describe('hostile file names', () => {
  test('spaces, quotes and shell syntax are carried verbatim; leading dashes and newlines are skipped; nothing runs', async () => {
    const carried = ['with space.js', 'q"uo\'te.js', '$(touch pwned).js', ';rm -rf ~;.js', 'back`tick`.js', 'dir with space/x.js'];
    const skippedNames = ['-rf', '--output=evil.txt', 'dir/-n.js', 'new\nline.js'];
    for (const n of [...carried, ...skippedNames]) r.write(n, `content of ${JSON.stringify(n)}\nsecond line\n`);
    const ctx = await r.ctx();
    const res = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted', paths: undefined } });
    assert.deepEqual(res.code.files.map((f) => f.path).sort(), [...carried].sort());
    const skipped = res.code.skipped.filter((s) => s.reason === 'unsupported-name').map((s) => s.path).sort();
    assert.deepEqual(skipped, ['--output=evil.txt', '-rf', 'dir/-n.js', 'new?line.js']);
    assert.ok(!fs.existsSync(path.join(r.root, 'pwned')) && !fs.existsSync(path.join(r.root, 'evil.txt')));

    // reviewer threads, the packet and apply on such names
    const id = res.doc.id;
    await lineDraft(ctx, id, { file: '$(touch pwned).js', lines: 2, suggestion: 'SECOND', body: 'caps' });
    await lineDraft(ctx, id, { file: 'q"uo\'te.js', lines: 1, body: 'quotes' });
    await submit(ctx, id);
    const { text } = await packetOf(ctx, id);
    assert.match(text, /\$\(touch pwned\)\.js:L2 \(new file\) · apply verbatim/);
    assert.match(text, /q"uo'te\.js:L1 \(new file\)\n  src> content of "q\\"uo'te\.js"/);
    const ap = await ops.applySuggestions(ctx, id, ['t1'], {});
    assert.equal(ap.applied.length, 1);
    assert.equal(r.read('$(touch pwned).js'), 'content of "$(touch pwned).js"\nSECOND\n');
    const rep = /** @type {any} */ (await ops.revise(ctx, id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'ok' } } }));
    assert.equal(rep.version, 2);
    assert.ok(!fs.existsSync(path.join(r.root, 'pwned')));
    // pathspecs that look like options are data
    const limited = await takeCodeSnapshot(ctx, { mode: 'uncommitted', context: 3, paths: ['--all'] }, { dry: true });
    assert.deepEqual(limited.code.files, []);
  });
});

describe('the repository cannot run code', () => {
  test('hooks, fsmonitor, external diff and textconv configured in the repo never run', async () => {
    const marker = path.join(r.base, 'ran');
    const script = path.join(r.base, 'evil.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`, { mode: 0o755 });
    const hooks = path.join(r.root, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const h of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) fs.copyFileSync(script, path.join(hooks, h));
    fs.chmodSync(hooks, 0o755);
    for (const h of fs.readdirSync(hooks)) fs.chmodSync(path.join(hooks, h), 0o755);
    r.git('config', 'core.fsmonitor', script);
    r.git('config', 'diff.external', script);
    r.git('config', 'diff.evil.textconv', script);
    r.git('config', 'core.pager', script);
    r.write('.gitattributes', '* diff=evil\n');
    r.write('src/a.js', lines(11));
    const ctx = await r.ctx();
    const res = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    await ops.docState(ctx, res.doc.id);
    r.write('src/a.js', lines(12));
    await ops.revise(ctx, res.doc.id, { summary: 's' });
    await ops.openCodeReview(ctx, { input: { mode: 'staged' } }).catch(() => null); // nothing staged: exit 4 is fine
    assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  });

  test('the real index is never written by reviews, rounds or dirty checks', async () => {
    r.write('src/a.js', lines(11));
    r.write('untracked.js', 'u\n');
    const idx = path.join(r.root, '.git', 'index');
    const before = fs.readFileSync(idx);
    const ctx = await r.ctx();
    const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    r.write('src/a.js', lines(12));
    await ops.docState(ctx, doc.id);
    await ops.revise(ctx, doc.id, { summary: 's' });
    assert.deepEqual(fs.readFileSync(idx), before);
    assert.equal(r.git('status', '--porcelain', '--', 'untracked.js'), '?? untracked.js');
  });
});

describe('symlinks and stores', () => {
  test('a symlink (to a file or a directory outside) is its link text; target bytes never appear', async () => {
    const outside = path.join(r.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-BYTES\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(r.root, 'link.txt'));
    fs.symlinkSync(outside, path.join(r.root, 'linkdir'));
    const ctx = await r.ctx();
    const res = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    assert.deepEqual(res.code.files.map((f) => [f.path, f.mode?.new]), [['link.txt', '120000'], ['linkdir', '120000']]);
    await lineDraft(ctx, res.doc.id, { file: 'link.txt', lines: 1, body: 'why?' });
    await submit(ctx, res.doc.id);
    const { text } = await packetOf(ctx, res.doc.id);
    assert.ok(!text.includes('OUTSIDE-BYTES'));
    assert.ok(text.includes(`src> ${path.join(outside, 'secret.txt')}`));
    assert.deepEqual(filesContaining(path.join(r.root, '.specreview'), 'OUTSIDE-BYTES'), []);
    // retargeting the link is a change of its text
    fs.unlinkSync(path.join(r.root, 'link.txt'));
    fs.symlinkSync(path.join(outside, 'other.txt'), path.join(r.root, 'link.txt'));
    const rep = /** @type {any} */ (await ops.revise(ctx, res.doc.id, { summary: 'retarget' }));
    assert.equal(rep.version, 2);
  });

  test('nested and root SpecReview stores are never part of a review', async () => {
    r.write('docs/.specreview/docs/x/doc.json', '{"x":1}\n');
    r.write('docs/spec.md', '# spec\n');
    const ctx = await r.ctx();
    const res = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
    assert.deepEqual(res.code.files.map((f) => f.path), ['docs/spec.md']);
    // the root store (created by the review itself) is not either
    r.write('src/a.js', lines(11));
    const rep = /** @type {any} */ (await ops.revise(ctx, res.doc.id, { summary: 's' }));
    assert.deepEqual(rep.manifest.code.files.map((/** @type {any} */ f) => f.path), ['docs/spec.md', 'src/a.js']);
  });

  test('concurrent rounds of two reviews each use their own temp index', async () => {
    r.write('src/a.js', lines(11));
    r.git('add', 'src/a.js');
    r.write('b.js', 'b\n');
    const ctx = await r.ctx();
    const [u, s] = await Promise.all([
      ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } }),
      ops.openCodeReview(ctx, { input: { mode: 'staged' } }),
    ]);
    assert.deepEqual(u.code.files.map((f) => f.path), ['b.js', 'src/a.js']);
    assert.deepEqual(s.code.files.map((f) => f.path), ['src/a.js']);
    r.write('src/a.js', lines(12));
    r.git('add', 'src/a.js');
    const [ru, rs] = await Promise.all([ops.revise(ctx, u.doc.id, { summary: 'u' }), ops.revise(ctx, s.doc.id, { summary: 's' })]);
    assert.equal(/** @type {any} */ (ru).version, 2);
    assert.equal(/** @type {any} */ (rs).version, 2);
    const cache = ctx.store.cacheDir();
    assert.deepEqual(fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => n.startsWith('code-index-')) : [], []);
  });
});
