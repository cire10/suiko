// @ts-check
// Workspace discovery (design 5.1 + BUILD_AMENDMENTS 5) and creation of the repo-side `.specreview/` directory.
//
// For a file (or directory) the workspace root is, in order:
//   1. the nearest ancestor containing a `.specreview/` store directory;
//   2. otherwise the git toplevel (nearest ancestor containing `.git`, a directory or a worktree file);
//   3. otherwise the file's own directory (a directory argument is its own fallback).
// A root equal to the user's home directory or the filesystem root is REFUSED (RefusedError), unless the caller
// passed `explicitRoot` (the user gave `--workspace`): then the fallback root is the file's own directory.
// `<home>/.specreview` is never treated as a workspace store: by default it is the runtime home (SPECREVIEW_HOME).
// `explicitRoot` may also be a directory path: it then overrides discovery (it must contain the file), except
// that a home/filesystem-root value again falls back to the file's own directory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotFoundError, RefusedError } from './errors.js';
import { homeDir, wsIdOf } from './home.js';
import { writeJson, exists } from './atomic.js';
import { isWithin } from '../util/paths.js';
import { defaultConfigFile } from './config.js';

export const STORE_DIR = '.specreview';
export const STORE_GITIGNORE = '*.tmp-*\n';

/**
 * @typedef {object} WorkspaceInfo
 * @property {string} root absolute real path of the workspace root
 * @property {string} storeDir `<root>/.specreview`
 * @property {string} wsId first 8 hex of sha256(root)
 * @property {boolean} exists whether the store directory exists (after `create`, always true)
 * @property {'store' | 'git' | 'file' | 'explicit'} foundBy which rule chose the root
 */

/**
 * Finds (and with `create`, initialises) the workspace for a file or directory, which must exist.
 * @param {string} fileOrDir
 * @param {{ create?: boolean, explicitRoot?: boolean | string | null }} [opts]
 * @returns {Promise<WorkspaceInfo>}
 */
export async function findWorkspace(fileOrDir, { create = false, explicitRoot = null } = {}) {
  let target;
  try {
    target = await fsp.realpath(path.resolve(fileOrDir));
  } catch {
    throw new NotFoundError(`no such file or directory: ${fileOrDir}`, { details: { path: fileOrDir } });
  }
  const st = await fsp.stat(target);
  const ownDir = st.isDirectory() ? target : path.dirname(target);

  /** @type {string} */
  let root;
  /** @type {WorkspaceInfo['foundBy']} */
  let foundBy;
  if (typeof explicitRoot === 'string' && explicitRoot) {
    let given;
    try {
      given = await fsp.realpath(path.resolve(explicitRoot));
    } catch {
      throw new NotFoundError(`workspace directory does not exist: ${explicitRoot}`, { details: { path: explicitRoot } });
    }
    if (!(await fsp.stat(given)).isDirectory()) {
      throw new RefusedError(`workspace is not a directory: ${explicitRoot}`, { details: { path: explicitRoot } });
    }
    if (!isWithin(given, target)) {
      throw new RefusedError(`${fileOrDir} is outside the workspace ${given}`, { details: { path: target, root: given } });
    }
    root = isForbiddenRoot(given) ? ownDir : given;
    foundBy = root === given ? 'explicit' : 'file';
  } else {
    const found = discoverRoot(ownDir);
    root = found.root;
    foundBy = found.foundBy;
    if (isForbiddenRoot(root)) {
      if (!explicitRoot) {
        const what = root === path.parse(root).root ? 'the filesystem root' : 'your home directory';
        throw new RefusedError(
          `refusing to use ${what} (${root}) as the SpecReview workspace for ${target}; ` +
            'pass --workspace <dir> to choose the workspace explicitly',
          { details: { root, path: target } },
        );
      }
      root = ownDir;
      foundBy = 'file';
    }
  }

  const storeDir = path.join(root, STORE_DIR);
  if (create) await initStoreDir(root);
  return { root, storeDir, wsId: wsIdOf(root), exists: create || (await isStoreDir(storeDir)), foundBy };
}

/**
 * Walks up from `startDir` applying rules 1-3.
 * @param {string} startDir absolute real directory
 * @returns {{ root: string, foundBy: 'store' | 'git' | 'file' }}
 */
export function discoverRoot(startDir) {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (isWorkspaceStoreSync(path.join(dir, STORE_DIR), dir)) return { root: dir, foundBy: 'store' };
    if (path.dirname(dir) === dir) break;
  }
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return { root: dir, foundBy: 'git' };
    if (path.dirname(dir) === dir) break;
  }
  return { root: startDir, foundBy: 'file' };
}

/**
 * True for directories that must never be a workspace root: the user's home and the filesystem root.
 * @param {string} dir absolute
 * @returns {boolean}
 */
export function isForbiddenRoot(dir) {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return true;
  return samePath(resolved, os.homedir());
}

/**
 * Creates `<root>/.specreview/` with its .gitignore, a default config.json and the docs/ and assets/ dirs.
 * Existing files are left untouched. Returns the store directory.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function initStoreDir(root) {
  const storeDir = path.join(root, STORE_DIR);
  await fsp.mkdir(path.join(storeDir, 'docs'), { recursive: true });
  await fsp.mkdir(path.join(storeDir, 'assets'), { recursive: true });
  const gitignore = path.join(storeDir, '.gitignore');
  if (!(await exists(gitignore))) await fsp.writeFile(gitignore, STORE_GITIGNORE, { flag: 'wx' }).catch(ignoreExists);
  const config = path.join(storeDir, 'config.json');
  if (!(await exists(config))) await writeJson(config, defaultConfigFile());
  return storeDir;
}

/**
 * @param {unknown} err
 */
function ignoreExists(err) {
  if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
}

/**
 * True when `storeDir` is a directory usable as a workspace store.
 * @param {string} storeDir
 * @returns {Promise<boolean>}
 */
async function isStoreDir(storeDir) {
  return isWorkspaceStoreSync(storeDir, path.dirname(storeDir));
}

/**
 * A `.specreview` directory counts as a workspace store unless it sits directly in the user's home directory or is
 * the runtime home (SPECREVIEW_HOME).
 * @param {string} storeDir
 * @param {string} parent
 * @returns {boolean}
 */
function isWorkspaceStoreSync(storeDir, parent) {
  let st;
  try {
    st = fs.statSync(storeDir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  if (samePath(parent, os.homedir())) return false;
  if (samePath(storeDir, homeDir())) return false;
  return true;
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function existsSync(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compares two paths after resolving symlinks where possible.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  return realOrResolved(a) === realOrResolved(b);
}

/**
 * @param {string} p
 * @returns {string}
 */
function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
