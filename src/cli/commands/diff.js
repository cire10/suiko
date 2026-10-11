// @ts-check
// `specreview diff <doc> [vA..vB] [--stat|--unified] [--json]` (design 9.2 / 9.6).
// Range forms: v1..v2, 1..live, v2 (= v2..head), ..v3, v2.. ; default = last reviewed..head (engine default).
// --stat (default): per-hunk summary with thread links (engine changes() + formatDiffStat).
// --unified: a git-compatible unified patch (engine unifiedDiff() when present, else built from the store's
// version sources with the diff module's unifiedPatch()). --json prints the Changes object (or {from,to,patch}).

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, parseDiffRange } from '../args.js';
import { formatWith } from '../engine.js';
import { FALLBACK_FORMATTERS } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'diff',
  usage: 'diff <doc> [vA..vB] [--stat|--unified] [--json]',
  summary: 'Show what changed between two versions (default: your last reviewed version..head).',
  options: { stat: { type: 'boolean' }, unified: { type: 'boolean' } },
  details: ['Ranges: v1..v2, v2 (= v2..head), v3..live (unrecorded edits), ..v3.'],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('diff', positionals, 1, 2, spec.usage);
  if (values.stat && values.unified) throw new UsageError('diff: pass either --stat or --unified');
  const { from, to } = parseDiffRange(positionals[1]);
  return { doc: positionals[0], from, to, format: values.unified ? 'unified' : 'stat' };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, from?: number | 'live' | 'head', to?: number | 'live' | 'head', format?: 'stat' | 'unified' }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const resolve = (/** @type {number | 'live' | 'head' | undefined} */ v) => (v === 'head' ? doc.head : v);
  const from = resolve(input.from);
  const to = resolve(input.to);
  if (input.format === 'unified') {
    const range = defaultRange(doc, from, to);
    const patch =
      typeof engine.ops.unifiedDiff === 'function'
        ? await engine.ops.unifiedDiff(ctx, docId, range)
        : await unifiedFromStore(ctx, doc, range.from, range.to);
    const text = typeof patch === 'string' ? patch : String(patch?.patch ?? '');
    return {
      exit: EXIT.OK,
      text: text.replace(/\n$/, '') || `no changes between ${label(range.from)} and ${label(range.to)}`,
      json: { doc: docId, from: range.from, to: range.to, patch: text },
    };
  }
  const changes = await callOp(engine, 'changes', ctx, docId, { from, to });
  const shown = { from: changes?.from ?? from, to: changes?.to ?? to, ...changes };
  return { exit: EXIT.OK, text: formatWith(engine, 'formatDiffStat', shown, () => FALLBACK_FORMATTERS.formatDiffStat(shown)), json: { doc: docId, ...shown } };
}

/**
 * Default range for the unified fallback: last reviewed (else v1)..head.
 * @param {any} doc
 * @param {number | 'live' | undefined} from
 * @param {number | 'live' | undefined} to
 * @returns {{ from: number | 'live', to: number | 'live' }}
 */
function defaultRange(doc, from, to) {
  return { from: from ?? doc.lastReviewedVersion ?? 1, to: to ?? doc.head };
}

/**
 * @param {number | 'live'} v
 * @returns {string}
 */
function label(v) {
  return v === 'live' ? 'the working copy' : `v${v}`;
}

/**
 * @param {any} ctx
 * @param {any} doc
 * @param {number | 'live'} from
 * @param {number | 'live'} to
 * @returns {Promise<string>}
 */
async function unifiedFromStore(ctx, doc, from, to) {
  const store = ctx?.store;
  if (!store) throw new UsageError('diff --unified: the review engine has no store');
  const read = async (/** @type {number | 'live'} */ v) =>
    v === 'live' ? (await store.readWorking(doc)).text : (await store.readVersion(doc.id, v)).source;
  const [a, b] = await Promise.all([read(from), read(to)]);
  const { unifiedPatch } = await import('../../core/diff/index.js');
  const tag = (/** @type {number | 'live'} */ v) => (v === 'live' ? 'live' : `v${v}`);
  return unifiedPatch(a, b, { fromLabel: `${tag(from)}/${doc.path}`, toLabel: `${tag(to)}/${doc.path}` });
}
