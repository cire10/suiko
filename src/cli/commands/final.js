// @ts-check
// `suiko final <doc> [--decisions] [--out <dir>] [--json]` (design 3.12 / 8.9).
// Checks that the working copy equals the final (approved) version and, with --decisions, writes
// `<name>.decisions.md`. Exit 0; 3 when the doc has no final version or the working copy differs.

import path from 'node:path';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'final',
  usage: 'final <doc> [--decisions] [--out <dir>] [--json]',
  summary: 'Check the final (approved) version against the working copy and export the decisions.',
  options: { decisions: { type: 'boolean' }, out: { type: 'string' } },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('final', positionals, 1, 1, spec.usage);
  return {
    doc: positionals[0],
    decisions: Boolean(values.decisions),
    outDir: values.out !== undefined ? path.resolve(rt.cwd, values.out) : undefined,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, decisions?: boolean, outDir?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const res = (await callOp(engine, 'finalize', ctx, docId, { decisions: Boolean(input.decisions), outDir: input.outDir })) ?? {};
  const text = formatWith(engine, 'formatFinal', res, () => render(res, doc));
  // WP3 throws RefusedError (exit 3) when there is no final version or the working copy differs; a result that
  // reports the mismatch instead is refused the same way
  return { exit: res.ok === false || res.workingMatches === false ? EXIT.REFUSED : EXIT.OK, text, json: { doc: docId, ...res } };
}

/**
 * @param {any} res
 * @param {any} doc
 * @returns {string}
 */
function render(res, doc) {
  if (typeof res.text === 'string') return res.text;
  const out = [];
  const final = res.final ?? doc.final;
  if (final?.version) {
    out.push(`final: ${doc.id} = v${final.version}${final.review ? ` (approved in ${final.review}${final.by ? ` by ${final.by?.name ?? final.by}` : ''})` : ''}`);
  }
  if (res.workingMatches !== undefined) {
    out.push(`working copy matches v${final?.version ?? '?'}: ${res.workingMatches ? 'ok' : 'NO (record or revert the differences)'}`);
  }
  const wrote = Array.isArray(res.wrote) ? res.wrote : Array.isArray(res.paths) ? res.paths : res.decisionsPath ? [res.decisionsPath] : [];
  for (const p of wrote) out.push(`wrote ${p}`);
  return out.join('\n') || `final: ${doc.id}`;
}
