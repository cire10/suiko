// @ts-check
// What a code review compares (design 4.2): ReviewInput -> CodeSpec, its identity (origin key), its doc id and its
// labels.
//
//   resolveSpec(repo, input, config) -> CodeSpec     validates the refs (NotFoundError, exit 4, when one is missing);
//                                                    no mode = the default: since-base against the detected default
//                                                    base, else uncommitted (on the default branch, detached, unborn
//                                                    HEAD, or no base found)
//   detectDefaultBase(repo, config) -> ref | null    code.defaultBase, origin/HEAD, then main/master/trunk/develop
//   specKey(spec)                                    'diff:since-base:origin/main', 'diff:commit:<sha40>'... + '+paths=a,b'
//   docIdFor(spec, branch)                           'cr-feat-token-refresh', 'cr-uncommitted', 'cr-staged', 'cr-a-b', 'cr-1a2b3c4'
//   specLabel(spec, code, { abbrev })                'since-base origin/main (merge-base 1a2b3c4) .. working tree'
//   packetLabel(spec, code)                          'since-base origin/main, merge-base 1a2b3c4' (packet header)
//   isFixedEndpoint(spec)                            --commit, or a range ending in a commit id: from v2 on the new side
//                                                    is the working tree (design 4.6)

import { LIMITS } from '../../shared/protocol.js';
import { NotFoundError, UsageError } from '../store/errors.js';
import { isEmptyTree } from './util.js';
import { OID_RE, REPO_RE } from './pr.js';

/**
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('./git.js').Repo} Repo
 * @typedef {{ mode?: string, base?: string, range?: string, commit?: string, paths?: string[], context?: number,
 *   maxFiles?: number }} ReviewInput
 */

const DEFAULT_BRANCHES = ['main', 'master', 'trunk', 'develop'];
const SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * The context lines of a review: input, else config code.context, else 3 (0..50).
 * @param {number | undefined} n
 * @param {any} config
 * @returns {number}
 */
export function contextOf(n, config) {
  const v = n ?? config?.code?.context ?? LIMITS.codeContext;
  const x = Number(v);
  return Number.isSafeInteger(x) && x >= 0 ? Math.min(x, 50) : LIMITS.codeContext;
}

/**
 * The default base (design 4.2): config code.defaultBase (it must exist), origin/HEAD (verified), the first local
 * branch among main / master / trunk / develop, else null.
 * @param {Repo} repo
 * @param {any} config
 * @returns {Promise<string | null>}
 */
export async function detectDefaultBase(repo, config) {
  const configured = typeof config?.code?.defaultBase === 'string' ? config.code.defaultBase.trim() : '';
  if (configured) {
    if (!(await repo.verifyCommit(configured))) {
      throw new NotFoundError(`code.defaultBase "${configured}" does not name a commit in this repository (fix the config, or pass --base <ref>)`, { details: { base: configured } });
    }
    return configured;
  }
  const originHead = await repo.maybe(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead && originHead.startsWith('refs/remotes/') && (await repo.refExists(originHead))) return originHead.slice('refs/remotes/'.length);
  for (const b of DEFAULT_BRANCHES) if (await repo.refExists(`refs/heads/${b}`)) return b;
  return null;
}

/**
 * Whether the checked-out branch IS the base ('main' on base 'main' or 'origin/main').
 * @param {string} base
 * @param {string} branch
 * @returns {boolean}
 */
function onBase(base, branch) {
  if (base === branch) return true;
  const slash = base.indexOf('/');
  return slash > 0 && base.slice(slash + 1) === branch;
}

/**
 * ReviewInput -> CodeSpec, refs validated. NotFoundError (exit 4) for a base, range end or commit that does not name a
 * commit; UsageError for malformed input.
 * @param {Repo} repo
 * @param {ReviewInput} input
 * @param {any} config
 * @returns {Promise<CodeSpec>}
 */
