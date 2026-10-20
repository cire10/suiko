// @ts-check
// The git layer of the code-review engine (design 4.3). Every git call goes through `gitx`:
//   - execFile('git', [...PREFIX, ...args]): argv only, never a shell;
//   - PREFIX: no pager, no colours, no external diff or textconv, no fsmonitor, hooks pointed at an empty path
//     (core.hooksPath=/dev/null; a fresh empty dir on Windows), no network (protocol.allow=never, no lazy fetch of
//     missing objects in a partial clone), no auto gc. The one exception is Repo#fetch (`review --pr` in the CLI
//     only): https, ssh, git and local paths are allowed for that call, never plain http or ext;
//   - the environment loses every variable that would redirect git to another repository, index or object store, or
//     change config, pathspec or diff behaviour (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS,
//     GIT_LITERAL_PATHSPECS...), and gains GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, LC_ALL=C and, when given,
//     GIT_INDEX_FILE=<a temp index>;
//   - user revisions always follow --end-of-options; repo paths are `:(literal)<path>` pathspecs.
// Failures are typed: not a repository, git missing or too old, or a failing command -> UsageError (exit 1).
//
//   openRepo(root)                 version check + top level; the Repo helper below (cwd = the top level)
//   Repo#tempIndex(store, fn)      a copy of the real index in <SPECREVIEW_HOME>/ws/<id>/cache/code-index-XXXX (removed
//                                  in finally; recovery sweeps stale ones). The real index is never written.
//   Repo#worktreeTree / indexTree  the tree of the working tree (untracked included, .gitignore respected) / of the index
//   Repo#untracked(pathspecs)      untracked files (raw names)
//   Repo#diffTrees(a, b, specs)    raw name status with modes and blob ids (-M, no copies)
//   Repo#blobs(ids)                sizes and contents through one cat-file --batch-check and one --batch
//   Repo#verifyCommit / mergeBase / treeOf / emptyTree / head / branch ...

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_MIN_VERSION } from '../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../store/errors.js';

/** Environment variables removed from every git call (design 4.3, plus the pathspec and object switches). */
const SCRUB = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_PAGER', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_QUARANTINE_PATH', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_DIFF_PATH_COUNTER', 'GIT_DIFF_PATH_TOTAL',
  'GIT_PREFIX', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR',
];

/** The pathspec that keeps every Suiko store (the root one and nested ones) out of a review. */
export const STORE_EXCLUDE = ':(exclude,glob)**/.specreview/**';

/** @type {string | null} */
let windowsHooksDir = null;

/** An empty hooks location: /dev/null on POSIX, a fresh empty temp dir on Windows. */
function hooksPath() {
  if (process.platform !== 'win32') return '/dev/null';
  if (!windowsHooksDir) windowsHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiko-nohooks-'));
  return windowsHooksDir;
}

/**
 * @param {boolean} [network] allow https, ssh, git and file transports (Repo#fetch); every other call has none
 * @returns {string[]}
 */
