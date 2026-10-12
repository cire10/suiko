// @ts-check
// `specreview review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha> | --pr <n|url>]
//  [--path <pathspec>]... [--context N] [--max-files N] [--title T] [--browser pane|system|none] [--workspace <dir>]
//  [--json]` (design 4.2, 4.18): opens a code review of the agent's changes (doc kind 'code') and returns at once with
// the review URL and the background `wait` command.
//
// Workspace: --workspace, else the repository top level of the cwd (`git rev-parse --show-toplevel`); `.specreview/`
// is created there when missing (review is an explicit verb, as `open` is). The engine (src/core/code/review.js
// openCodeReview) creates the code doc and records round 1, or records a new round of the existing doc of the same
// spec when the files changed (a no-op otherwise; a closed doc is reopened). Then the daemon is started and the URL
// shown as `open` does.
//
//   review                              since-base: merge-base(<default base>, HEAD) .. working tree (+ untracked);
//                                       on the default branch, detached or without a base: uncommitted
//   review --uncommitted                HEAD .. working tree (+ untracked)
//   review --staged                     HEAD .. the index
//   review --base main [--committed]    merge-base(main, HEAD) .. working tree (--committed: .. HEAD, mode branch)
//   review A..B | A...B                 range (three-dot: merge-base(A, B) .. B)
//   review --commit <sha>               <sha>^ .. <sha>
//   review --pr <n|url>                 a GitHub PR through `gh` (core/code/pr.js): its merge-base .. the working tree
//                                       when the PR is checked out, else .. its head, fetched once into
//                                       refs/specreview/pr/<n>. The only review that uses the network; re-run it to
//                                       pick up new PR commits (rounds and the daemon never fetch).
// Exit: 0 open; 1 not a git repository, git too old, git failure, gh missing or not signed in; 3 refused (too many
// files, unmerged index entries with --staged, too many large untracked files, offline, no remote for the PR's
// repository); 4 base / range end / commit / PR not found, or nothing to review.

import fs from 'node:fs';
import path from 'node:path';
import { RefusedError, UsageError, exitCodeOf } from '../../core/store/errors.js';
import { findWorkspace, initStoreDir } from '../../core/store/workspace.js';
import { openRepo } from '../../core/code/git.js';
import { fetchPr, ghRunner, resolvePr } from '../../core/code/pr.js';
import { maxFilesOf } from '../../core/code/util.js';
import { specLabel } from '../../core/code/spec.js';
import { codeStats, skippedText } from '../../core/code/diff-text.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { shellArg } from '../format.js';
import { callOp, openContext, realpathOr, wsIdOfContext } from '../runtime.js';
import { showUrl, shownPrefix } from '../snapshot.js';
import { resolveBrowser } from './open.js';
import { networkRefusal } from '../fetch-url.js';

/** The modes a review can name (protocol.js CODE_MODES without 'pr', which is WP3b's `--pr`). */
const MODES = ['since-base', 'uncommitted', 'staged', 'branch', 'range', 'commit'];

