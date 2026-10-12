// @ts-check
// `specreview reanchor <doc> <tid> (--lines A-B | --quote TEXT) [--json]` (design 9.2, agent-protocol 10).
// `specreview reanchor <code-doc> <tid> [--file <path>] --lines A-B` (design 4.2): lines of the working file now
// (default: the file the thread is on).
// Agent override of a thread's anchor: applied to head when the working copy is clean, otherwise staged until the
// next revise. The engine receives { lines: [a, b] } (inclusive, 1-based) or { quote } (and { file } for code).
// Exit 0; 3 when the quote is not found / not unique; 4 unknown doc or thread.

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals, parseSingleRange } from '../args.js';
import { anchorLines, excerpt, rangeText } from '../format.js';
import { callOp, docContext } from '../runtime.js';
import { codeWhere } from './ask.js';

export const spec = {
  name: 'reanchor',
  usage: 'reanchor <doc> <tid> (--lines A-B | --quote TEXT) [--file <path>] [--json]',
  summary: "Move a thread's anchor to other lines or to an exact quote of the working copy.",
  options: { lines: { type: 'string' }, quote: { type: 'string' }, file: { type: 'string' } },
  details: ['Code reviews: [--file <path>] --lines A-B, lines of the working file now (default file: the thread\'s).'],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('reanchor', positionals, 2, 2, spec.usage);
  assertThreadId(positionals[1], 'reanchor');
  return {
    doc: positionals[0],
    thread: positionals[1],
    lines: values.lines !== undefined ? parseSingleRange(values.lines) : undefined,
    quote: values.quote,
    ...(values.file !== undefined ? { file: values.file } : {}),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, thread: string, lines?: [number, number], quote?: string, file?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (Boolean(input.lines) === Boolean(input.quote)) throw new UsageError('reanchor: pass exactly one of --lines A-B or --quote TEXT');
  if (input.quote !== undefined && !input.quote.trim()) throw new UsageError('reanchor: --quote must not be empty');
  if (input.file !== undefined && !String(input.file).trim()) throw new UsageError('reanchor: --file needs a path');
  if (input.file && input.quote) throw new UsageError('reanchor: --file goes with --lines A-B (code reviews take no --quote)');
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = await callOp(engine, 'reanchorThread', ctx, docId, input.thread, { lines: input.lines, quote: input.quote, ...(input.file ? { file: input.file } : {}) });
  const anchor = res?.anchor ?? res;
  const staged = Boolean(res?.staged ?? anchor?.staged);
  const lines = rangeText(anchorLines(anchor)) || rangeText(input.lines);
  const codeFile = anchor?.file?.path ?? res?.thread?.override?.file ?? null;
  const where = codeFile ? codeWhere({ file: { path: codeFile } }, lines) : lines || `"${excerpt(input.quote, 40)}"`;
  const state = anchor?.state ? ` (${anchor.state})` : '';
  const version = anchor?.v ?? res?.version;
  return {
    exit: EXIT.OK,
    text: `re-anchored ${input.thread} to ${where}${state} · ${staged ? 'staged until the next revise' : `applied to head${version ? ` v${version}` : ''}`}`,
    json: { doc: docId, thread: input.thread, staged, anchor: anchor ?? null },
  };
}
