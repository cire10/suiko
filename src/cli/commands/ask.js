// @ts-check
// `suiko ask <doc> (--quote TEXT | --lines A-B) -m <question> [--json]` (design 9.2).
// `suiko ask <code-doc> [--file <path> [--lines A-B]] -m <question>` (design 4.2): in a code review the lines
// are lines of the working file now (mapped onto the head round); --file alone asks about the whole file, neither
// about the whole review.
// Creates an `agent-question` thread (status needs_input) anchored on head; the reviewer's answer arrives in a
// later packet labelled ANSWER. Exit 0; 3 when the quote is not found / not unique (code: the lines exist only in
// the working tree); 4 unknown doc (or file of the review).

import { UsageError } from '../../core/store/errors.js';
import { isCode } from '../../core/store/snapshot.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, parseSingleRange } from '../args.js';
import { formatWith } from '../engine.js';
import { anchorLines, headAnchor, rangeText } from '../format.js';
import { callOp, docContext } from '../runtime.js';
import { threadSummary } from './reply.js';

export const spec = {
  name: 'ask',
  usage: 'ask <doc> (--quote TEXT | --lines A-B | --file <path> [--lines A-B]) -m <question> [--json]',
  summary: 'Ask the reviewer a question anchored on the doc (creates an agent-question thread).',
  options: { quote: { type: 'string' }, lines: { type: 'string' }, file: { type: 'string' }, message: { type: 'string', short: 'm' } },
  details: [
    'Code reviews: --file <path> --lines A-B (lines of the working file now), --file alone (the whole file), or',
    '  neither (the whole review). --quote is for specs.',
  ],
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
    ...(values.file !== undefined ? { file: values.file } : {}),
    body: values.message,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, quote?: string, lines?: [number, number], file?: string, body?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.file !== undefined && !String(input.file).trim()) throw new UsageError('ask: --file needs a path');
  if (input.file && input.quote) throw new UsageError('ask: --file goes with --lines A-B (code reviews take no --quote)');
  if (!input.file && input.quote && input.lines) throw new UsageError('ask: pass exactly one of --quote TEXT or --lines A-B');
  if (!input.body || !input.body.trim()) throw new UsageError('ask: -m <question> is required');
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const code = isCode(doc);
  if (!code && Boolean(input.quote) === Boolean(input.lines)) throw new UsageError('ask: pass exactly one of --quote TEXT or --lines A-B');
  const res = await callOp(engine, 'ask', ctx, docId, { quote: input.quote, lines: input.lines, body: input.body, ...(input.file ? { file: input.file } : {}) });
  const summary = threadSummary(res, '?');
  const t = res?.thread ?? res;
  const lines = rangeText(res?.lines) || rangeText(anchorLines(headAnchor(t, doc.head))) || rangeText(input.lines);
  const where = code ? codeWhere(headAnchor(t, res?.version ?? doc.head), lines) : lines;
  const text = formatWith(engine, 'formatAsk', res, () =>
    `asked ${summary.id} (agent-question, needs_input)${where ? ` at ${where}` : ''} · ` +
    'the reviewer answers in the UI; the answer arrives in a later packet as ANSWER',
  );
  return { exit: EXIT.OK, text, json: { doc: docId, ...summary, lines: lines || null, ...(code ? { file: headAnchor(t, res?.version ?? doc.head)?.file?.path ?? null } : {}) } };
}

/**
 * Where a code thread is: 'src/a.js:L3-4', 'src/a.js (whole file)', 'the whole review'.
 * @param {any} anchor
 * @param {string} lines
 * @returns {string}
 */
export function codeWhere(anchor, lines) {
  const file = anchor?.file?.path;
  if (!file) return 'the whole review';
  if (anchor.kind === 'doc' || !lines) return `${file} (whole file)`;
  return `${file}:${lines}`;
}
