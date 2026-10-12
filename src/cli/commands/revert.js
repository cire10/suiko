// @ts-check
// `suiko revert <doc> (--hunk hN | --lock L1) [--json]` (design 8.9).
// --hunk reverses one unrecorded head->working hunk in the working copy; --lock writes the agreed text of a lock
// back over its mapped range. Nothing is recorded. Exit 0; 3 on conflict; 4 unknown hunk/lock.

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { rangeText } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'revert',
  usage: 'revert <doc> (--hunk hN | --lock L1) [--json]',
  summary: 'Undo one unrecorded hunk in the working copy, or restore the agreed text of a lock.',
  options: { hunk: { type: 'string' }, lock: { type: 'string' } },
  details: ['Hunk ids (h1, h2...) are those printed by a refused `revise` or by `suiko diff <doc> head..live`.', 'Never revert a change you did not make.'],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('revert', positionals, 1, 1, spec.usage);
  return { doc: positionals[0], hunk: values.hunk, lock: values.lock };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, hunk?: string, lock?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (Boolean(input.hunk) === Boolean(input.lock)) throw new UsageError('revert: pass exactly one of --hunk hN or --lock L1');
  if (input.hunk && !/^h\d+$/.test(input.hunk)) throw new UsageError(`revert: invalid hunk id "${input.hunk}" (expected h<n>)`);
  if (input.lock && !/^L\d+$/.test(input.lock)) throw new UsageError(`revert: invalid lock id "${input.lock}" (expected L<n>)`);
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = (await callOp(engine, 'revert', ctx, docId, { hunk: input.hunk, lock: input.lock })) ?? {};
  const what = input.hunk ? `hunk ${input.hunk}` : `lock ${input.lock}`;
  const where = rangeText(res.lines) ? ` (now ${rangeText(res.lines)})` : '';
  const text = formatWith(engine, 'formatRevert', { hunk: input.hunk, lock: input.lock, ...res }, () =>
    res.noop ? `nothing to revert: ${res.reason ?? 'already as recorded'}` : `reverted ${what} in the working copy${where} · not recorded yet; re-read ${docId} before editing it again`,
  );
  return { exit: EXIT.OK, text, json: { doc: docId, hunk: input.hunk ?? null, lock: input.lock ?? null, ...res } };
}