export const spec = {
  name: 'review',
  usage:
    'review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha> | --pr <n|url>] [--path <pathspec>]... [--context N] [--max-files N] [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: 'Open a code review of your changes (since-base, uncommitted, staged, range, commit) or of a GitHub PR, print the review URL and the wait command, and return.',
  options: {
    uncommitted: { type: 'boolean' },
    staged: { type: 'boolean' },
    base: { type: 'string' },
    committed: { type: 'boolean' },
    commit: { type: 'string' },
    pr: { type: 'string' },
    path: { type: 'string', multiple: true },
    context: { type: 'string' },
    'max-files': { type: 'string' },
    title: { type: 'string' },
    browser: { type: 'string' },
  },
  details: [
    'Default: the merge-base with the default branch (code.defaultBase, else origin/HEAD, else main/master/trunk/develop)',
    '  up to the working tree, untracked files included; on the default branch, detached, or with no base: --uncommitted.',
    '<range>: A..B (A to B) or A...B (merge-base of A and B to B). --base <ref> --committed: up to HEAD, not the working tree.',
    '--path limits the review to pathspecs (repeatable). --context: lines around each change (default 3).',
    'Running it again with the same spec records a new round when the files changed, and reopens the tab.',
    '--pr <n|url>: a GitHub PR, through gh (signed in). Checked out (gh pr checkout): its merge-base .. your working tree;',
    '  otherwise its head, fetched once from the remote of its repository (line numbers are the PR head; check it out to',
    '  edit). The only review that uses the network (refused when SPECREVIEW_OFFLINE=1); run it again for new PR commits.',
    'Then run the printed `specreview wait` in the background; after editing the files, `specreview revise <doc> --replies -`.',
    '--browser system (default) | pane | none, as for open; $SPECREVIEW_BROWSER changes the default.',
  ],
};

/**
 * The normalised input of `review` (and of MCP specreview_review): what src/core/code/review.js openCodeReview takes.
 * `mode` is omitted for the default (since-base, else uncommitted: decided by the engine).
 * @typedef {object} ReviewInput
 * @property {'since-base' | 'uncommitted' | 'staged' | 'branch' | 'range' | 'commit'} [mode]
 * @property {string} [base] --base <ref> (since-base, branch)
 * @property {string} [range] 'A..B' | 'A...B' (range)
 * @property {string} [commit] --commit <sha> (commit)
 * @property {string[]} [paths] --path pathspecs
 * @property {number} [context] --context N
 * @property {number} [maxFiles] --max-files N
 */

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<{ input: ReviewInput, pr?: string, title?: string, browser: 'pane' | 'system' | 'none' }>}
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('review', positionals, 0, 1, spec.usage);
  const [range] = positionals;
  const picked = [range !== undefined && '<range>', values.uncommitted && '--uncommitted', values.staged && '--staged', values.base !== undefined && '--base', values.commit !== undefined && '--commit', values.pr !== undefined && '--pr'].filter(Boolean);
  if (picked.length > 1) throw new UsageError(`review: pick one of <range>, --uncommitted, --staged, --base, --commit, --pr (got ${picked.join(' and ')})`);
  if (values.committed && values.base === undefined) throw new UsageError('review: --committed goes with --base <ref>');
  return {
    ...(values.pr !== undefined ? { pr: /** @type {string} */ (values.pr) } : {}),
    input: reviewInput({
      range,
      uncommitted: Boolean(values.uncommitted),
      staged: Boolean(values.staged),
      base: values.base,
      committed: Boolean(values.committed),
      commit: values.commit,
      paths: values.path,
      context: values.context,
      maxFiles: values['max-files'],
    }),
    title: /** @type {string | undefined} */ (values.title),
    browser: resolveBrowser(/** @type {string | undefined} */ (values.browser), rt.env),
  };
}

/**
 * Flags (CLI) or an explicit mode with its fields (MCP specreview_review) -> ReviewInput. A mode's own field is
 * required (range: range, commit: commit, branch: base) and fields of other modes are refused.
 * @param {{ range?: string, uncommitted?: boolean, staged?: boolean, base?: string, committed?: boolean, commit?: string,
 *   paths?: string[], context?: string | number, maxFiles?: string | number, mode?: string }} o
 * @returns {ReviewInput}
 */
