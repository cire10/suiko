// @ts-check
// The git layer of code reviews (design 4.3) against real temp repositories: the scrubbed environment, opening a
// repository (not a repo, a subdirectory, git too old with a fake git on PATH), raw diff records with renames,
// untracked names as raw bytes, the temp index that never writes the real one, blob reads, and the name rules.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageError, RefusedError } from '../../src/core/store/errors.js';
import { checkGitVersion, compareVersions, gitEnv, literal, looksSecret, openRepo, supportedName } from '../../src/core/code/git.js';
import { lines, makeRepo } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
before(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(30), 'docs/readme.md': '# readme\n' } });
});
after(async () => {
  await r.cleanup();
});

describe('git environment', () => {
  test('variables that would redirect git are removed; prompts and optional locks are off', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_DIR: '/elsewhere', GIT_WORK_TREE: '/w', GIT_INDEX_FILE: '/i', GIT_CONFIG_PARAMETERS: "'core.pager=evil'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'evil', GIT_EXTERNAL_DIFF: 'evil' });
      const env = gitEnv(undefined);
      for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF']) assert.equal(env[k], undefined, k);
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(env.LC_ALL, 'C');
      assert.equal(gitEnv('/tmp/idx').GIT_INDEX_FILE, '/tmp/idx');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test('GIT_DIR in the environment does not redirect a review to another repository', async () => {
    const other = await makeRepo({ files: { 'x.txt': 'x\n' } });
    process.env.GIT_DIR = path.join(other.root, '.git');
    try {
      const repo = await openRepo(r.root);
      assert.equal(repo.root, r.root);
      assert.ok(await repo.verifyCommit('HEAD'));
      assert.equal((await repo.lsTree('HEAD', ['src/a.js'])).size, 1);
    } finally {
      delete process.env.GIT_DIR;
      await other.cleanup();
    }
  });
});

describe('openRepo', () => {
  test('the top level opens; a subdirectory is refused unless allowed; a non-repository is a usage error', async () => {
    assert.equal((await openRepo(r.root)).root, r.root);
    await assert.rejects(openRepo(path.join(r.root, 'src')), (e) => e instanceof UsageError && /repository root/.test(e.message));
    assert.equal((await openRepo(path.join(r.root, 'src'), { allowSubdir: true })).root, r.root);
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-nogit-'));
    try {
      await assert.rejects(openRepo(plain), (e) => e instanceof UsageError && /not inside a git repository/.test(e.message));
    } finally {
      await fsp.rm(plain, { recursive: true, force: true });
    }
  });

  test('git older than GIT_MIN_VERSION (a fake git on PATH) is a usage error naming the minimum', async () => {
    const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-fakegit-'));
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "git version 2.20.1"\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      await assert.rejects(checkGitVersion(r.root), (e) => e instanceof UsageError && /git 2\.20\.1 is too old/.test(e.message) && /2\.32\.0/.test(e.message));
    } finally {
      process.env.PATH = savedPath;
      await fsp.rm(bin, { recursive: true, force: true });
    }
    assert.equal(compareVersions('2.32.0', '2.32.0'), 0);
    assert.equal(compareVersions('2.4.0', '2.32.0'), -1);
    assert.equal(compareVersions('3.0', '2.99.9'), 1);
  });
});

