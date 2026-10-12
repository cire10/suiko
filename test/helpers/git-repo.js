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
 * @property {string} root the repository top level (also the Suiko workspace root)
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
  const home = path.join(base, 'suiko-home');
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

/**
 * A reviewer draft on lines of a file side of round `version` (default head), as the UI's DiffTable sends it.
 * @param {any} ctx
 * @param {string} docId
 * @param {{ file: string, lines: [number, number] | number, side?: 'new' | 'old', type?: string, severity?: string,
 *   body?: string, suggestion?: string, version?: number }} o suggestion: the replacement text (type suggestion)
 */
export async function lineDraft(ctx, docId, o) {
  const { saveDraft } = await import('../../src/core/review/ops.js');
  const [a, b] = Array.isArray(o.lines) ? o.lines : [o.lines, o.lines];
  const doc = await ctx.store.requireDoc(docId);
  return saveDraft(ctx, docId, {
    kind: 'thread',
    type: o.suggestion !== undefined ? 'suggestion' : o.type ?? 'comment',
    ...(o.severity ? { severity: o.severity } : {}),
    version: o.version ?? doc.head,
    capture: { kind: 'line', file: o.file, side: o.side ?? 'new', startLine: a, endLine: b },
    body: o.body ?? 'Say more.',
    ...(o.suggestion !== undefined ? { suggestion: { new: o.suggestion } } : {}),
  });
}

/**
 * A reviewer draft on a whole file (binary, deleted, skipped) or, without `file`, on the whole review.
 * @param {any} ctx
 * @param {string} docId
 * @param {{ file?: string, type?: string, body?: string }} o
 */
export async function fileDraft(ctx, docId, o) {
  const { saveDraft } = await import('../../src/core/review/ops.js');
  const doc = await ctx.store.requireDoc(docId);
  return saveDraft(ctx, docId, {
    kind: 'thread',
    type: o.type ?? 'comment',
    version: doc.head,
    capture: o.file ? { kind: 'file', file: o.file } : { kind: 'doc' },
    body: o.body ?? 'Say more.',
  });
}

/**
 * Submits the reviewer's drafts.
 * @param {any} ctx
 * @param {string} docId
 * @param {{ verdict?: string, body?: string }} [o]
 */
export async function submit(ctx, docId, o = {}) {
  const { submitReview } = await import('../../src/core/review/ops.js');
  return submitReview(ctx, docId, { verdict: o.verdict ?? 'changes_requested', body: o.body ?? '', by: 'Eric' });
}

/**
 * The packet a `wait` would deliver now (nothing is marked delivered): { text, packet }.
 * @param {any} ctx
 * @param {string} docId
 * @param {{ allOpen?: boolean }} [o]
 */
export async function packetOf(ctx, docId, o = {}) {
  const { buildDocPacket } = await import('../../src/core/review/ops.js');
  return buildDocPacket(ctx, await ctx.store.requireDoc(docId), o);
}

/**
 * The repository of the design's round-1 example (design 4.10): main with src/auth/refresh.js and
 * src/auth/store.js, origin/main (and origin/HEAD) at main, and feat/token-refresh checked out with a reuse check at
 * refresh.js L41-44, the TTL at L88, legacyLookup (base L12-14) removed from store.js and a new test file.
 * @returns {Promise<TestRepo & { mergeBase: string }>}
 */
export async function designRepo() {
  const refreshBase = lines(96, (i) => (i === 84 ? 'const ttlSec = 3600;' : `// refresh ${i}`));
  const storeBase = lines(20, (i) =>
    i === 12 ? 'export function legacyLookup(id) {' : i === 13 ? '  return db.tokens.findOne({ id });' : i === 14 ? '}' : `// store ${i}`,
  );
  const r = await makeRepo({ files: { 'src/auth/refresh.js': refreshBase, 'src/auth/store.js': storeBase } });
  const mergeBase = r.git('rev-parse', 'HEAD');
  r.git('update-ref', 'refs/remotes/origin/main', mergeBase);
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  r.git('checkout', '-q', '-b', 'feat/token-refresh');
  const refresh = refreshBase.split('\n');
  refresh.splice(40, 0, 'if (stored.used) {', '  await revokeFamily(stored.family);', '  throw new TokenReuseError();', '}');
  refresh[87] = 'const ttlSec = 30 * 24 * 3600;';
  r.write('src/auth/refresh.js', refresh.join('\n'));
  r.commit('reuse check');
  r.write('src/auth/store.js', storeBase.split('\n').filter((_, i) => i < 11 || i > 13).join('\n'));
  r.write('test/refresh.test.js', "import { test } from 'node:test';\n\ntest('refresh', () => {});\n");
  return Object.assign(r, { mergeBase });
}
