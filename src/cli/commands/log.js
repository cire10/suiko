// @ts-check
// `suiko log <doc> [--json]` (design 9.6): the timeline of versions and reviews (engine log + formatLog).

import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { FALLBACK_FORMATTERS } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'log',
  usage: 'log <doc> [--json]',
  summary: 'Timeline of versions and reviews.',
  options: {},
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ positionals }) {
  expectPositionals('log', positionals, 1, 1, spec.usage);
  return { doc: positionals[0] };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const log = await callOp(engine, 'log', ctx, docId);
  return {
    exit: EXIT.OK,
    text: typeof log === 'string' ? log : typeof log?.text === 'string' ? log.text : formatWith(engine, 'formatLog', log, () => FALLBACK_FORMATTERS.formatLog(log)),
    json: typeof log === 'string' ? { doc: docId, text: log } : Array.isArray(log) ? { doc: docId, entries: log } : log,
  };
}
