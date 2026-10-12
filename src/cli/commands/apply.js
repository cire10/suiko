// @ts-check
// `suiko apply <doc> <tid...> [--dry-run] [--json]` (design 9.4).
// Applies suggestion threads verbatim to the working copy and stages them as tagged edits (recorded by the next
// `revise`). Prints one line per thread:
//   applied t3 at L120 (exact) · staged (not recorded yet)
//   conflict t5: expected text not found near L88; treat as a normal comment
// Exit 0 when everything applied, 3 when any thread conflicted.

import { EXIT } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { rangeText } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'apply',
  usage: 'apply <doc> <tid...> [--dry-run] [--json]',
  summary: 'Apply suggestion threads verbatim to the working copy (staged until the next revise).',
  options: { 'dry-run': { type: 'boolean' } },
  details: [
    'Do your Edit-tool edits first, then apply; apply rewrites the file, so re-read it before editing again.',
    'A conflict means the suggested text is no longer where it was: treat the thread as a normal comment.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('apply', positionals, 2, Infinity, spec.usage);
  const [doc, ...threads] = positionals;
  const ids = [...new Set(threads.flatMap((t) => t.split(',')).filter(Boolean))];
  for (const id of ids) assertThreadId(id, 'apply');
  return { doc, threads: ids, dryRun: Boolean(values['dry-run']) };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, threads: string[], dryRun?: boolean }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = (await callOp(engine, 'applySuggestions', ctx, docId, input.threads, { dryRun: Boolean(input.dryRun) })) ?? {};
  const applied = Array.isArray(res.applied) ? res.applied : [];
  const conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
  const text = formatWith(engine, 'formatApply', { dryRun: Boolean(input.dryRun), skipped: [], ...res, applied, conflicts }, () =>
    fallbackText(applied, conflicts, Boolean(input.dryRun), docId),
  );
  return {
    exit: conflicts.length ? EXIT.REFUSED : EXIT.OK,
    text: text || 'nothing to apply',
    json: { doc: docId, dryRun: Boolean(input.dryRun), ...res, applied, conflicts },
  };
}

/**
 * @param {any[]} applied
 * @param {any[]} conflicts
 * @param {boolean} dryRun
 * @param {string} docId
 * @returns {string}
 */
function fallbackText(applied, conflicts, dryRun, docId) {
  const lines = [];
  for (const a of applied) {
    const where = rangeText(a.lines) || (typeof a.line === 'number' ? `L${a.line}` : '');
    const how = a.how ?? a.match ?? a.mode ?? null;
    const at = where ? ` at ${where}${how ? ` (${how})` : ''}` : '';
    lines.push(dryRun ? `would apply ${a.id}${at} · dry run, nothing changed` : `applied ${a.id}${at} · staged (not recorded yet)`);
  }
  for (const c of conflicts) {
    lines.push(`conflict ${c.id}: ${c.reason ?? 'expected text not found'}; treat as a normal comment`);
  }
  if (applied.length && !dryRun) {
    lines.push(`the file changed on disk: re-read ${docId} before editing it again; record with \`suiko revise ${docId} --replies -\``);
  }
  return lines.join('\n');
}
