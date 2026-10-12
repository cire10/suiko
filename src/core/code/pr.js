// @ts-check
// PR mode (design 4.18): `specreview review --pr <n|url>` reviews a GitHub pull request. Only the CLI calls
// resolvePr and fetchPr: rounds (snapshot.js resolveSides), the daemon's Re-snapshot and the poller use local refs
// and never run `gh` or `git fetch`; a re-fetch happens only when `review --pr` runs again.
//
//   parsePrArg(arg)              '123' | '#123' | 'https://github.com/<owner>/<repo>/pull/123' -> { repo | null, number }
//   resolvePr(run, arg, o)       gh metadata and merge-base, every value validated before any git call -> PrInfo
//   fetchPr(repo, pr)            the one fetch (when needed): refs/pull/<n>/head -> refs/specreview/pr/<n>, and the
//                                merge-base when it is missing; from the remote whose URL is the PR's repository
//   prCheckedOut(repo, pr)       the working tree is the PR's when its head commit is HEAD or an ancestor of HEAD
//                                (`gh pr checkout`, plus commits on top); matching branch names is not enough (a
//                                fork's PR branch is often called main)
//   prRef(n), deletePrRef(root, n), ghRunner(deps, env)

import { execFile } from 'node:child_process';
import { NotFoundError, RefusedError, UsageError } from '../store/errors.js';
import { openRepo } from './git.js';

/** `owner/repo` as gh prints it. '.' and '..' are never names (in `gh api repos/<repo>/...` they would walk the path). */
export const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
/** A full commit id (SHA-1 or SHA-256). */
export const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?:[/?#].*)?$/;
const PR_FIELDS = 'number,title,url,baseRefName,headRefName,baseRefOid,headRefOid,changedFiles';

/**
 * @typedef {object} PrInfo the `pr` of a PR review's CodeSpec
 * @property {string} repo owner/repo
 * @property {number} number
 * @property {string} url
 * @property {string} title
 * @property {string} baseRefName
 * @property {string} headRefName
 * @property {string} headOid the PR head when `review --pr` last ran
 * @property {string} mergeBase merge-base of the PR's base and head (GitHub's compare API)
 *
 * @typedef {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} GhRun
 */

/**
 * @param {number} n
 * @returns {string}
 */
export function prRef(n) {
  return `refs/specreview/pr/${n}`;
}

/**
 * @param {unknown} arg
 * @returns {{ repo: string | null, number: number }}
 */
export function parsePrArg(arg) {
  const s = String(arg ?? '').trim();
  const num = /^#?([0-9]+)$/.exec(s);
  const url = PR_URL_RE.exec(s);
  const n = Number(num ? num[1] : url && REPO_RE.test(url[1]) ? url[2] : NaN);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`review --pr: give a PR number or https://github.com/<owner>/<repo>/pull/<n>, got "${s.slice(0, 120)}"`);
  }
  return { repo: url ? url[1] : null, number: n };
}

/**
 * How `gh` runs: deps.gh (tests), else $SPECREVIEW_GH, else `gh` on PATH. argv only, never a shell.
 * @param {Record<string, any>} deps
 * @param {Record<string, string | undefined>} env
 * @returns {GhRun}
 */