function prefix(network = false) {
  return [
    '--no-pager',
    '-c', 'color.ui=never',
    '-c', 'color.diff=never',
    '-c', 'core.quotePath=false',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${hooksPath()}`,
    '-c', 'core.safecrlf=false',
    // a temp index written as a split index would add a shared index to the real .git and prune the one the real
    // index still names, leaving the user's repo unreadable; written whole, it touches no shared index file
    '-c', 'core.splitIndex=false',
    '-c', 'splitIndex.sharedIndexExpire=never',
    '-c', 'protocol.allow=never',
    ...(network
      ? ['-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.file.allow=always']
      : []),
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'advice.addEmbeddedRepo=false',
    '-c', 'advice.addIgnoredFile=false',
  ];
}

/**
 * The scrubbed environment of a git call.
 * @param {string | undefined} indexFile
 * @returns {Record<string, string>}
 */
export function gitEnv(indexFile) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SCRUB.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.LC_ALL = 'C';
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/**
 * @typedef {{ cwd: string, input?: string | Buffer, indexFile?: string, maxBuffer?: number, timeoutMs?: number,
 *   okCodes?: number[], network?: boolean }} GitOpts
 * @typedef {{ code: number, stdout: Buffer, stderr: string }} GitResult
 */

/**
 * Runs git (no shell) with the hygiene prefix and the scrubbed environment. Exit codes outside `okCodes` (default
 * [0]) throw UsageError with git's message; so do a missing git binary, a timeout and an oversized output.
 * @param {string[]} args
 * @param {GitOpts} opts
 * @returns {Promise<GitResult>}
 */
export function gitx(args, { cwd, input, indexFile, maxBuffer = 64 << 20, timeoutMs = 30000, okCodes = [0], network = false }) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = execFile(
        'git',
        [...prefix(network), ...args],
        { cwd, env: gitEnv(indexFile), encoding: 'buffer', maxBuffer, timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
          const e = /** @type {any} */ (err);
          if (e && (e.code === 'ENOENT' || e.errno === -2) && typeof e.code !== 'number') {
            reject(new UsageError('git is not installed (or not on PATH): code reviews need git', { details: { kind: 'code' } }));
            return;
          }
          if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new UsageError(`git ${args[0]}: output larger than ${maxBuffer} bytes`, { details: { args: args.slice(0, 3) } }));
            return;
          }
          if (e && e.killed) {
            reject(new UsageError(`git ${args[0]} timed out after ${timeoutMs} ms`, { details: { args: args.slice(0, 3) } }));
            return;
          }
          const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
          if (!okCodes.includes(code)) {
            reject(gitFailure(args, code, errText));
            return;
          }
          resolve({ code, stdout: out, stderr: errText });
        },
      );
    } catch (err) {
      reject(new UsageError(`git could not be started: ${/** @type {Error} */ (err).message}`));
      return;
    }
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/**
 * @param {string[]} args
 * @param {number} code
 * @param {string} stderr
 * @returns {UsageError}
 */
function gitFailure(args, code, stderr) {
  const msg = stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('; ') || `exit ${code}`;
  return new UsageError(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]} failed: ${msg}`, { details: { exit: code } });
}

/** @type {Map<string, Promise<string>>} git version per PATH (a fake git on PATH in tests) */
const versionCache = new Map();

/**
 * The installed git version ('2.43.0'); UsageError when git is missing or older than GIT_MIN_VERSION.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function checkGitVersion(cwd) {
  const key = process.env.PATH ?? '';
  let p = versionCache.get(key);
  if (!p) {
    p = (async () => {
      const r = await gitx(['version'], { cwd, timeoutMs: 10000 });
      const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout.toString('utf8'));
      if (!m) throw new UsageError(`unrecognised git version: ${r.stdout.toString('utf8').trim()}`);
      return `${m[1]}.${m[2]}.${m[3] ?? 0}`;
    })();
    versionCache.set(key, p);
    p.catch(() => versionCache.delete(key));
  }
  const v = await p;
  if (compareVersions(v, GIT_MIN_VERSION) < 0) {
    throw new UsageError(`git ${v} is too old for code reviews: Suiko needs git ${GIT_MIN_VERSION} or newer (upgrade git)`, { details: { version: v, min: GIT_MIN_VERSION } });
  }
  return v;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Opens the repository whose top level is `root`: checks the git version, that `root` is in a work tree, and that it
 * IS the top level (a code review's workspace is the repository root, so repo-relative paths are workspace paths).
 * @param {string} root absolute workspace root
 * @param {{ allowSubdir?: boolean }} [opts] allowSubdir: return the top level of a subdirectory instead of refusing
 * @returns {Promise<Repo>}
 */
export async function openRepo(root, { allowSubdir = false } = {}) {
  await checkGitVersion(root);
  const r = await gitx(['rev-parse', '--show-toplevel'], { cwd: root, okCodes: [0, 128] });
  if (r.code !== 0) {
    throw new UsageError(`${root} is not inside a git repository: code reviews need git (run git init, or review from inside a repository)`, { details: { root, kind: 'code' } });
  }
  const top = r.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (!top) throw new UsageError(`${root} is not in a git work tree (a bare repository?)`, { details: { root } });
  const realTop = await realpathOr(top);
  const realRoot = await realpathOr(root);
  if (realTop !== realRoot && !allowSubdir) {
    throw new UsageError(
      `code reviews live in the workspace at the repository root ${realTop}, not in ${realRoot}: run suiko review from the repository (or pass --workspace ${realTop})`,
      { details: { root: realRoot, toplevel: realTop } },
    );
  }
  return new Repo(realTop);
}