export async function resolveSpec(repo, input, config) {
  const context = contextOf(input.context, config);
  const paths = Array.isArray(input.paths) && input.paths.length ? [...input.paths] : undefined;
  if (paths?.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) throw new UsageError('review: --path values must be non-empty');
  /** @type {CodeSpec} */
  const spec = /** @type {any} */ ({ mode: 'uncommitted', context });
  if (paths) spec.paths = paths;
  const mode = input.mode;
  if (mode === undefined || (mode === 'since-base' && !input.base)) {
    const explicit = mode === 'since-base';
    const head = await repo.head();
    const branch = await repo.branch();
    if (!explicit && (!head || !branch)) return spec;
    const base = await detectDefaultBase(repo, config);
    if (!base) {
      if (explicit) throw new NotFoundError('no default base found (no code.defaultBase, origin/HEAD, main, master, trunk or develop): pass --base <ref>');
      return spec;
    }
    if (!explicit && onBase(base, /** @type {string} */ (branch))) return spec;
    return { ...spec, mode: 'since-base', base };
  }
  switch (mode) {
    case 'uncommitted':
    case 'staged':
      return { ...spec, mode };
    case 'since-base':
    case 'branch': {
      const base = String(input.base ?? '');
      if (!base) throw new UsageError(`review: mode ${mode} needs a base (--base <ref>)`);
      if (!(await repo.verifyCommit(base))) throw new NotFoundError(`base not found: "${base}" does not name a commit in this repository`, { details: { base } });
      if (mode === 'branch' && !(await repo.head())) throw new NotFoundError('HEAD has no commits yet: nothing is committed to review (use --uncommitted)');
      return { ...spec, mode, base };
    }
    case 'range': {
      const m = /^(.+?)(\.\.\.?)(.+)$/.exec(String(input.range ?? ''));
      if (!m) throw new UsageError(`review: the range must be A..B or A...B, got "${input.range ?? ''}"`);
      const [, from, dots, to] = m;
      for (const [end, what] of [[from, 'range start'], [to, 'range end']]) {
        if (!(await repo.verifyCommit(end))) throw new NotFoundError(`${what} not found: "${end}" does not name a commit in this repository`, { details: { rev: end } });
      }
      return { ...spec, mode: 'range', from, to, ...(dots === '...' ? { threeDot: true } : {}) };
    }
    case 'commit': {
      const c = await repo.verifyCommit(String(input.commit ?? ''));
      if (!c) throw new NotFoundError(`commit not found: "${input.commit}" does not name a commit in this repository`, { details: { commit: input.commit } });
      return { ...spec, mode: 'commit', commit: c };
    }
    case 'pr': {
      // resolved and fetched by `review --pr` in the CLI (pr.js); checked again here, field by field
      const pr = /** @type {any} */ (input).pr;
      const str = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\0-\x1f\x7f]/.test(v);
      if (!pr || !REPO_RE.test(String(pr.repo)) || !Number.isSafeInteger(pr.number) || pr.number < 1
        || !OID_RE.test(String(pr.headOid)) || !OID_RE.test(String(pr.mergeBase)) || !str(pr.headRefName) || !str(pr.baseRefName)) {
        throw new UsageError('review: a PR review needs a resolved PR (`specreview review --pr <n>`)');
      }
      const { repo: slug, number, url, title, baseRefName, headRefName, headOid, mergeBase } = pr;
      return { ...spec, mode: 'pr', pr: { repo: slug, number, url: String(url ?? ''), title: String(title ?? ''), baseRefName, headRefName, headOid, mergeBase } };
    }
    default:
      throw new UsageError(`review: unsupported mode ${JSON.stringify(mode)}`);
  }
}

/**
 * The origin key of a spec (the doc's identity): 'diff:<mode>:<canonical spec>[+paths=<sorted>]'.
 * @param {CodeSpec} spec
 * @returns {string}
 */
export function specKey(spec) {
  /** @type {string} */
  let body;
  switch (spec.mode) {
    case 'since-base':
    case 'branch':
      body = `diff:${spec.mode}:${spec.base}`;
      break;
    case 'range':
      body = `diff:range:${spec.from}${spec.threeDot ? '...' : '..'}${spec.to}`;
      break;
    case 'commit':
      body = `diff:commit:${spec.commit}`;
      break;
    case 'pr':
      body = `diff:pr:${spec.pr?.repo}#${spec.pr?.number}`;
      break;
    default:
      body = `diff:${spec.mode}`;
  }
  return spec.paths?.length ? `${body}+paths=${[...spec.paths].sort().join(',')}` : body;
}

/**
 * @param {string} s
 * @returns {string}
 */
function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^refs\/(heads|remotes)\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

/**
 * The doc id of a new review (the store appends -2, -3 on a collision).
 * @param {CodeSpec} spec
 * @param {string | null} branch the checked-out branch (since-base, branch)
 * @returns {string}
 */
export function docIdFor(spec, branch) {
  switch (spec.mode) {
    case 'since-base':
    case 'branch':
      return `cr-${slug(branch ?? '') || 'head'}`;
    case 'uncommitted':
      return 'cr-uncommitted';
    case 'staged':
      return 'cr-staged';
    case 'range':
      return `cr-${slug(spec.from ?? '') || 'a'}-${slug(spec.to ?? '') || 'b'}`;
    case 'commit':
      return `cr-${String(spec.commit ?? '').slice(0, 7)}`;
    case 'pr':
      return `cr-pr-${spec.pr?.number ?? 0}`;
    default:
      return 'cr-review';
  }
}

/**
 * @param {string | null | undefined} sha
 * @param {number} n
 * @returns {string}
 */
export function short(sha, n = 7) {
  return sha ? String(sha).slice(0, n) : '';
}

/**
 * Whether a revision as given is a commit id (a fixed endpoint), not a ref name.
 * @param {string | undefined} rev
 * @returns {boolean}
 */
export function isShaLike(rev) {
  return typeof rev === 'string' && SHA_RE.test(rev);
}

/**
 * Whether the new side of the spec is a fixed commit (--commit, or a range ending in a commit id): from v2 on, such
 * a review records the working tree (restricted to its files).
 * @param {CodeSpec} spec
 * @returns {boolean}
 */
