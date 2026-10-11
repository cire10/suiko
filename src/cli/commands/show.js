// @ts-check
// `specreview show <doc> [<tid>] [--version N] [--lines A-B] [--json]` (design 9.2 / 9.6).
// A thread with its full timeline, or the exact source of a version (`--version 2 --lines 40-60`; `head`, or `live`
// for the working copy via the engine's sourceLines()).
// The engine's show(ctx, docId, { thread, version, lines }) result is printed as: its `text` when it has one;
// formatThread(result) for a thread ({ thread, timeline, ... } or a bare Thread), plus the working-copy `src>` lines
// and `crop:`/`image:` paths a packet item would carry (format.js withThreadSource); for source lines
// ({ startLine, lines }) the engine's formatSourceLines (raw lines, copyable) or numbered lines; else a generic
// rendering. Exit 0; 4 when the doc, thread or version does not exist.

import { EXIT } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals, parseSingleRange, parseVersionRef } from '../args.js';
import { FALLBACK_FORMATTERS, genericText, withThreadSource } from '../format.js';
import { formatWith } from '../engine.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'show',
  usage: 'show <doc> [<tid>] [--version N] [--lines A-B] [--json]',
  summary: 'Show a thread with its timeline, or the exact source lines of a version.',
  options: { version: { type: 'string' }, lines: { type: 'string' } },
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
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, thread?: string, version?: number | 'live' | 'head', lines?: [number, number] }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const version = input.version === 'head' ? doc.head : input.version;
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