/**
 * @param {string} p
 * @returns {Promise<string>}
 */
async function realpathOr(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @typedef {object} RawEntry one record of `diff-tree --raw -z`
 * @property {string} status 'A' | 'M' | 'D' | 'R' | 'T' | ...
 * @property {number | null} score rename similarity
 * @property {string} oldMode
 * @property {string} newMode
 * @property {string} oldId
 * @property {string} newId
 * @property {Buffer} path raw (new) path
 * @property {Buffer | null} oldPath raw old path (renames)
 */

/** A repository at its top level; every call runs there. */
export class Repo {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    /** @type {string | null} */
    this.empty = null;
  }

  /**
   * @param {string[]} args
   * @param {Omit<GitOpts, 'cwd'>} [opts]
   * @returns {Promise<GitResult>}
   */
  run(args, opts = {}) {
    return gitx(args, { cwd: this.root, ...opts });
  }

  /**
   * stdout as text without its last newline.
   * @param {string[]} args
   * @param {Omit<GitOpts, 'cwd'>} [opts]
   * @returns {Promise<string>}
   */
  async text(args, opts = {}) {
    const r = await this.run(args, opts);
    return r.stdout.toString('utf8').replace(/\r?\n$/, '');
  }

  /**
   * stdout as text, or null when git exits with one of `failCodes` (default 1 and 128).
   * @param {string[]} args
   * @param {Omit<GitOpts, 'cwd'> & { failCodes?: number[] }} [opts]
   * @returns {Promise<string | null>}
   */
  async maybe(args, { failCodes = [1, 128], ...opts } = {}) {
    const r = await this.run(args, { ...opts, okCodes: [0, ...failCodes] });
    return r.code === 0 ? r.stdout.toString('utf8').replace(/\r?\n$/, '') : null;
  }

  /** HEAD's commit id, or null when HEAD is unborn. */
  head() {
    return this.maybe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  }

  /** The checked-out branch's short name, or null (detached, or unborn without a branch). */
  async branch() {
    return this.maybe(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  /** The empty tree's id (object format aware), cached. */
  async emptyTree() {
    if (!this.empty) this.empty = await this.text(['hash-object', '-t', 'tree', '--stdin'], { input: '' });
    return this.empty;
  }

  /**
   * The full commit id of a revision, or null when it does not name a commit.
   * @param {string} rev
   * @returns {Promise<string | null>}
   */
  verifyCommit(rev) {
    return this.maybe(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  }

  /**
   * The tree id of a commit (or the empty tree itself).
   * @param {string} commitOrTree
   * @returns {Promise<string>}
   */
  async treeOf(commitOrTree) {
    if (commitOrTree === (await this.emptyTree())) return commitOrTree;
    const t = await this.maybe(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commitOrTree}^{tree}`]);
    if (!t) throw new NotFoundError(`${commitOrTree} has no tree in this repository`, { details: { rev: commitOrTree } });
    return t;
  }

  /**
   * The best common ancestor of two commits, or null when there is none.
   * @param {string} a
   * @param {string} b
   * @returns {Promise<string | null>}
   */
  mergeBase(a, b) {
    return this.maybe(['merge-base', '--end-of-options', a, b], { failCodes: [1] });
  }

  /**
   * The first parent of a commit, or null for a root commit.
   * @param {string} commit
   * @returns {Promise<string | null>}
   */
  parentOf(commit) {
    return this.maybe(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^1^{commit}`]);
  }

  /**
   * Whether a ref exists (`show-ref --verify`).
   * @param {string} ref full ref name
   * @returns {Promise<boolean>}
   */
  async refExists(ref) {
    const r = await this.run(['show-ref', '--verify', '--quiet', '--end-of-options', ref], { okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  /**
   * Whether commit `a` is `b` or an ancestor of it; false when either is not in the repository.
   * @param {string} a
   * @param {string} b
   * @returns {Promise<boolean>}
   */
  async isAncestor(a, b) {
    const r = await this.run(['merge-base', '--is-ancestor', '--end-of-options', a, b], { okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  /**
   * The configured remotes and their URLs.
   * @returns {Promise<Array<{ name: string, url: string }>>}
   */
  async remotes() {
    const out = await this.maybe(['config', '--get-regexp', '^remote\\..*\\.url$'], { failCodes: [1] });
    /** @type {Array<{ name: string, url: string }>} */
    const list = [];
    for (const line of (out ?? '').split('\n')) {
      const m = /^remote\.(.+)\.url (.*)$/.exec(line);
      if (m) list.push({ name: m[1], url: m[2] });
    }
    return list;
  }

  /**
   * Fetches refspecs from a configured remote, without tags. The only git call that may use the network (https,
   * ssh, git or a local path; design 4.18): made by `review --pr` in the CLI, never by a round or the daemon.
   * @param {string} remote
   * @param {string[]} refspecs
   */
  async fetch(remote, refspecs) {
    await this.run(['fetch', '--no-tags', '--quiet', '--end-of-options', remote, ...refspecs], { network: true, timeoutMs: 300000 });
  }

  /**
   * Deletes a ref; nothing happens when it does not exist.
   * @param {string} ref full ref name
   */
  async deleteRef(ref) {
    await this.run(['update-ref', '-d', '--end-of-options', ref], { okCodes: [0, 1] });
  }

  /** The absolute path of the real index file. */
  async indexPath() {
    const p = await this.text(['rev-parse', '--git-path', 'index']);
    return path.resolve(this.root, p);
  }

  /**
   * Runs `fn(indexFile)` on a copy of the real index (an empty index when there is none) in a fresh
   * `code-index-XXXX` directory of the store's cache, removed afterwards. The real index is only read.
   * @template T
   * @param {{ cacheDir: (...parts: string[]) => string }} store
   * @param {(indexFile: string) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async tempIndex(store, fn) {
    const base = store.cacheDir();
    await fsp.mkdir(base, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(base, 'code-index-'));
    try {
      const idx = path.join(dir, 'index');
      const real = await this.indexPath();
      let copied = false;
      try {
        await fsp.copyFile(real, idx);
        // keep the real index's timestamps: git's racy-entry check compares file mtimes with the index's own mtime,
        // and a fresh copy (newer) would make a same-size edit made in the index's second look unchanged
        const st = await fsp.stat(real);
        await fsp.utimes(idx, st.atime, st.mtime);
        copied = true;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
      }
      if (!copied) await this.run(['read-tree', '--empty'], { indexFile: idx });
      return await fn(idx);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The tree of the working tree: a temp copy of the index, `add -A` of the pathspecs (raw bytes, NUL separated,
   * through stdin: user pathspecs keep their magic, excludes are literal), then `write-tree`. Merge conflicts in the
   * real index are fine (the copy is resolved by `add`).
   * @param {{ cacheDir: (...parts: string[]) => string }} store
   * @param {Buffer[]} pathspecs
   * @returns {Promise<string>}
   */
  worktreeTree(store, pathspecs) {
    return this.tempIndex(store, async (idx) => {
      await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { indexFile: idx, input: nulJoin(pathspecs), timeoutMs: 120000 });
      return this.text(['write-tree'], { indexFile: idx });
    });
  }

  /**
   * The tree of the index (a temp copy; the real index and its lock are never touched). RefusedError (exit 3) when
   * the index has unmerged entries.
   * @param {{ cacheDir: (...parts: string[]) => string }} store
   * @returns {Promise<string>}
   */
  indexTree(store) {
    return this.tempIndex(store, async (idx) => {
      const unmerged = await this.run(['ls-files', '-z', '--unmerged'], { indexFile: idx });
      if (unmerged.stdout.length) {
        const names = [...new Set(splitNul(unmerged.stdout).map((b) => b.toString('utf8').replace(/^\S+ \S+ \S+\t/, '')))];
        throw new RefusedError(`the index has unmerged entries (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}): resolve the conflicts and git add them, or review --uncommitted`, {
          details: { unmerged: names },
        });
      }
      return this.text(['write-tree'], { indexFile: idx });
    });
  }

  /**
   * Untracked files (not ignored) matching the pathspecs, as raw names (a nested repository ends with '/').
   * @param {string[]} pathspecs
   * @returns {Promise<Buffer[]>}
   */
  async untracked(pathspecs) {
    const r = await this.run(['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspecs], { timeoutMs: 120000 });
    return splitNul(r.stdout);
  }

  /**
   * Tracked paths (in the index) whose working-tree stat differs from the index, as raw names (`diff-files`;
   * read-only, GIT_OPTIONAL_LOCKS=0 keeps it from refreshing the index).
   * @param {string[]} pathspecs
   * @returns {Promise<Buffer[]>}
   */
  async modifiedTracked(pathspecs) {
    const r = await this.run(['diff-files', '-z', '--name-only', '--no-ext-diff', '--', ...pathspecs], { timeoutMs: 120000 });
    return splitNul(r.stdout);
  }

  /**
   * Raw name status between two trees: one record per changed path, with modes and blob ids; renames paired at the
   * default 50% similarity, copies off.
   * @param {string} oldTree
   * @param {string} newTree
   * @param {string[]} pathspecs
   * @returns {Promise<RawEntry[]>}
   */
  async diffTrees(oldTree, newTree, pathspecs) {
    const r = await this.run(
      ['-c', 'diff.renames=true', 'diff-tree', '-r', '-z', '-M', '--raw', '--no-abbrev', '--no-ext-diff', '--no-color', '--no-textconv', '--end-of-options', oldTree, newTree, '--', ...pathspecs],
      { timeoutMs: 120000 },
    );
    return parseRaw(r.stdout);
  }

  /**
   * Blob ids of paths in a tree (`ls-tree -r -z --full-tree`), keyed by path (raw names decoded as UTF-8).
   * @param {string} tree
   * @param {string[]} paths repo-relative paths
   * @returns {Promise<Map<string, { mode: string, type: string, id: string }>>}
   */
  async lsTree(tree, paths) {
    /** @type {Map<string, { mode: string, type: string, id: string }>} */
    const out = new Map();
    if (!paths.length) return out;
    const r = await this.run(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', tree, '--', ...paths.map(literal)]);
    for (const rec of splitNul(r.stdout)) {
      const tab = rec.indexOf(0x09);
      if (tab < 0) continue;
      const [mode, type, id] = rec.subarray(0, tab).toString('utf8').split(' ');
      out.set(rec.subarray(tab + 1).toString('utf8'), { mode, type, id });
    }
    return out;
  }

  /**
   * Sizes and contents of objects: one `cat-file --batch-check`, then one `cat-file --batch` for the blobs of at most
   * `maxBytes` bytes. Missing objects (a partial clone never fetches here) come back with `missing: true`.
   * @param {string[]} ids
   * @param {number} maxBytes
   * @returns {Promise<Map<string, { type: string | null, size: number | null, missing: boolean, buf: Buffer | null }>>}
   */
  async blobs(ids, maxBytes) {
    /** @type {Map<string, { type: string | null, size: number | null, missing: boolean, buf: Buffer | null }>} */
    const out = new Map();
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return out;
    const check = await this.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${uniq.join('\n')}\n`, timeoutMs: 120000 });
    const lines = check.stdout.toString('utf8').split('\n').filter(Boolean);
    /** @type {string[]} */
    const want = [];
    uniq.forEach((id, i) => {
      const parts = (lines[i] ?? '').split(' ');
      if (parts[1] === 'missing' || parts.length < 3) {
        out.set(id, { type: null, size: null, missing: true, buf: null });
        return;
      }
      const size = Number(parts[2]);
      out.set(id, { type: parts[1], size, missing: false, buf: null });
      if (parts[1] === 'blob' && size <= maxBytes) want.push(id);
    });
    if (want.length) {
      const total = want.reduce((n, id) => n + /** @type {number} */ (out.get(id)?.size ?? 0) + 128, 0);
      const r = await this.run(['cat-file', '--batch'], { input: `${want.join('\n')}\n`, maxBuffer: total + (1 << 20), timeoutMs: 120000 });
      let p = 0;
      const buf = r.stdout;
      for (const id of want) {
        const nl = buf.indexOf(0x0a, p);
        if (nl < 0) break;
        const header = buf.subarray(p, nl).toString('utf8').split(' ');
        const size = Number(header[2]);
        if (header[1] === 'missing' || !Number.isFinite(size)) {
          out.set(id, { type: null, size: null, missing: true, buf: null });
          p = nl + 1;
          continue;
        }
        const body = buf.subarray(nl + 1, nl + 1 + size);
        const cur = /** @type {any} */ (out.get(id));
        cur.buf = Buffer.from(body);
        p = nl + 1 + size + 1;
      }
    }
    return out;
  }
}

/**
 * `:(literal)<path>`: a repo path as a pathspec (no globbing, no magic).
 * @param {string} p
 * @returns {string}
 */
export function literal(p) {
  return `:(literal)${p}`;
}

/**
 * Joins raw pathspecs for --pathspec-file-nul.
 * @param {Buffer[]} specs
 * @returns {Buffer}
 */
function nulJoin(specs) {
  const parts = [];
  for (const s of specs) {
    parts.push(s, Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

/**
 * NUL-separated records (the last terminator optional).
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
export function splitNul(buf) {
  /** @type {Buffer[]} */
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const z = buf.indexOf(0, p);
    const end = z < 0 ? buf.length : z;
    if (end > p) out.push(buf.subarray(p, end));
    p = end + 1;
  }
  return out;
}

/**
 * Parses `diff-tree --raw -z` output.
 * @param {Buffer} buf
 * @returns {RawEntry[]}
 */
export function parseRaw(buf) {
  /** @type {RawEntry[]} */
  const out = [];
  let p = 0;
  const next = () => {
    const z = buf.indexOf(0, p);
    const end = z < 0 ? buf.length : z;
    const rec = buf.subarray(p, end);
    p = end + 1;
    return rec;
  };
  while (p < buf.length) {
    const meta = next().toString('utf8');
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, oldId, newId, st] = meta.slice(1).split(' ');
    const status = st.charAt(0);
    const score = st.length > 1 ? Number(st.slice(1)) : null;
    if (status === 'R' || status === 'C') {
      const oldPath = next();
      const newPath = next();
      out.push({ status, score, oldMode, newMode, oldId, newId, path: newPath, oldPath });
    } else {
      out.push({ status, score, oldMode, newMode, oldId, newId, path: next(), oldPath: null });
    }
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A raw path as text, or null when Suiko does not carry it (design 4.3 "File names"): not valid UTF-8, a
 * control character (\x00-\x1f, \x7f), or a component beginning with '-'.
 * @param {Buffer} raw
 * @returns {string | null}
 */
export function supportedName(raw) {
  let s;
  try {
    s = UTF8.decode(raw);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  if (s.split('/').some((c) => c.startsWith('-'))) return null;
  return s;
}

/**
 * A printable stand-in for an unsupported raw name (control characters and invalid bytes replaced).
 * @param {Buffer} raw
 * @returns {string}
 */
export function displayName(raw) {
  // eslint-disable-next-line no-control-regex
  return raw.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '?');
}

/**
 * Whether a path looks like a secret (the key-file patterns of util/paths.js isDeniedPath, without its dot-dir
 * rule): `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`.
 * @param {string} p repo-relative path (any text; only ASCII patterns are checked)
 * @returns {boolean}
 */
export function looksSecret(p) {
  const base = p.split('/').pop()?.toLowerCase() ?? '';
  if (/^\.env/.test(base)) return true;
  if (/\.(pem|key|p12|pfx)$/.test(base)) return true;
  return /^id_(rsa|dsa|ecdsa|ed25519)/.test(base);
}
