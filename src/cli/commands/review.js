// @ts-check
// `specreview review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha>]
//  [--path <pathspec>]... [--context N] [--max-files N] [--title T] [--browser pane|system|none] [--workspace <dir>]
//  [--json]` (design 4.2): opens a code review of the agent's changes (doc kind 'code') and returns at once with the
// review URL and the background `wait` command.
//
// STUB (WP0b): the final spec and argument parsing, so the registry, `--help`, the MCP tool specreview_review and the
// docs check see the real command. `execute` throws UsageError('code review is not available in this build') (exit
// 1) until WP3 replaces it (src/core/code/review.js openCodeReview(ctx, { input, title }) takes the parsed `input`).
//
//   review                              since-base: merge-base(<default base>, HEAD) .. working tree (+ untracked);
//                                       on the default branch, detached or without a base: uncommitted
//   review --uncommitted                HEAD .. working tree (+ untracked)
//   review --staged                     HEAD .. the index
//   review --base main [--committed]    merge-base(main, HEAD) .. working tree (--committed: .. HEAD, mode branch)
//   review A..B | A...B                 range (three-dot: merge-base(A, B) .. B)
//   review --commit <sha>               <sha>^ .. <sha>
// Exit: 0 open; 1 not a git repository, git too old, git failure; 3 refused (too many files, unmerged index entries
// with --staged, too many large untracked files); 4 base / range end / commit not found, or nothing to review.

import { UsageError } from '../../core/store/errors.js';
import { expectPositionals } from '../args.js';
import { resolveBrowser } from './open.js';

/** The modes a review can name (protocol.js CODE_MODES without 'pr', which is WP3b's `--pr`). */
const MODES = ['since-base', 'uncommitted', 'staged', 'branch', 'range', 'commit'];

export const spec = {
  name: 'review',
  usage:
    'review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha>] [--path <pathspec>]... [--context N] [--max-files N] [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: 'Open a code review of your changes (since-base, uncommitted, staged, range, commit), print the review URL and the wait command, and return.',
  options: {
    uncommitted: { type: 'boolean' },
    staged: { type: 'boolean' },
    base: { type: 'string' },
    committed: { type: 'boolean' },
    commit: { type: 'string' },
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
 * @returns {Promise<{ input: ReviewInput, title?: string, browser: 'pane' | 'system' | 'none' }>}
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('review', positionals, 0, 1, spec.usage);
  const [range] = positionals;
  const picked = [range !== undefined && '<range>', values.uncommitted && '--uncommitted', values.staged && '--staged', values.base !== undefined && '--base', values.commit !== undefined && '--commit'].filter(Boolean);
  if (picked.length > 1) throw new UsageError(`review: pick one of <range>, --uncommitted, --staged, --base, --commit (got ${picked.join(' and ')})`);
  if (values.committed && values.base === undefined) throw new UsageError('review: --committed goes with --base <ref>');
  return {
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
 * @param {{ input: ReviewInput, title?: string, browser?: 'pane' | 'system' | 'none' }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  void [rt, input];
  throw new UsageError('code review is not available in this build', { details: { kind: 'code' } });
}
