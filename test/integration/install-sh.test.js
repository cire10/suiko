// @ts-check
// install.sh (repo root): Node version check, checkout vs clone mode (SPECREVIEW_REPO), dependency install, `npm link`
// with the ~/.local/bin shim fallback, and the hand-off to `suiko install` (dry run, or --apply with --yes).
// No network and no real npm: every run gets a temp HOME and a PATH of a fake-bin dir (node -> this node, a fake npm
// that logs its arguments) plus /usr/bin:/bin. Most runs use a stub checkout whose bin/suiko.js logs its argv;
// one runs the real checkout end to end (`--only codex --yes` into the temp HOME).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { PACKAGE_ROOT } = await import('../../src/cli/daemon-client.js');

const SCRIPT = path.join(PACKAGE_ROOT, 'install.sh');
const SH = '/bin/sh';
const skip = process.platform === 'win32' || !fs.existsSync(SH) ? 'needs /bin/sh' : false;

/** @type {string[]} */
const cleanup = [];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (/** @type {string} */ name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sr-installsh-${name}-`)));
  cleanup.push(d);
  return d;
};

const FAKE_NPM = `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> "$NPM_LOG"
case "$1" in
  ci | install)
    if [ -n "\${NPM_CI_FAIL:-}" ] && [ "$1" = ci ]; then echo 'npm error ci failed' >&2; exit 1; fi
    mkdir -p node_modules
    exit 0
    ;;
  link)
    if [ -n "\${NPM_LINK_DIR:-}" ]; then ln -sf "$PWD/bin/suiko.js" "$NPM_LINK_DIR/suiko"; exit 0; fi
    echo 'npm error code EACCES' >&2
    exit 1
    ;;
esac
exit 0
`;

const STUB_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.STUB_ENV_LOG) fs.appendFileSync(process.env.STUB_ENV_LOG, (process.env.SPECREVIEW_NODE || '') + '\\n');
console.log('stub suiko ' + process.argv.slice(2).join(' '));
`;

/**
 * A stub Suiko checkout (package.json named suiko, bin/suiko.js logging its argv, install.sh).
 * @param {string} [dir]
 */
