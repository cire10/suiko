// @ts-check
// Hermetic environments for tests (design 2.15): a spawned process gets `hermeticEnv(tmp)` as its COMPLETE env, so
// it never reads or writes the developer's real HOME, agent configs (~/.claude, ~/.codex...), git config, gh or
// browser, and never reaches the network. Git fixtures are built with `git ${GIT_TEST_ARGS} ...` and the fixed dates
// of GIT_TEST_DATES, so commits are reproducible on any machine.
//
//   const env = hermeticEnv(tmp, { SPECREVIEW_AGENT: 'claude' });
//   execFileSync('git', [...GIT_TEST_ARGS, 'init', repo], { env: { ...env, ...GIT_TEST_DATES } });
//
// In-process tests set process.env.HOME to a temp dir at the top of the file instead; new code reads HOME from the
// env it is given, never from os.homedir().

import fs from 'node:fs';
import path from 'node:path';

/**
 * `-c` options for every git call that builds a test fixture: a fixed default branch and identity, no signing, no
 * autocrlf, no hooks, file:// remotes allowed (local fixtures only).
 */
export const GIT_TEST_ARGS = Object.freeze([
  '-c', 'init.defaultBranch=main',
  '-c', 'user.name=t',
  '-c', 'user.email=t@example.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.file.allow=always',
]);

/** Fixed author / committer dates for fixture commits (merge into the env of the git call). */
export const GIT_TEST_DATES = Object.freeze({
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});

/** Variables never inherited, by prefix (git, Claude Code, Codex). */
const DROPPED_PREFIXES = ['GIT_', 'CLAUDE', 'CODEX'];

/**
 * A complete env for a spawned test process: every home-like directory inside `tmp` (created), PATH limited to a
 * fake-bin dir (`<tmp>/bin`, created empty: no gh, claude, codex or gemini unless the test puts a fake there) and the
 * system dirs, git isolated from global and system config, no GIT_* / CLAUDE* / CODEX* variable from the parent, no
 * browser and offline mode. `extra` is applied last (undefined deletes a key).
 * @param {string} tmp an existing temp directory owned by the test
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
export function hermeticEnv(tmp, extra = {}) {
  const home = path.join(tmp, 'home');
  const bin = path.join(tmp, 'bin');
  const dirs = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    COPILOT_HOME: path.join(home, '.copilot'),
    GEMINI_CLI_HOME: home,
    SPECREVIEW_HOME: path.join(tmp, 'specreview-home'),
  };
  for (const d of [bin, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
  /** @type {Record<string, string>} */
  const env = {};
  // only what a process needs to run at all; everything else from the parent stays out
  for (const k of ['LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SYSTEMROOT', 'COMSPEC']) {
    const v = process.env[k];
    if (v !== undefined && !DROPPED_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  Object.assign(env, dirs, {
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    SPECREVIEW_BROWSER: 'none',
    SPECREVIEW_OFFLINE: '1',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * The node binary's directory, for tests that spawn `node` under a hermetic PATH (add it with `extra.PATH`).
 * @returns {string}
 */
export function nodeBinDir() {
  return path.dirname(process.execPath);
}
