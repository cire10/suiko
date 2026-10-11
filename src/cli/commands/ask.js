// @ts-check
// `specreview ask <doc> (--quote TEXT | --lines A-B) -m <question> [--json]` (design 9.2).
// Creates an `agent-question` thread (status needs_input) anchored on head; the reviewer's answer arrives in a
// later packet labelled ANSWER. Exit 0; 3 when the quote is not found / not unique; 4 unknown doc.

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, parseSingleRange } from '../args.js';
import { formatWith } from '../engine.js';
import { anchorLines, headAnchor, rangeText } from '../format.js';
import { callOp, docContext } from '../runtime.js';
import { threadSummary } from './reply.js';

export const spec = {
  name: 'ask',
  usage: 'ask <doc> (--quote TEXT | --lines A-B) -m <question> [--json]',
  summary: 'Ask the reviewer a question anchored on the doc (creates an agent-question thread).',
  options: { quote: { type: 'string' }, lines: { type: 'string' }, message: { type: 'string', short: 'm' } },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('ask', positionals, 1, 1, spec.usage);
  return {
    doc: positionals[0],
    quote: values.quote,
    lines: values.lines !== undefined ? parseSingleRange(values.lines) : undefined,
    body: values.message,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, quote?: string, lines?: [number, number], body?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (Boolean(input.quote) === Boolean(input.lines)) throw new UsageError('ask: pass exactly one of --quote TEXT or --lines A-B');
  if (!input.body || !input.body.trim()) throw new UsageError('ask: -m <question> is required');
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const res = await callOp(engine, 'ask', ctx, docId, { quote: input.quote, lines: input.lines, body: input.body });
  const summary = threadSummary(res, '?');
  const t = res?.thread ?? res;
  const where = rangeText(res?.lines) || rangeText(anchorLines(headAnchor(t, doc.head))) || rangeText(input.lines);
  const text = formatWith(engine, 'formatAsk', res, () =>
    `asked ${summary.id} (agent-question, needs_input)${where ? ` at ${where}` : ''} · ` +
    'the reviewer answers in the UI; the answer arrives in a later packet as ANSWER',
  );
  return { exit: EXIT.OK, text, json: { doc: docId, ...summary, lines: where || null } };
}