function stubCheckout(dir = tmp('checkout'), name = '@cire10/suiko') {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "${name}",\n  "version": "0.0.0-test"\n}\n`);
  fs.writeFileSync(path.join(dir, 'bin', 'suiko.js'), STUB_CLI, { mode: 0o755 });
  fs.copyFileSync(SCRIPT, path.join(dir, 'install.sh'));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  return dir;
}

/**
 * Temp HOME + fake bin dir; `run(args, { cwd, stdin, env })` runs install.sh with only these variables set.
 * @param {{ node?: string | null }} [o] node: a fake node script instead of a symlink to this node; null: no node
 */
function sandbox(o = {}) {
  const home = tmp('home');
  const bin = tmp('bin');
  const logs = tmp('logs');
  if (o.node === undefined) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  else if (o.node !== null) fs.writeFileSync(path.join(bin, 'node'), o.node, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  const npmLog = path.join(logs, 'npm.log');
  const stubLog = path.join(logs, 'stub.log');
  /** @type {Record<string, string>} */
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NPM_LOG: npmLog, STUB_LOG: stubLog, TMPDIR: logs, SPECREVIEW_HOME: path.join(home, '.specreview') };
  /**
   * @param {string[]} args
   * @param {{ cwd?: string, stdin?: string, env?: Record<string, string>, script?: string }} [x]
   */
  const run = (args, x = {}) => {
    const argv = x.stdin !== undefined ? ['-s', '--', ...args] : [x.script ?? SCRIPT, ...args];
    const r = spawnSync(SH, argv, { cwd: x.cwd ?? home, env: { ...env, ...(x.env ?? {}) }, input: x.stdin, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
  };
  const lines = (/** @type {string} */ f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    home, bin, env, run,
    npmCalls: () => lines(npmLog),
    stubCalls: () => lines(stubLog).map((l) => JSON.parse(l)),
    shim: path.join(home, '.local', 'bin', 'suiko'),
  };
}

describe('install.sh', { skip }, () => {
  test('POSIX sh: #!/bin/sh, executable, parses with sh -n; shellcheck-clean when shellcheck is installed', () => {
    assert.ok(fs.readFileSync(SCRIPT, 'utf8').startsWith('#!/bin/sh\n'));
    assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, 'executable');
    const r = spawnSync(SH, ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const sc = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], { encoding: 'utf8' });
    if (sc.error) return; // shellcheck not installed
    assert.equal(sc.status, 0, sc.stdout);
  });

  test('a checkout is recognised by its package name: @scope/suiko or suiko, not a lookalike', () => {
    for (const [name, ok] of /** @type {Array<[string, boolean]>} */ ([['@cire10/suiko', true], ['suiko', true], ['suiko-fork', false], ['@x/not-suiko', false]])) {
      const s = sandbox();
      const src = stubCheckout(tmp('named'), name);
      const r = s.run([], { script: path.join(src, 'install.sh') });
      if (ok) assert.match(r.stdout, new RegExp(`Suiko checkout: ${src}`), name);
      else {
        assert.equal(r.code, 1, name);
        assert.match(r.stderr, /not run from a Suiko checkout/, name);
      }
    }
  });

  test('checkout: npm ci, npm link fails -> shim in ~/.local/bin, then a dry run of suiko install', () => {
    const s = sandbox();
    const src = stubCheckout();
    const r = s.run([], { script: path.join(src, 'install.sh') });
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, new RegExp(`Suiko checkout: ${src}`));
    assert.deepEqual(s.npmCalls(), [`${src}|ci --no-audit --no-fund`, `${src}|link --no-audit --no-fund`]);
    assert.match(r.stdout, /npm link failed .* using a shim instead/);
    assert.match(r.stderr, /\.local\/bin is not on PATH/);
    assert.deepEqual(s.stubCalls(), [['install']]);
    assert.match(r.stdout, /stub suiko install\n/);
    assert.match(r.stdout, /To write these changes: '.*\/\.local\/bin\/suiko' install --apply {3}\(or: '.*install\.sh' --yes\)/);
    // The shim runs the checkout's CLI with every argument.
    const shimText = fs.readFileSync(s.shim, 'utf8');
    assert.match(shimText, /^#!\/bin\/sh\n# specreview-shim: /);
    const viaShim = spawnSync(s.shim, ['open', 'a b.md'], { env: s.env, encoding: 'utf8' });
    assert.equal(viaShim.status, 0, viaShim.stderr);
    assert.deepEqual(s.stubCalls().at(-1), ['open', 'a b.md']);
    // Re-run with --yes and forwarded options: node_modules is there now, so no npm ci; our shim is rewritten.
    const r2 = s.run(['--only', 'codex,cursor', '--yes'], { script: path.join(src, 'install.sh') });
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.stdout, /node_modules already present/);
    assert.equal(s.npmCalls().filter((c) => c.includes('|ci ')).length, 1);
    assert.deepEqual(s.stubCalls().at(-1), ['install', '--only', 'codex,cursor', '--apply']);
    assert.doesNotMatch(r2.stdout, /To write these changes/);
  });

  test('npm link that works: no shim; npm ci failing falls back to npm install', () => {
    const s = sandbox();
    const src = stubCheckout();
    const r = s.run([], { script: path.join(src, 'install.sh'), env: { NPM_LINK_DIR: s.bin, NPM_CI_FAIL: '1' } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.stderr, /npm ci failed; trying npm install/);
    assert.ok(s.npmCalls().includes(`${src}|install --no-audit --no-fund`));
    assert.match(r.stdout, /Linked suiko with npm link/);
    assert.equal(fs.existsSync(s.shim), false);
    assert.match(r.stdout, /To write these changes: suiko install --apply/);
  });

  test('npm prefix ~/.local: npm links into the shim directory; that link is left alone, and re-runs work', () => {
    const s = sandbox();
    const src = stubCheckout();
    const linkDir = path.join(s.home, '.local', 'bin');
    fs.mkdirSync(linkDir, { recursive: true });
    const envLog = path.join(s.home, 'env.log');
    const env = { NPM_LINK_DIR: linkDir, PATH: `${linkDir}:${s.env.PATH}`, STUB_ENV_LOG: envLog };
    for (const round of [1, 2]) {
      const r = s.run([], { script: path.join(src, 'install.sh'), env });
      assert.equal(r.code, 0, `round ${round}: ${r.out}`);
      assert.match(r.stdout, /Linked suiko with npm link/);
      assert.doesNotMatch(r.out, /was not written by this installer/);
      assert.ok(fs.lstatSync(s.shim).isSymbolicLink(), 'npm\'s link is still there');
      assert.equal(fs.realpathSync(s.shim), path.join(src, 'bin', 'suiko.js'));
      assert.match(r.stdout, /To write these changes: suiko install --apply/);
    }
    assert.deepEqual(s.stubCalls(), [['install'], ['install']]);
    // install.sh hands the node it found on PATH (not its resolved path) to `suiko install`.
    assert.deepEqual(fs.readFileSync(envLog, 'utf8').trim().split('\n'), [path.join(s.bin, 'node'), path.join(s.bin, 'node')]);
  });

  test('a file at the shim path that the installer did not write is never replaced', () => {
    const s = sandbox();
    const src = stubCheckout();
    fs.mkdirSync(path.dirname(s.shim), { recursive: true });
    fs.writeFileSync(s.shim, '#!/bin/sh\necho mine\n');
    const r = s.run([], { script: path.join(src, 'install.sh') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /suiko exists and was not written by this installer/);
    assert.equal(fs.readFileSync(s.shim, 'utf8'), '#!/bin/sh\necho mine\n');
    assert.deepEqual(s.stubCalls(), []);
  });

  test('curl | sh: clones SPECREVIEW_REPO into ~/.specreview/app, npm ci --omit=dev, then runs the installer', () => {
    const s = sandbox();
    const repo = stubCheckout(tmp('repo'));
    const git = (/** @type {string[]} */ args) => {
      const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8', env: { ...s.env, GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(g.status, 0, g.stderr);
    };
    git(['init', '-q']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'stub']);
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const cwd = tmp('cwd');
    const env = { SPECREVIEW_REPO: repo, GIT_CONFIG_NOSYSTEM: '1' };
    const r = s.run(['--yes'], { stdin: script, cwd, env });
    assert.equal(r.code, 0, r.out);
    const app = path.join(s.home, '.specreview', 'app');
    assert.match(r.stdout, new RegExp(`Cloning ${repo} into ${app}`));
    assert.ok(fs.existsSync(path.join(app, 'bin', 'suiko.js')));
    assert.deepEqual(s.npmCalls(), [`${app}|ci --omit=dev --no-audit --no-fund`, `${app}|link --no-audit --no-fund`]);
    assert.ok(fs.readFileSync(s.shim, 'utf8').includes(path.join(app, 'bin', 'suiko.js')));
    assert.deepEqual(s.stubCalls(), [['install', '--apply']]);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written to the current directory');
    // Re-run: the clone is updated (fast-forward), not re-cloned.
    const r2 = s.run([], { stdin: script, cwd, env });
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.stdout, new RegExp(`Updating ${app}`));
    assert.match(r2.stdout, /To write these changes: '.*suiko' install --apply\n$/);
    // A clone of another repository is not touched.
    const r3 = s.run([], { stdin: script, cwd, env: { ...env, SPECREVIEW_REPO: `${repo}-other` } });
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /is a clone of .*, not .*-other; move it away or set SPECREVIEW_APP_DIR/);
  });

  test('curl | sh: a clone pinned with SPECREVIEW_REF moves back to the default branch on a later run without it', () => {
    const s = sandbox();
    const repo = stubCheckout(tmp('repo'));
    const git = (/** @type {string[]} */ args, cwd = repo) => {
      const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...args], { cwd, encoding: 'utf8', env: { ...s.env, GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(g.status, 0, g.stderr);
      return g.stdout.trim();
    };
    git(['init', '-q']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'v1']);
    git(['tag', 'v1']);
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const cwd = tmp('cwd');
    const env = { SPECREVIEW_REPO: repo, GIT_CONFIG_NOSYSTEM: '1' };
    const app = path.join(s.home, '.specreview', 'app');
    const r1 = s.run([], { stdin: script, cwd, env: { ...env, SPECREVIEW_REF: 'v1' } });
    assert.equal(r1.code, 0, r1.out);
    assert.equal(git(['rev-parse', 'HEAD'], app), git(['rev-parse', 'v1']));
    fs.writeFileSync(path.join(repo, 'NEWS.md'), 'v2\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'v2']);
    const r2 = s.run([], { stdin: script, cwd, env });
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.stdout, /pinned to a tag or commit; moving it to the repository's default branch/);
    assert.equal(git(['rev-parse', 'HEAD'], app), git(['rev-parse', 'HEAD']), 'the clone is at the default branch tip');
    assert.ok(fs.existsSync(path.join(app, 'NEWS.md')));
  });

  test('curl | sh without SPECREVIEW_REPO explains that there is no public download', () => {
    const s = sandbox();
    const r = s.run([], { stdin: fs.readFileSync(SCRIPT, 'utf8'), cwd: tmp('cwd') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not run from a Suiko checkout, and SPECREVIEW_REPO is not set/);
    assert.deepEqual(s.npmCalls(), []);
  });

  test('Node.js older than 20.19, or missing, is refused before anything is written', () => {
    for (const [version, ok] of [['18.20.0', false], ['20.18.1', false], ['20.19.0', true], ['22.1.0', true]]) {
      const s = sandbox({ node: `#!/bin/sh\nif [ "$1" = -p ]; then echo ${version}; exit 0; fi\nexec "${process.execPath}" "$@"\n` });
      const src = stubCheckout();
      const r = s.run([], { script: path.join(src, 'install.sh') });
      if (ok) {
        assert.equal(r.code, 0, `${version}: ${r.out}`);
      } else {
        assert.equal(r.code, 1, version);
        assert.match(r.stderr, new RegExp(`Node\\.js 20\\.19 or newer is required; .* is ${version.replace(/\./g, '\\.')}`));
        assert.deepEqual(s.npmCalls(), []);
        assert.equal(fs.existsSync(s.shim), false);
      }
    }
    const none = sandbox({ node: null });
    const r = none.run([], { script: path.join(stubCheckout(), 'install.sh') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /node is not on PATH/);
  });

  test('end to end from this checkout: --only codex --yes configures Codex in the temp HOME', { skip: !fs.existsSync(path.join(PACKAGE_ROOT, 'node_modules')) && 'needs node_modules' }, () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.codex', 'sessions'), { recursive: true });
    const r = s.run(['--only', 'codex', '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(s.npmCalls(), [`${PACKAGE_ROOT}|link --no-audit --no-fund`], 'node_modules present: only npm link (which fails here)');
    assert.match(r.stdout, /Suiko install: applied \(user scope\)/);
    assert.match(fs.readFileSync(path.join(s.home, '.codex', 'AGENTS.md'), 'utf8'), /^<!-- specreview:begin/);
    assert.match(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.suiko\]/);
    // ~/.local/bin is not on PATH, so the instructions carry the absolute invocation.
    assert.match(fs.readFileSync(path.join(s.home, '.codex', 'AGENTS.md'), 'utf8'), /On this machine `suiko` is not on PATH/);
    const viaShim = spawnSync(s.shim, ['uninstall', '--only', 'codex', '--apply'], { env: s.env, encoding: 'utf8' });
    assert.equal(viaShim.status, 0, viaShim.stderr);
    assert.equal(fs.existsSync(path.join(s.home, '.codex', 'AGENTS.md')), false);
  });
});