export function reviewInput(o) {
  const mode =
    o.mode ??
    (o.range !== undefined ? 'range' : o.uncommitted ? 'uncommitted' : o.staged ? 'staged' : o.base !== undefined ? (o.committed ? 'branch' : 'since-base') : o.commit !== undefined ? 'commit' : undefined);
  if (mode !== undefined && !MODES.includes(mode)) throw new UsageError(`review: mode must be one of ${MODES.join(', ')}, got "${mode}"`);
  /** @type {ReviewInput} */
  const input = mode === undefined ? {} : { mode: /** @type {ReviewInput['mode']} */ (mode) };
  const allowed = { range: mode === 'range', commit: mode === 'commit', base: mode === undefined || mode === 'since-base' || mode === 'branch' };
  for (const k of /** @type {const} */ (['range', 'commit', 'base'])) {
    if (o[k] !== undefined && !allowed[k]) throw new UsageError(`review: ${k} does not go with mode ${mode}`);
  }
  if (mode === 'range') {
    if (o.range === undefined || !/^[^.\s]\S*?\.\.\.?[^.\s]\S*$/.test(o.range)) throw new UsageError(`review: the range must be A..B or A...B, got "${o.range ?? ''}"`);
    input.range = o.range;
  }
  if (mode === 'commit') input.commit = nonEmpty(/** @type {string} */ (o.commit), '--commit');
  if (mode === 'branch' && o.base === undefined) throw new UsageError('review: mode branch needs a base (--base <ref> --committed)');
  if (o.base !== undefined) input.base = nonEmpty(o.base, '--base');
  if (o.paths?.length) input.paths = o.paths.map((p) => nonEmpty(p, '--path'));
  if (o.context !== undefined) input.context = intArg(o.context, '--context', 0);
  if (o.maxFiles !== undefined) input.maxFiles = intArg(o.maxFiles, '--max-files', 1);
  return input;
}

/**
 * @param {string} s
 * @param {string} flag
 * @returns {string}
 */
function nonEmpty(s, flag) {
  if (typeof s !== 'string' || !s.trim() || s.startsWith('-')) throw new UsageError(`review: ${flag} needs a value`);
  return s;
}

/**
 * @param {string | number} v
 * @param {string} flag
 * @param {number} min
 * @returns {number}
 */
