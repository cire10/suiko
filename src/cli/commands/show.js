// @ts-check
// `suiko show <doc> [<tid>] [--version N] [--lines A-B] [--json]` (design 9.2 / 9.6).
// A thread with its full timeline, or the exact source of a version (`--version 2 --lines 40-60`; `head`, or `live`
// for the working copy via the engine's sourceLines()).
// The engine's show(ctx, docId, { thread, version, lines }) result is printed as: its `text` when it has one;
// formatThread(result) for a thread ({ thread, timeline, ... } or a bare Thread), plus the working-copy `src>` lines
// and `crop:`/`image:` paths a packet item would carry (format.js withThreadSource); for source lines
// ({ startLine, lines }) the engine's formatSourceLines (raw lines, copyable) or numbered lines; else a generic
// rendering.
// `show <code-doc> --file <path> [--version N] [--side new|old] [--lines A-B]` prints the lines of a repo file of a
// round (the stored blob: new side by default), numbered; --json gives them raw.
// Exit 0; 4 when the doc, thread, version or file does not exist.

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals, parseSingleRange, parseVersionRef } from '../args.js';
import { FALLBACK_FORMATTERS, genericText, withThreadSource } from '../format.js';
import { formatWith } from '../engine.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'show',
  usage: 'show <doc> [<tid>] [--version N] [--lines A-B] [--file <path> [--side new|old]] [--json]',
  summary: 'Show a thread with its timeline, or the exact source lines of a version.',
  options: { version: { type: 'string' }, lines: { type: 'string' }, file: { type: 'string' }, side: { type: 'string' } },
  details: ['Code reviews: --file <path> [--side new|old] prints that file of a round (default: head, new side).'],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('show', positionals, 1, 2, spec.usage);
  if (positionals[1]) assertThreadId(positionals[1], 'show');
  return {
    doc: positionals[0],
    thread: positionals[1],
    version: values.version !== undefined ? parseVersionRef(values.version, 'show --version') : undefined,
    lines: values.lines !== undefined ? parseSingleRange(values.lines) : undefined,
    ...(values.file !== undefined ? { file: values.file } : {}),
    ...(values.side !== undefined ? { side: values.side } : {}),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, thread?: string, version?: number | 'live' | 'head', lines?: [number, number], file?: string,
 *   side?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.side !== undefined && input.side !== 'new' && input.side !== 'old') throw new UsageError('show: --side must be new or old');
  if (input.side !== undefined && !input.file) throw new UsageError('show: --side goes with --file <path>');
  if (input.file !== undefined && !String(input.file).trim()) throw new UsageError('show: --file needs a path');
  if (input.file && input.thread) throw new UsageError('show: pass a thread id or --file <path>, not both');
  if (input.file && input.version === 'live') throw new UsageError('show: --file prints a recorded round (--version N); read the working file itself for the live text');
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const version = input.version === 'head' ? doc.head : input.version;
  if (input.file) {
    const res = await callOp(engine, 'show', ctx, docId, { version, file: input.file, side: input.side ?? 'new' });
    return codeSource(docId, res, input.lines);
  }
  /** @type {any} */
  let res;
  if (version === 'live' && !input.thread && typeof engine.ops.sourceLines === 'function') {
    // the working copy (unrecorded edits): the engine's show() covers recorded versions only
    const range = input.lines ?? [undefined, undefined];
    res = await engine.ops.sourceLines(ctx, docId, { version: 'live', from: range[0], to: range[1] });
  } else {
    res = await callOp(engine, 'show', ctx, docId, { thread: input.thread, version, lines: input.lines });
  }
  return { exit: EXIT.OK, text: renderShow(engine, res), json: typeof res === 'string' ? { doc: docId, text: res } : res };
}

/**
 * A repo file of a round (ops.show with `file`: { kind: 'code-source', path, side, v, text, lines }), numbered, cut
 * to `range` when given.
 * @param {string} docId
 * @param {any} res
 * @param {[number, number] | undefined} range
 * @returns {import('../io.js').CommandResult}
 */
function codeSource(docId, res, range) {
  const all = String(res.text ?? '').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const total = all.length;
  const from = Math.max(1, range?.[0] ?? 1);
  const to = Math.min(total, range?.[1] ?? total);
  const lines = from <= to ? all.slice(from - 1, to) : [];
  const width = String(Math.max(to, 1)).length;
  const side = res.side === 'old' ? ' (old side)' : '';
  const head = `${res.path}${side} · v${res.v} · ${lines.length ? `L${from}-${to} of ${total}` : total ? `no lines in L${range?.[0]}-${range?.[1]} (the file has ${total})` : 'empty file'}`;
  const body = lines.map((l, i) => `${String(from + i).padStart(width)}  ${l}`);
  return {
    exit: EXIT.OK,
    text: [head, ...body].join('\n'),
    json: { doc: docId, kind: 'code-source', path: res.path, side: res.side, version: res.v, lines: total, startLine: from, endLine: Math.max(from - 1, to), text: lines.length ? `${lines.join('\n')}\n` : '' },
  };
}

/**
 * @param {import('../engine.js').Engine} engine
 * @param {any} res
 * @returns {string}
 */
function renderShow(engine, res) {
  if (typeof res === 'string') return res;
  if (typeof res?.text === 'string') return res.text;
  const isThread = (res?.thread && typeof res.thread === 'object') || (res?.id && Array.isArray(res?.comments));
  if (isThread) return withThreadSource(formatWith(engine, 'formatThread', res, () => FALLBACK_FORMATTERS.formatThread(res)), res);
  if (Array.isArray(res?.lines) && typeof res?.startLine === 'number') {
    return formatWith(engine, 'formatSourceLines', res, () => {
      const width = String(res.startLine + res.lines.length - 1).length;
      const head = res.version !== undefined ? [`v${res.version} L${res.startLine}-${res.startLine + res.lines.length - 1}`] : [];
      return [...head, ...res.lines.map((/** @type {string} */ l, /** @type {number} */ i) => `${String(res.startLine + i).padStart(width)}  ${l}`)].join('\n');
    });
  }
  if (typeof res?.source === 'string') return res.source;
  return genericText(res);
}