export function ghRunner(deps, env) {
  if (typeof deps.gh === 'function') return deps.gh;
  const bin = env.SPECREVIEW_GH || 'gh';
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { env: { ...process.env, ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 8 << 20, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        const e = /** @type {any} */ (err);
        if (e && typeof e.code === 'string' && (e.code === 'ENOENT' || e.code === 'EACCES')) {
          reject(new UsageError(`gh (the GitHub CLI) is not installed${env.SPECREVIEW_GH ? ` at ${env.SPECREVIEW_GH}` : ' (or not on PATH)'}: PR reviews need it (https://cli.github.com)`));
          return;
        }
        if (e && e.killed) {
          reject(new UsageError(`gh ${args[0]} timed out`));
          return;
        }
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
}

/**
 * Runs gh and returns stdout; failures are typed: not signed in -> exit 1, not found -> exit 4, else exit 1.
 * @param {GhRun} run
 * @param {string[]} args
 * @param {string} what what was asked for, for messages
 * @returns {Promise<string>}
 */
async function gh(run, args, what) {
  const r = await run(args);
  if (r.code === 0) return r.stdout;
  const msg = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('; ') || `exit ${r.code}`;
  if (r.code === 4 || /gh auth login|not logged in|authentication required/i.test(r.stderr)) {
    throw new UsageError(`gh is not signed in (${msg}): run \`gh auth login\``);
  }
  if (/could not resolve to a (pullrequest|repository)|no pull requests? found|HTTP 404|not found/i.test(r.stderr)) {
    throw new NotFoundError(`${what} not found (${msg})`);
  }
  throw new UsageError(`gh ${args[0]} ${args[1] ?? ''} failed: ${msg}`.replace(/\s+:/, ':'));
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function oid(v, what) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!OID_RE.test(s)) throw new UsageError(`gh returned an invalid ${what}: ${JSON.stringify(String(v).slice(0, 80))}`);
  return s;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function refName(v, what) {
  const s = typeof v === 'string' ? v : '';
  if (!s || s.length > 255 || /[\0-\x1f\x7f]/.test(s)) throw new UsageError(`gh returned an invalid ${what}: ${JSON.stringify(String(v).slice(0, 80))}`);
  return s;
}

/**
 * Resolves a PR through gh: the repository (from the URL, else `gh repo view` in the checkout), its metadata and
 * the merge-base. Every value gh returns is validated before anything else runs.
 * @param {GhRun} run
 * @param {unknown} arg the --pr value
 * @param {{ maxFiles?: number | null }} [o]
 * @returns {Promise<PrInfo>}
 */
export async function resolvePr(run, arg, { maxFiles = null } = {}) {
  const parsed = parsePrArg(arg);
  let repo = parsed.repo;
  if (!repo) {
    repo = (await gh(run, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 'the GitHub repository of this checkout')).trim();
    if (!REPO_RE.test(repo)) throw new UsageError(`gh returned an invalid repository name: ${JSON.stringify(repo.slice(0, 80))}`);
  }
  const n = parsed.number;
  const raw = await gh(run, ['pr', 'view', String(n), '-R', repo, '--json', PR_FIELDS], `PR #${n} in ${repo}`);
  /** @type {any} */
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new UsageError('gh pr view returned something that is not JSON');
  }
  if (!meta || typeof meta !== 'object' || meta.number !== n) throw new UsageError(`gh pr view returned another PR than #${n}`);
  const baseOid = oid(meta.baseRefOid, 'base commit');
  const headOid = oid(meta.headRefOid, 'head commit');
  const baseRefName = refName(meta.baseRefName, 'base branch name');
  const headRefName = refName(meta.headRefName, 'head branch name');
  const url = typeof meta.url === 'string' && /^https:\/\/\S+$/.test(meta.url) ? meta.url : `https://github.com/${repo}/pull/${n}`;
  const title = typeof meta.title === 'string' ? meta.title.replace(/[\0-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : '';
  const changed = Number(meta.changedFiles);
  if (maxFiles && Number.isFinite(changed) && changed > maxFiles) {
    throw new RefusedError(`PR #${n} changes ${changed} files, more than ${maxFiles} (code.maxFiles): pass --max-files N, or --path to review part of it`, { details: { files: changed } });
  }
  const mergeBase = oid(
    (await gh(run, ['api', `repos/${repo}/compare/${baseOid}...${headOid}`, '--jq', '.merge_base_commit.sha'], `the merge-base of PR #${n}`)).trim(),
    'merge-base',
  );
  return { repo, number: n, url, title, baseRefName, headRefName, headOid, mergeBase };
}

/**
 * Whether the working tree is the PR's: its head commit is HEAD, or an ancestor of HEAD (commits made on top of a
 * `gh pr checkout`).
 * @param {import('./git.js').Repo} repo
 * @param {Pick<PrInfo, 'headOid'>} pr
 * @returns {Promise<boolean>}
 */
export async function prCheckedOut(repo, pr) {
  const head = await repo.head();
  if (!head || !OID_RE.test(String(pr.headOid))) return false;
  return head === pr.headOid || repo.isAncestor(pr.headOid, head);
}

/**
 * The remote whose URL is `owner/repo` (its last two path segments, without .git; any host), origin first.
 * @param {import('./git.js').Repo} repo
 * @param {string} slug owner/repo
 * @returns {Promise<string | null>}
 */
export async function prRemote(repo, slug) {
  const want = slug.toLowerCase();
  const matches = (await repo.remotes()).filter(({ url }) => {
    const segs = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^[^@/]*@([^:/]+):/, '$1/').split('/');
    return segs.slice(-2).join('/').toLowerCase() === want;
  });
  return (matches.find((r) => r.name === 'origin') ?? matches.sort((a, b) => (a.name < b.name ? -1 : 1))[0])?.name ?? null;
}

/**
 * Makes the PR's commits available locally with one fetch, when needed: the PR head into refs/specreview/pr/<n>
 * when it is not checked out, and the merge-base when it is missing.
 * @param {import('./git.js').Repo} repo
 * @param {PrInfo} pr
 * @returns {Promise<{ checkedOut: boolean, fetched: boolean, remote: string | null }>}
 */
export async function fetchPr(repo, pr) {
  const checkedOut = await prCheckedOut(repo, pr);
  const haveBase = Boolean(await repo.verifyCommit(pr.mergeBase));
  if (checkedOut && haveBase) return { checkedOut, fetched: false, remote: null };
  const remote = await prRemote(repo, pr.repo);
  if (!remote) {
    throw new RefusedError(
      `no git remote here points at ${pr.repo}: add one (\`git remote add upstream https://github.com/${pr.repo}.git\`), then run \`specreview review --pr ${pr.number}\` again`,
      { details: { repo: pr.repo } },
    );
  }
  const refspecs = [...(checkedOut ? [] : [`+refs/pull/${pr.number}/head:${prRef(pr.number)}`]), ...(haveBase ? [] : [pr.mergeBase])];
  await repo.fetch(remote, refspecs);
  if (!checkedOut && (await repo.verifyCommit(prRef(pr.number))) !== pr.headOid) {
    throw new UsageError(`PR #${pr.number} changed while it was fetched: run \`specreview review --pr ${pr.number}\` again`);
  }
  if (!(await repo.verifyCommit(pr.mergeBase))) {
    throw new NotFoundError(`the merge-base ${pr.mergeBase.slice(0, 7)} of PR #${pr.number} could not be fetched from ${remote}`);
  }
  return { checkedOut, fetched: true, remote };
}

/**
 * Deletes a PR review's local ref (`close`); git failures are ignored (closing must not fail on them).
 * @param {string} root the repository top level
 * @param {number} n
 */
export async function deletePrRef(root, n) {
  if (!Number.isSafeInteger(n) || n < 1) return;
  try {
    await (await openRepo(root)).deleteRef(prRef(n));
  } catch {
    // not a repository any more, git missing: nothing to clean
  }
}