function intArg(v, flag, min) {
  const n = typeof v === 'number' ? v : /^\d{1,7}$/.test(String(v).trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new UsageError(`review: ${flag} must be an integer >= ${min}, got "${v}"`);
  return n;
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ input: ReviewInput, pr?: string, title?: string, browser?: 'pane' | 'system' | 'none' }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const browser = input.browser ?? resolveBrowser(undefined, rt.env);
  // the workspace of a code review is the repository top level (repo-relative paths are workspace paths)
  const root = rt.workspace ?? (await openRepo(rt.cwd, { allowSubdir: true })).root;
  /** @type {any} */
  let engineInput = input.input ?? {};
  /** @type {{ checkedOut: boolean, fetched: boolean, remote: string | null } | null} */
  let prState = null;
  if (input.pr !== undefined) {
    // gh and the one fetch run here, before the store exists: a refused or failed PR leaves nothing behind
    const why = networkRefusal(rt.env);
    if (why) throw new RefusedError(`review --pr uses the network (gh, git fetch), and ${why}`, { details: { offline: true } });
    const pr = await resolvePr(ghRunner(rt.deps, rt.env), input.pr, { maxFiles: maxFilesOf(engineInput.maxFiles ?? null, workspaceConfig(root)) });
    prState = await fetchPr(await openRepo(root), pr);
    engineInput = { ...engineInput, mode: 'pr', pr };
  }
  const ws = await findWorkspace(root, { create: false, explicitRoot: root });
  const storeCreated = !ws.exists;
  if (storeCreated) await initStoreDir(ws.root);
  const { ctx, engine } = await openContext(rt, { create: true, root: ws.root });
  const res = await callOp(engine, 'openCodeReview', ctx, { input: engineInput, title: input.title });
  const doc = res.doc;
  const code = res.code;
  const wsId = wsIdOfContext(ctx) || ws.wsId;
  const ref = await reviewRef(rt, doc.id, ws.root);

  /** @type {import('../../shared/types.js').DaemonInfo | null} */
  let info = null;
  /** @type {unknown} */
  let daemonError = null;
  try {
    info = await rt.ensureDaemon();
  } catch (err) {
    daemonError = err;
  }
  /** @type {string[]} */
  const stderr = [];
  const url = info ? rt.reviewUrl(info, wsId, doc.id) : null;
  const shown = url ? await showUrl(rt, url, browser, stderr) : 'none';

  const v = res.version?.v ?? doc.head;
  const st = codeStats(code.files);
  const label = specLabel(doc.code, code);
  const what = res.created ? `v${v}` : res.recorded ? `recorded round v${v}` : `unchanged since v${v}`;
  const lines = [`specreview: code review ${doc.id} ${what} · ${label}`];
  const skipped = code.skipped.length ? ` · skipped: ${skippedText(code.skipped)}` : '';
  lines.push(`  ${st.files} file${st.files === 1 ? '' : 's'} · +${st.added} -${st.removed}${skipped}`);
  const pr = engineInput.pr;
  if (pr) {
    lines.push(`  ${pr.url}`);
    if (code.newSide !== 'worktree') lines.push(`  PR #${pr.number} is not checked out here: line numbers are its head ${String(code.newSha ?? '').slice(0, 7)}; run \`gh pr checkout ${pr.number}\` before editing`);
  }
  lines.push(url ? `  review UI: ${url}` : `  review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`);
  lines.push(`next: ${shownPrefix(shown)}run \`specreview wait ${ref}\` in the background`);
  if (storeCreated) lines.push(`created ${path.join(ws.root, '.specreview')}/ (the SpecReview store; reviews never include it)`);
  if (daemonError) {
    stderr.push(`specreview: the review server could not be started: ${/** @type {Error} */ (daemonError).message} (the review is recorded; run \`specreview doctor\`)`);
  }
  const spec = /** @type {any} */ (doc.code ?? {});
  const json = {
    doc: doc.id,
    kind: 'code',
    created: Boolean(res.created),
    version: v,
    recorded: Boolean(res.recorded),
    mode: spec.mode,
    base: spec.base ?? null,
    baseSha: code.baseSha,
    headSha: code.headSha ?? null,
    newSha: code.newSha ?? null,
    worktree: code.newSide === 'worktree',
    root: ws.root,
    files: code.files.map((f) => ({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, added: f.added ?? 0, removed: f.removed ?? 0 })),
    skipped: code.skipped.map((x) => ({ path: x.path, reason: x.reason })),
    stats: st,
    url,
    wsId,
    ref,
    ...(pr ? { pr: { repo: pr.repo, number: pr.number, url: pr.url, checkedOut: code.newSide === 'worktree', fetched: Boolean(prState?.fetched) } } : {}),
    ...(daemonError ? { error: { message: /** @type {Error} */ (daemonError).message } } : {}),
  };
  return { exit: daemonError ? exitCodeOf(daemonError) || EXIT.ERROR : EXIT.OK, text: lines.join('\n'), stderr, json };
}

/**
 * The workspace's config.json (for code.maxFiles), read without creating the store; null when there is none.
 * @param {string} root
 * @returns {any}
 */
function workspaceConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.specreview', 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * How follow-up commands run from the cwd name the review: its id when workspace discovery from the cwd finds the
 * review's workspace, else the id with `--workspace <root>` (relative to the cwd).
 * @param {import('../runtime.js').Runtime} rt
 * @param {string} docId
 * @param {string} root
 * @returns {Promise<string>}
 */
async function reviewRef(rt, docId, root) {
  const real = realpathOr(root);
  try {
    const here = await findWorkspace(rt.cwd, { create: false });
    if (here.exists && realpathOr(here.root) === real) return docId;
  } catch {
    // no workspace from the cwd ($HOME, /): name the root
  }
  return `${docId} --workspace ${shellArg(path.relative(realpathOr(rt.cwd), real) || '.')}`;
}