export function isFixedEndpoint(spec) {
  return spec.mode === 'commit' || (spec.mode === 'range' && isShaLike(spec.to));
}

/**
 * ' · paths: a, b' for a path-limited review.
 * @param {CodeSpec} spec
 */
function pathsSuffix(spec) {
  return spec.paths?.length ? ` · paths: ${spec.paths.join(', ')}` : '';
}

/**
 * What the review compares, for the round's text header, the `review` output and reports:
 * 'since-base origin/main (merge-base 1a2b3c4) .. working tree'.
 * @param {CodeSpec} spec
 * @param {CodeManifest | null} code the round (null: not captured yet)
 * @param {{ abbrev?: number }} [opts] abbrev: commit id length (7; the canonical text uses 12)
 * @returns {string}
 */
export function specLabel(spec, code, { abbrev = 7 } = {}) {
  const s = (/** @type {string | null | undefined} */ x) => short(x, abbrev);
  const newSide = !code ? '' : code.newSide === 'worktree' ? 'working tree' : code.newSide === 'index' ? 'index' : `${s(code.newSha)}`;
  const emptyBase = code ? isEmptyTree(code.baseSha) : false;
  /** @type {string} */
  let label;
  switch (spec.mode) {
    case 'since-base':
      label = `since-base ${spec.base}${code ? ` (merge-base ${s(code.baseSha)}) .. ${newSide}` : ''}`;
      break;
    case 'branch':
      label = `branch ${spec.base}${code ? ` (merge-base ${s(code.baseSha)}) .. HEAD ${s(code.newSha)}` : ''}`;
      break;
    case 'uncommitted':
      label = `uncommitted${code ? ` ${emptyBase ? '(no commits yet)' : `HEAD ${s(code.baseSha)}`} .. ${newSide}` : ''}`;
      break;
    case 'staged':
      label = `staged${code ? ` ${emptyBase ? '(no commits yet)' : `HEAD ${s(code.baseSha)}`} .. index` : ''}`;
      break;
    case 'range':
      label = `range ${spec.from}${spec.threeDot ? '...' : '..'}${spec.to}${code ? ` (${spec.threeDot ? 'merge-base ' : ''}${s(code.baseSha)} .. ${newSide})` : ''}`;
      break;
    case 'commit':
      label = `commit ${s(spec.commit)}${code && code.newSide === 'worktree' ? ` (${emptyBase ? 'root commit' : `parent ${s(code.baseSha)}`}) .. working tree` : ''}`;
      break;
    case 'pr':
      label = `pr #${spec.pr?.number ?? '?'}${code ? ` (merge-base ${s(code.baseSha)}) .. ${newSide}` : ''}`;
      break;
    default:
      label = String(spec.mode);
  }
  return `${label}${pathsSuffix(spec)}`;
}

/**
 * The packet header label (design 4.10): 'since-base origin/main, merge-base 1a2b3c4'.
 * @param {CodeSpec} spec
 * @param {CodeManifest | null} code
 * @returns {string}
 */
export function packetLabel(spec, code) {
  const s = (/** @type {string | null | undefined} */ x) => short(x, 7);
  const base = code?.baseSha ?? null;
  /** @type {string[]} */
  const parts = [];
  switch (spec.mode) {
    case 'since-base':
      parts.push(`since-base ${spec.base}`, `merge-base ${s(base)}`);
      break;
    case 'branch':
      parts.push(`branch ${spec.base}`, `merge-base ${s(base)}`);
      break;
    case 'uncommitted':
    case 'staged':
      parts.push(spec.mode, `HEAD ${s(base)}`);
      break;
    case 'range':
      parts.push(`range ${spec.from}${spec.threeDot ? '...' : '..'}${spec.to}`);
      if (spec.threeDot) parts.push(`merge-base ${s(base)}`);
      break;
    case 'commit':
      parts.push(`commit ${s(spec.commit)}`);
      if (code?.newSide === 'worktree') parts.push('now the working tree');
      break;
    default:
      parts.push(String(spec.mode));
  }
  if (spec.paths?.length) parts.push(`paths ${spec.paths.join(' ')}`);
  return parts.join(', ');
}

/**
 * How a round's base is named in reports and packet basis lines: 'merge-base 1a2b3c4' (since-base, branch, a
 * three-dot range), 'HEAD 1a2b3c4' (uncommitted, staged), 'parent 1a2b3c4' (commit), 'range start 1a2b3c4',
 * '(empty tree)' (no commits yet, a root commit).
 * @param {string} mode
 * @param {string | null | undefined} sha
 * @param {boolean} [threeDot]
 * @returns {string}
 */
export function baseName(mode, sha, threeDot = false) {
  if (!sha || isEmptyTree(sha)) return '(empty tree)';
  const word = mode === 'uncommitted' || mode === 'staged' ? 'HEAD' : mode === 'commit' ? 'parent' : mode === 'range' && !threeDot ? 'range start' : 'merge-base';
  return `${word} ${short(sha)}`;
}
