// @ts-check
// Unit tests for src/core/store/workspace.js (discovery order, $HOME / '/' refusal, explicit roots, store init)
// and src/core/store/home.js (SPECREVIEW_HOME, daemon.json mode, workspace registry).

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-ws-')));
const HOME = path.join(TMP, 'home');
const FAKE_USER_HOME = path.join(TMP, 'user');
process.env.SPECREVIEW_HOME = HOME;
const REAL_HOME_ENV = process.env.HOME;
after(() => {
  process.env.HOME = REAL_HOME_ENV;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { findWorkspace, discoverRoot, isForbiddenRoot, initStoreDir, STORE_GITIGNORE } = await import(
  '../../src/core/store/workspace.js'
);
const home = await import('../../src/core/store/home.js');
const { RefusedError, NotFoundError } = await import('../../src/core/store/errors.js');
const { sha256 } = await import('../../src/core/util/hash.js');

/**
 * Creates a file with parents.
 * @param {string} p
 * @param {string} [content]
 */
function touch(p, content = '# spec\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

let n = 0;
const sandbox = () => {
  const dir = path.join(TMP, `s${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('findWorkspace', () => {
  beforeEach(() => {
    process.env.HOME = FAKE_USER_HOME;
    fs.mkdirSync(FAKE_USER_HOME, { recursive: true });
  });

  test('falls back to the file directory when there is no store and no git', async () => {
    const dir = sandbox();
    const file = touch(path.join(dir, 'a', 'spec.md'));
    const ws = await findWorkspace(file);
    assert.equal(ws.root, path.join(dir, 'a'));
    assert.equal(ws.storeDir, path.join(dir, 'a', '.specreview'));
    assert.equal(ws.wsId, sha256(ws.root).slice(0, 8));
    assert.equal(ws.foundBy, 'file');
    assert.equal(ws.exists, false);
  });

  test('uses the git toplevel (a .git directory or a worktree .git file)', async () => {
    const repo = sandbox();
    fs.mkdirSync(path.join(repo, '.git'));
    const file = touch(path.join(repo, 'docs', 'specs', 'spec.md'));
    const ws = await findWorkspace(file);
    assert.equal(ws.root, repo);
    assert.equal(ws.foundBy, 'git');

    const worktree = sandbox();
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere\n');
    assert.equal((await findWorkspace(touch(path.join(worktree, 'x', 'y.md')))).root, worktree);
  });

  test('the nearest .specreview ancestor wins over git, and nested stores win over outer ones', async () => {
    const repo = sandbox();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'docs', '.specreview'), { recursive: true });
    const file = touch(path.join(repo, 'docs', 'specs', 'spec.md'));
    const ws = await findWorkspace(file);
    assert.equal(ws.root, path.join(repo, 'docs'));
    assert.equal(ws.foundBy, 'store');
    assert.equal(ws.exists, true);

    fs.mkdirSync(path.join(repo, 'docs', 'specs', '.specreview'));
    assert.equal((await findWorkspace(file)).root, path.join(repo, 'docs', 'specs'));
  });

  test('a directory argument is its own fallback root', async () => {
    const dir = sandbox();
    const ws = await findWorkspace(dir);
    assert.equal(ws.root, dir);
  });

  test('a missing file is NotFound', async () => {
    await assert.rejects(findWorkspace(path.join(TMP, 'nope', 'spec.md')), NotFoundError);
  });

  test('refuses the home directory as root (dotfiles repo) unless the root is explicit', async () => {
    fs.mkdirSync(path.join(FAKE_USER_HOME, '.git'), { recursive: true });
    const file = touch(path.join(FAKE_USER_HOME, 'notes', 'spec.md'));
    try {
      await assert.rejects(findWorkspace(file), (err) => {
        assert.ok(err instanceof RefusedError);
        assert.equal(err.exit, 3);
        assert.match(err.message, /home directory/);
        assert.match(err.message, /--workspace/);
        return true;
      });
      const ws = await findWorkspace(file, { explicitRoot: true, create: true });
      assert.equal(ws.root, path.join(FAKE_USER_HOME, 'notes'));
      assert.ok(fs.statSync(path.join(FAKE_USER_HOME, 'notes', '.specreview')).isDirectory());
      assert.equal(fs.existsSync(path.join(FAKE_USER_HOME, '.specreview', 'config.json')), false);
    } finally {
      fs.rmSync(path.join(FAKE_USER_HOME, '.git'), { recursive: true, force: true });
      fs.rmSync(path.join(FAKE_USER_HOME, 'notes'), { recursive: true, force: true });
    }
  });

  test('~/.specreview (the runtime home location) is never treated as a workspace store', async () => {
    fs.mkdirSync(path.join(FAKE_USER_HOME, '.specreview', 'ws'), { recursive: true });
    const file = touch(path.join(FAKE_USER_HOME, 'proj', 'spec.md'));
    try {
      const ws = await findWorkspace(file);
      assert.equal(ws.root, path.join(FAKE_USER_HOME, 'proj'));
      assert.equal(ws.foundBy, 'file');
    } finally {
      fs.rmSync(path.join(FAKE_USER_HOME, '.specreview'), { recursive: true, force: true });
      fs.rmSync(path.join(FAKE_USER_HOME, 'proj'), { recursive: true, force: true });
    }
  });

  test('an explicit root directory overrides discovery, must contain the file, and never is $HOME', async () => {
    const repo = sandbox();
    fs.mkdirSync(path.join(repo, '.git'));
    const file = touch(path.join(repo, 'a', 'b', 'spec.md'));
    const ws = await findWorkspace(file, { explicitRoot: path.join(repo, 'a') });
    assert.equal(ws.root, path.join(repo, 'a'));
    assert.equal(ws.foundBy, 'explicit');
    await assert.rejects(findWorkspace(file, { explicitRoot: sandbox() }), RefusedError);
    await assert.rejects(findWorkspace(file, { explicitRoot: path.join(TMP, 'missing') }), NotFoundError);

    const inHome = touch(path.join(FAKE_USER_HOME, 'h', 'spec.md'));
    const viaHome = await findWorkspace(inHome, { explicitRoot: FAKE_USER_HOME });
    assert.equal(viaHome.root, path.join(FAKE_USER_HOME, 'h'));
  });

  test('isForbiddenRoot', () => {
    assert.equal(isForbiddenRoot('/'), true);
    assert.equal(isForbiddenRoot(FAKE_USER_HOME), true);
    assert.equal(isForbiddenRoot(TMP), false);
  });

  test('discoverRoot reports the rule used', () => {
    const dir = sandbox();
    assert.deepEqual(discoverRoot(dir), { root: dir, foundBy: 'file' });
  });

  test('create initialises .gitignore, config.json, docs/ and assets/ without overwriting', async () => {
    const dir = sandbox();
    const file = touch(path.join(dir, 'spec.md'));
    const ws = await findWorkspace(file, { create: true });
    assert.equal(ws.exists, true);
    assert.equal(fs.readFileSync(path.join(ws.storeDir, '.gitignore'), 'utf8'), STORE_GITIGNORE);
    assert.equal(STORE_GITIGNORE, '*.tmp-*\n');
    const cfg = JSON.parse(fs.readFileSync(path.join(ws.storeDir, 'config.json'), 'utf8'));
    assert.equal(cfg.schema, 1);
    assert.equal(cfg.guards.maxRewriteRatio, 0.5);
    assert.equal(cfg.reviewer, undefined, 'reviewer name is not committed');
    assert.ok(fs.statSync(path.join(ws.storeDir, 'docs')).isDirectory());
    assert.ok(fs.statSync(path.join(ws.storeDir, 'assets')).isDirectory());
    fs.writeFileSync(path.join(ws.storeDir, 'config.json'), '{"schema":1,"git":{"autoCommit":true}}\n');
    await initStoreDir(ws.root);
    assert.match(fs.readFileSync(path.join(ws.storeDir, 'config.json'), 'utf8'), /autoCommit":true/);
  });
});

describe('home', () => {
  test('homeDir honours SPECREVIEW_HOME', () => {
    assert.equal(home.homeDir(), HOME);
    assert.equal(home.homePath('daemon.log'), path.join(HOME, 'daemon.log'));
    assert.equal(home.daemonLogPath(), path.join(HOME, 'daemon.log'));
  });

  test('daemon info round-trips with mode 0600', async () => {
    assert.equal(await home.readDaemonInfo(), null);
    const info = { pid: 1, uiPort: 5801, contentPort: 5802, token: 't', secret: 's', version: '0.1.0', startedAt: 'x' };
    await home.writeDaemonInfo(info);
    assert.deepEqual(await home.readDaemonInfo(), info);
    assert.equal(fs.statSync(path.join(HOME, 'daemon.json')).mode & 0o777, 0o600);
    await home.removeDaemonInfo();
    assert.equal(await home.readDaemonInfo(), null);
  });

  test('registerWorkspace is idempotent; workspaceRoot and listWorkspaces', async () => {
    const a = sandbox();
    const b = sandbox();
    fs.mkdirSync(path.join(a, '.specreview'));
    const idA = await home.registerWorkspace(a);
    assert.equal(idA, sha256(a).slice(0, 8));
    assert.equal(idA, home.wsIdOf(a));
    const before = fs.statSync(path.join(HOME, 'workspaces.json')).mtimeMs;
    assert.equal(await home.registerWorkspace(a), idA);
    assert.equal(fs.statSync(path.join(HOME, 'workspaces.json')).mtimeMs, before, 'no rewrite when unchanged');
    const idB = await home.registerWorkspace(b);
    assert.equal(await home.workspaceRoot(idA), a);
    assert.equal(await home.workspaceRoot('ffffffff'), null);
    const list = await home.listWorkspaces();
    const byId = Object.fromEntries(list.map((w) => [w.wsId, w]));
    assert.equal(byId[idA].exists, true);
    assert.equal(byId[idB].exists, false);
    assert.deepEqual(list.map((w) => w.root), [...list.map((w) => w.root)].sort());
  });

  test('concurrent registrations of different workspaces are all kept', async () => {
    const roots = Array.from({ length: 6 }, () => sandbox());
    const ids = await Promise.all(roots.map((r) => home.registerWorkspace(r)));
    for (const [i, id] of ids.entries()) assert.equal(await home.workspaceRoot(id), roots[i]);
  });
});
