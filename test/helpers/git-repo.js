// @ts-check
// Scripted git repositories for the code-review tests (design 9.3): a temp dir holding a repo built with
// GIT_TEST_ARGS and the fixed GIT_TEST_DATES (reproducible commit ids), a temp SPECREVIEW_HOME, and helpers to
// write, remove and commit files and to open an engine context on the repo. Git never reads the developer's config:
// the fixture calls get the hermetic env, and the process env (which the engine's own git calls inherit) is pointed
// at /dev/null config too. No network: remotes are local bare repositories (file://).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_TEST_ARGS, GIT_TEST_DATES, hermeticEnv } from './hermetic-env.js';
import { createContext } from '../../src/core/review/context.js';

/**
 * Makes git calls of the current process (the engine's) hermetic: no global or system config, no prompts.
 */
export function hermeticGitProcess() {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
  for (const k of Object.keys(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|AUTHOR_|COMMITTER_)/.test(k)) delete process.env[k];
  }
}

/**
 * @typedef {object} TestRepo
 * @property {string} base the temp dir (removed by cleanup)
 * @property {string} root the repository top level (also the SpecReview workspace root)
 * @property {string} home SPECREVIEW_HOME
 * @property {Record<string, string>} env the hermetic env of fixture git calls
 * @property {(...args: string[]) => string} git runs git in the repo (fixture identity and dates); stdout
 * @property {(args: string[], opts?: { input?: string | Buffer, cwd?: string }) => Buffer} gitRaw
 * @property {(rel: string, text: string | Buffer) => void} write
 * @property {(rel: string) => string} read
 * @property {(rel: string) => boolean} exists
 * @property {(rel: string) => void} rm
 * @property {(msg?: string, ...paths: string[]) => string} commit stages (all, or `paths`) and commits; the new HEAD
 * @property {(opts?: { agent?: string, reviewer?: string, cwd?: string }) => Promise<any>} ctx an engine context on the repo
 * @property {(name: string) => string} bare a bare repository next to the repo (for an origin remote)
 * @property {() => Promise<void>} cleanup
 */

/**
 * A fresh repository. `files` are written and committed on main as the first commit (none: an unborn HEAD unless
 * `commit` is true, which makes an empty first commit).
 * @param {{ files?: Record<string, string>, commit?: boolean, message?: string }} [opts]
 * @returns {Promise<TestRepo>}
 */
export async function makeRepo({ files = {}, commit = Object.keys(files).length > 0, message = 'init' } = {}) {
  hermeticGitProcess();
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-code-')));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'specreview-home');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  process.env.SPECREVIEW_HOME = home;
  const env = { ...hermeticEnv(base, { SPECREVIEW_HOME: home }), ...GIT_TEST_DATES };
  /** @type {TestRepo['gitRaw']} */
  const gitRaw = (args, o = {}) => execFileSync('git', [...GIT_TEST_ARGS, ...args], { cwd: o.cwd ?? root, env, input: o.input, stdio: ['pipe', 'pipe', 'pipe'] });
  const git = (/** @type {string[]} */ ...args) => gitRaw(args).toString('utf8').trim();
  const abs = (/** @type {string} */ rel) => path.join(root, ...rel.split('/'));
  const write = (/** @type {string} */ rel, /** @type {string | Buffer} */ text) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  git('init', '-q');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const doCommit = (/** @type {string} */ msg = 'change', /** @type {string[]} */ ...paths) => {
    if (paths.length) git('add', '--', ...paths);
    else git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  if (commit) doCommit(message);
  return {
    base,
    root,
    home,
    env,
    git,
    gitRaw,
    write,
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    exists: (rel) => fs.existsSync(abs(rel)),
    rm: (rel) => fs.rmSync(abs(rel), { force: true, recursive: true }),
    commit: doCommit,
    ctx: ({ agent = 'claude', reviewer = 'Eric', cwd = root } = {}) => createContext({ root, cwd, agent, reviewer, createStore: true }),
    bare: (name) => {
      const dir = path.join(base, `${name}.git`);
      execFileSync('git', [...GIT_TEST_ARGS, 'init', '-q', '--bare', dir], { env });
      return dir;
    },
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

/**
 * Numbered lines 'line 1\n' ... for fixture files.
 * @param {number} n
 * @param {(i: number) => string} [fn]
 * @returns {string}
 */
export function lines(n, fn = (i) => `line ${i}`) {
  let s = '';
  for (let i = 1; i <= n; i++) s += `${fn(i)}\n`;
  return s;
}
