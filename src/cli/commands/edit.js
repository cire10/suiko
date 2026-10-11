// @ts-check
// `specreview edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]`
// `specreview edit <doc> --stdin`  with  [{"threads":["t1"],"old":"...","new":"...","all":false}, ...]
// (design 9.4, amendments 5). Thread-tagged exact replace with Edit-tool semantics: `old` must occur exactly once
// in the working copy unless all/--all. A batch goes to the engine's taggedEdits() when it has one (all or
// nothing: one compare-and-swap of the working copy); otherwise the items are applied one by one with
// taggedEdit(), stopping at the first failure (earlier items stay applied, and the report says so).
// Exit 0, or the failing edit's code (3 not found / not unique / conflict, 4 unknown thread).

import { UsageError, exitCodeOf } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, parseThreadList } from '../args.js';
import { formatWith } from '../engine.js';
import { rangeText } from '../format.js';
import { readAll } from '../io.js';
import { EditBatchSchema, parseJsonInput } from '../schemas.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'edit',
  usage: 'edit <doc> (--thread t1[,t2] --old <s> --new <s> [--all] | --stdin) [--json]',
  summary: 'Exact, thread-tagged replace in the working copy (old must be unique unless --all).',
  options: {
    thread: { type: 'string', multiple: true },
    old: { type: 'string' },
    new: { type: 'string' },
    all: { type: 'boolean' },
    stdin: { type: 'boolean' },
  },
  details: [
    '--stdin reads a JSON batch: [{"threads":["t1"],"old":"...","new":"...","all":false}]',
    'Edits are staged (tagged to the threads) until the next `specreview revise`.',
  ],
};

/**
 * @typedef {{ threads: string[], old: string, new: string, all?: boolean }} EditItem
 */

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<{ doc: string, edits: EditItem[] }>}
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('edit', positionals, 1, 1, spec.usage);
  if (values.stdin) {
    if (values.thread || values.old !== undefined || values.new !== undefined || values.all) {
      throw new UsageError('edit: --stdin cannot be combined with --thread/--old/--new/--all');
    }
    const parsed = parseJsonInput(await readAll(rt.stdin), EditBatchSchema, 'edit --stdin JSON');
    return { doc: positionals[0], edits: /** @type {EditItem[]} */ (Array.isArray(parsed) ? parsed : [parsed]) };
  }
  const threads = parseThreadList(values.thread);
  if (!threads.length) throw new UsageError(`edit: --thread is required (usage: specreview ${spec.usage})`);
  if (values.old === undefined || values.old === '') throw new UsageError('edit: --old <text> is required and must not be empty');
  if (values.new === undefined) throw new UsageError('edit: --new <text> is required (use --new "" to delete)');
  return { doc: positionals[0], edits: [{ threads, old: values.old, new: values.new, all: Boolean(values.all) }] };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, edits: EditItem[] }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  if (input.edits.length > 1 && typeof engine.ops.taggedEdits === 'function') {
    const res = await engine.ops.taggedEdits(ctx, docId, input.edits.map((e) => ({ threads: e.threads, old: e.old, new: e.new, all: Boolean(e.all) })));
    const edits = Array.isArray(res?.edits) ? res.edits : [];
    const text = formatWith(engine, 'formatEdit', res, () => edits.map((/** @type {any} */ e, /** @type {number} */ i) => editLine(e, i, edits.length)).join('\n'));
    return {
      exit: EXIT.OK,
      text: `${text}\nre-read ${docId} before editing it again; record with \`specreview revise ${docId} --replies -\``,
      json: { doc: docId, applied: edits.map((/** @type {any} */ e, /** @type {number} */ i) => ({ index: i + 1, ...e })), failed: null },
    };
  }
  /** @type {Array<{ index: number, threads: string[], lines: unknown, count?: number }>} */
  const applied = [];
  const text = [];
  /** @type {string[]} */
  const stderr = [];
  /** @type {{ index: number, message: string, code: string, exit: number } | null} */
  let failed = null;
  for (let i = 0; i < input.edits.length; i++) {
    const e = input.edits[i];
    try {
      const res = (await callOp(engine, 'taggedEdit', ctx, docId, {
        threads: e.threads,
        oldString: e.old,
        newString: e.new,
        replaceAll: Boolean(e.all),
      })) ?? {};
      const item = { threads: e.threads, lines: res.lines ?? null, ...(res.count !== undefined ? { count: res.count } : {}) };
      applied.push({ index: i + 1, ...item });
      text.push(formatWith(engine, 'formatEdit', { ...res, threads: res.threads ?? e.threads }, () => editLine(item, i, input.edits.length)));
    } catch (err) {
      if (input.edits.length === 1) throw err; // single edit: plain `specreview: <message>` error
      const error = /** @type {any} */ (err);
      failed = { index: i + 1, message: error.message, code: error.code ?? 'ERROR', exit: exitCodeOf(err) };
      const rest = input.edits.length - i - 1;
      stderr.push(
        `specreview: edit ${i + 1} failed: ${error.message}` +
          (rest ? ` (${rest} later edit${rest === 1 ? '' : 's'} not attempted)` : '') +
          (applied.length ? `; edits 1-${applied.length} were applied` : '; nothing was changed'),
      );
      break;
    }
  }
  if (applied.length) text.push(`re-read ${docId} before editing it again; record with \`specreview revise ${docId} --replies -\``);
  return {
    exit: failed ? failed.exit || EXIT.ERROR : EXIT.OK,
    text: text.join('\n'),
    // `lines` (design 9.7 specreview_edit -> {lines}) is the range of a single applied edit
    json: { doc: docId, ...(input.edits.length === 1 && applied.length === 1 ? { lines: applied[0].lines } : {}), applied, failed },
    stderr,
  };
}

/**
 * Fallback line for one edit: 'edited L5-6 for t1,t2 · staged (not recorded yet)'.
 * @param {{ threads: string[], lines: unknown, count?: number }} e
 * @param {number} i
 * @param {number} total
 * @returns {string}
 */
function editLine(e, i, total) {
  const lines = /** @type {any} */ (e.lines);
  const where = Array.isArray(lines) && Array.isArray(lines[0]) ? lines.map(rangeText).join(',') : rangeText(lines);
  const prefix = total > 1 ? `edit ${i + 1}: ` : '';
  const many = e.count && e.count > 1 ? ` (${e.count} occurrences)` : '';
  return `${prefix}edited ${where || 'the working copy'}${many} for ${e.threads.join(',')} · staged (not recorded yet)`;
}
