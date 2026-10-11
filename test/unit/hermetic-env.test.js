// @ts-check
// test/helpers/hermetic-env.js (design 2.15): the env a spawned test process gets is complete and isolated (homes in
// the temp dir, a fake-bin PATH, no inherited GIT_* / CLAUDE* / CODEX*, git without global or system config, no
// browser, offline), and git fixtures built with GIT_TEST_ARGS and GIT_TEST_DATES are reproducible.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_TEST_ARGS, GIT_TEST_DATES, hermeticEnv, nodeBinDir } from '../helpers/hermetic-env.js';

/** @type {string} */
let tmp;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-hermetic-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('homes live in the temp dir; PATH is a fake bin plus the system dirs; git, Claude and Codex variables are dropped', () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CODEX_SANDBOX: process.env.CODEX_SANDBOX };
  Object.assign(process.env, { GIT_DIR: '/elsewhere/.git', CLAUDE_CODE_SESSION_ID: 'abc', CODEX_SANDBOX: '1' });
  try {
    const env = hermeticEnv(tmp, { SPECREVIEW_AGENT: 'claude', TZ: undefined });
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME', 'SPECREVIEW_HOME']) {
      assert.ok(env[k].startsWith(tmp), k);
      assert.ok(fs.statSync(env[k]).isDirectory(), k);
    }
    assert.deepEqual(env.PATH.split(path.delimiter), [path.join(tmp, 'bin'), '/usr/bin', '/bin']);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'bin')), [], 'no gh, claude, codex or gemini');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.SPECREVIEW_BROWSER, 'none');
    assert.equal(env.SPECREVIEW_OFFLINE, '1');
    assert.equal(env.SPECREVIEW_AGENT, 'claude');
    assert.equal(env.TZ, undefined);
    for (const k of Object.keys(env)) {
      if (['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(k)) continue;
      assert.ok(!/^(GIT_|CLAUDE|CODEX)/.test(k), `${k} is not inherited`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('git fixtures are reproducible: same tree, same identity and dates -> same commit id, on branch main', () => {
  const env = { ...hermeticEnv(tmp), ...GIT_TEST_DATES };
  /** @param {string} dir */
  const commitIn = (dir) => {
    execFileSync('git', [...GIT_TEST_ARGS, 'init', '-q', dir], { env });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', [...GIT_TEST_ARGS, '-C', dir, 'add', 'a.txt'], { env });
    execFileSync('git', [...GIT_TEST_ARGS, '-C', dir, 'commit', '-q', '-m', 'first'], { env });
    return {
      sha: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], { env, encoding: 'utf8' }).trim(),
      author: execFileSync('git', ['-C', dir, 'log', '-1', '--format=%an <%ae> %aI'], { env, encoding: 'utf8' }).trim(),
    };
  };
  const a = commitIn(path.join(tmp, 'repo-a'));
  const b = commitIn(path.join(tmp, 'repo-b'));
  assert.equal(a.sha, b.sha);
  assert.equal(a.branch, 'main');
  assert.equal(a.author, 't <t@example.invalid> 2026-01-01T00:00:00+00:00');
});

test('a spawned node sees only the hermetic env', () => {
  const env = hermeticEnv(tmp, { PATH: [nodeBinDir(), '/usr/bin', '/bin'].join(path.delimiter) });
  const out = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ home: require("os").homedir(), keys: Object.keys(process.env) }))'], { env, encoding: 'utf8' }));
  assert.equal(out.home, path.join(tmp, 'home'));
  assert.ok(!out.keys.includes('GIT_DIR'));
});
