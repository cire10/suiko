// @ts-check
// Optional git auto-commit of recorded versions (design 5.5). Only when `config.git.autoCommit` is on and the
// workspace root is inside a git work tree. It stages and commits exactly the doc's working file, its
// `.specreview/docs/<id>` directory and `.specreview/assets` (a pathspec-limited commit, so other staged changes
// are left alone) and never pushes. Failures never fail the caller: they come back as `{ commit: null, error }`.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../util/log.js';

const log = createLogger('review:git');
const GIT_TIMEOUT_MS = 15000;

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function git(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(/** @type {Error} */ (err).message) });
    }
  });
}

/**
 * Whether `dir` is inside a git work tree.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(dir) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/**
 * Commit message: `spec(<id>): v3 - <summary> [t1 t2]`.
 * @param {string} docId
 * @param {number} v
 * @param {string} summary
 * @param {string[]} threads
 * @returns {string}
 */
export function commitMessage(docId, v, summary, threads) {
  const s = String(summary ?? '').replace(/\s+/g, ' ').trim();
  const t = threads.length ? ` [${threads.join(' ')}]` : '';
  return `spec(${docId}): v${v}${s ? ` - ${s}` : ''}${t}`;
}

/**
 * @param {object} p
 * @param {string} p.root workspace root
 * @param {{ git?: { autoCommit?: boolean } }} p.config
 * @param {string} p.docId
 * @param {string} p.docPath workspace-relative path of the working file
 * @param {number} p.version
 * @param {string} p.summary
 * @param {string[]} [p.threads]
 * @returns {Promise<{ commit: string | null, skipped?: string, error?: string }>}
 */
export async function autoCommit({ root, config, docId, docPath, version, summary, threads = [] }) {
  if (!config?.git?.autoCommit) return { commit: null, skipped: 'git.autoCommit is off' };
  if (!(await isGitRepo(root))) return { commit: null, skipped: 'not a git repository' };
  // A pathspec that matches nothing (no assets yet) would fail the whole command.
  const paths = [docPath, `.specreview/docs/${docId}`, '.specreview/assets'].filter((p) => fs.existsSync(path.join(root, p)));
  const add = await git(['add', '--', ...paths], root);
  if (add.code !== 0) {
    log.warn(`git add failed: ${add.stderr.trim()}`);
    return { commit: null, error: add.stderr.trim() || 'git add failed' };
  }
  const msg = commitMessage(docId, version, summary, threads);
  const commit = await git(['commit', '-q', '-m', msg, '--', ...paths], root);
  if (commit.code !== 0) {
    const error = (commit.stderr || commit.stdout).trim() || 'git commit failed';
    log.warn(`git commit failed: ${error}`);
    return { commit: null, error };
  }
  const head = await git(['rev-parse', 'HEAD'], root);
  return { commit: head.code === 0 ? head.stdout.trim() : null };
}