describe('Repo', () => {
  test('diffTrees: raw records with modes, ids and paired renames', async () => {
    const repo = await openRepo(r.root);
    const base = await repo.treeOf('HEAD');
    r.git('mv', 'docs/readme.md', 'docs/README.md');
    r.write('src/a.js', lines(30, (i) => (i === 5 ? 'five' : `line ${i}`)));
    r.write('src/new.js', 'new\n');
    const tree = await repo.worktreeTree(/** @type {any} */ ({ cacheDir: () => path.join(r.base, 'cache') }), [Buffer.from('.')]);
    const recs = await repo.diffTrees(base, tree, []);
    const byPath = Object.fromEntries(recs.map((x) => [x.path.toString(), x]));
    assert.equal(byPath['src/a.js'].status, 'M');
    assert.equal(byPath['src/new.js'].status, 'A');
    assert.equal(byPath['docs/README.md'].status, 'R');
    assert.equal(byPath['docs/README.md'].oldPath?.toString(), 'docs/readme.md');
    assert.match(byPath['src/a.js'].newId, /^[0-9a-f]{40}$/);
    assert.equal(byPath['src/a.js'].newMode, '100644');
    r.git('reset', '-q', '--hard');
    r.rm('src/new.js');
  });

  test('the working tree tree comes from a temp index: the real index is never written', async () => {
    const repo = await openRepo(r.root);
    const idx = await repo.indexPath();
    const before = fs.readFileSync(idx);
    const mtime = fs.statSync(idx).mtimeMs;
    r.write('untracked one.txt', 'u\n');
    r.write('src/a.js', `${r.read('src/a.js')}more\n`);
    const store = { cacheDir: () => path.join(r.base, 'cache') };
    const tree = await repo.worktreeTree(/** @type {any} */ (store), [Buffer.from('.')]);
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(fs.readFileSync(idx), before);
    assert.equal(fs.statSync(idx).mtimeMs, mtime);
    assert.equal(r.git('status', '--porcelain', '--', 'untracked one.txt'), '?? "untracked one.txt"');
    // the temp dir is gone
    assert.deepEqual(fs.readdirSync(path.join(r.base, 'cache')).filter((n) => n.startsWith('code-index-')), []);
    r.git('checkout', '-q', '--', 'src/a.js');
    r.rm('untracked one.txt');
  });

  test('a split index: the temp index adds and prunes no shared index, so the real index stays readable', async () => {
    const s = await makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    try {
      s.git('config', 'core.splitIndex', 'true');
      s.git('config', 'splitIndex.sharedIndexExpire', 'now');
      s.git('update-index', '--split-index');
      const shared = () => fs.readdirSync(path.join(s.root, '.git')).filter((n) => n.startsWith('sharedindex.'));
      const before = shared();
      assert.equal(before.length, 1);
      s.write('a.txt', 'a\nmore\n');
      s.write('c.txt', 'new\n');
      const repo = await openRepo(s.root);
      const tree = await repo.worktreeTree(/** @type {any} */ ({ cacheDir: () => path.join(s.base, 'cache') }), [Buffer.from('.')]);
      assert.match(tree, /^[0-9a-f]{40}$/);
      assert.deepEqual(shared(), before);
      assert.equal(s.git('status', '--porcelain'), 'M a.txt\n?? c.txt', 'the real index still reads (git trims the first space)');
    } finally {
      await s.cleanup();
    }
  });

  test('a same-size edit in the index\'s own second is seen (the temp index keeps the real one\'s timestamps)', async () => {
    const repo = await openRepo(r.root);
    const file = path.join(r.root, 'src/a.js');
    const st = fs.statSync(file);
    const text = r.read('src/a.js');
    r.write('src/a.js', text.replace('line 7', 'LINE 7'));
    // the cached stat of the entry matches the file again, and the index is racy (same mtime as the file)
    fs.utimesSync(file, st.atime, st.mtime);
    fs.utimesSync(await repo.indexPath(), st.atime, st.mtime);
    await new Promise((res) => setTimeout(res, 1100)); // a fresh copy of the index would now be a second newer
    const tree = await repo.worktreeTree(/** @type {any} */ ({ cacheDir: () => path.join(r.base, 'cache') }), [Buffer.from('.')]);
    const recs = await repo.diffTrees(await repo.treeOf('HEAD'), tree, []);
    assert.deepEqual(recs.map((x) => x.path.toString()), ['src/a.js']);
    r.git('checkout', '-q', '--', 'src/a.js');
  });

  test('untracked names are raw bytes (spaces, quotes, newlines kept as they are)', async () => {
    const repo = await openRepo(r.root);
    const names = ['with space.txt', 'q"uote\'s.txt', 'new\nline.txt', '-dash.txt'];
    for (const n of names) r.write(n, 'x\n');
    try {
      const got = (await repo.untracked([])).map((b) => b.toString('utf8')).sort();
      assert.deepEqual(got, [...names].sort());
    } finally {
      for (const n of names) r.rm(n);
    }
  });

  test('blobs: contents up to maxBytes, sizes beyond it, missing ids', async () => {
    const repo = await openRepo(r.root);
    const ids = await repo.lsTree('HEAD', ['src/a.js', 'docs/readme.md']);
    const a = /** @type {any} */ (ids.get('src/a.js')).id;
    const d = /** @type {any} */ (ids.get('docs/readme.md')).id;
    const missing = '0123456789012345678901234567890123456789';
    const out = await repo.blobs([a, d, missing], 20);
    assert.equal(out.get(d)?.buf?.toString(), '# readme\n');
    assert.equal(out.get(a)?.buf, null);
    assert.equal(out.get(a)?.size, Buffer.byteLength(lines(30)));
    assert.equal(out.get(missing)?.missing, true);
  });

  test('unmerged index entries refuse the index tree (staged mode)', async () => {
    const m = await makeRepo({ files: { 'c.txt': 'base\n' } });
    try {
      m.git('checkout', '-q', '-b', 'other');
      m.write('c.txt', 'other\n');
      m.commit('other');
      m.git('checkout', '-q', 'main');
      m.write('c.txt', 'main\n');
      m.commit('main');
      try {
        m.git('merge', '-q', 'other');
      } catch {
        // conflict expected
      }
      const repo = await openRepo(m.root);
      await assert.rejects(repo.indexTree(/** @type {any} */ ({ cacheDir: () => path.join(m.base, 'cache') })), (e) => e instanceof RefusedError && /unmerged/.test(e.message));
    } finally {
      await m.cleanup();
    }
  });
});

describe('names', () => {
  test('supportedName: UTF-8 without control characters or a leading dash in any component', () => {
    for (const ok of ['a.js', 'with space.js', 'q"uote\'s.js', 'dir/x-y.js', 'unicodé/ß.md']) assert.equal(supportedName(Buffer.from(ok)), ok);
    for (const bad of ['new\nline', 'tab\there', '-rf', 'dir/--output=x', 'del\x7f']) assert.equal(supportedName(Buffer.from(bad)), null, JSON.stringify(bad));
    assert.equal(supportedName(Buffer.from([0x61, 0xff, 0x62])), null);
  });

  test('looksSecret and literal pathspecs', () => {
    for (const p of ['.env', 'config/.env.local', 'certs/server.pem', 'k.key', 'a.p12', 'b.pfx', '.ssh/id_rsa', 'id_ed25519.pub']) assert.ok(looksSecret(p), p);
    for (const p of ['env.js', 'src/key.js', 'pem.md', 'docs/identity.md']) assert.ok(!looksSecret(p), p);
    assert.equal(literal('*.js'), ':(literal)*.js');
  });
});
