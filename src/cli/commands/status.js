// @ts-check
// `suiko status [<doc>] [--json]` (design 9.6 / 9.8 "polling"): docs, head, thread counts, undelivered
// reviews, listening agents and the working-copy state. Without <doc>: every doc of the workspace found from the
// cwd (or --workspace). The engine's status(ctx, docId | null) is used; when it does not accept null, the per-doc
// results are collected. Outside any workspace it prints "no tracked docs" and exits 0.

import { NotFoundError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { FALLBACK_FORMATTERS } from '../format.js';
import { callOp, docContext, openContext } from '../runtime.js';

export const spec = {
  name: 'status',
  usage: 'status [<doc>] [--json]',
  summary: 'Docs, head versions, thread counts, undelivered reviews, listening agents, working-copy state.',
  options: {},
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ positionals }) {
  expectPositionals('status', positionals, 0, 1, spec.usage);
  return { doc: positionals[0] };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.doc) {
    const { ctx, engine, docId } = await docContext(rt, input.doc);
    const s = await callOp(engine, 'status', ctx, docId);
    return { exit: EXIT.OK, text: render(engine, s), json: s };
  }
  /** @type {{ ctx: any, engine: import('../engine.js').Engine }} */
  let opened;
  try {
    opened = await openContext(rt);
  } catch (err) {
    if (err instanceof NotFoundError) return noDocs();
    throw err;
  }
  const { ctx, engine } = opened;
  const docs = ctx?.store?.listDocs ? await ctx.store.listDocs() : null;
  if (docs && docs.length === 0) return noDocs();
  /** @type {any} */
  let s;
  try {
    s = await callOp(engine, 'status', ctx, null);
  } catch (err) {
    if (!docs) throw err;
    s = { docs: await Promise.all(docs.map((/** @type {any} */ d) => callOp(engine, 'status', ctx, d.id))) };
  }
  return { exit: EXIT.OK, text: render(engine, s), json: Array.isArray(s) ? { docs: s } : s };
}

/**
 * @param {import('../engine.js').Engine} engine
 * @param {any} s
 * @returns {string}
 */
function render(engine, s) {
  if (typeof s === 'string') return s;
  if (typeof s?.text === 'string') return s.text;
  return formatWith(engine, 'formatStatus', s, () => FALLBACK_FORMATTERS.formatStatus(s));
}

/** @returns {import('../io.js').CommandResult} */
function noDocs() {
  return { exit: EXIT.OK, text: 'no tracked docs here (run `suiko open <file>` to start a review)', json: { docs: [] } };
}
