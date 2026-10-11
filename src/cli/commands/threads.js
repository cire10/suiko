// @ts-check
// `specreview threads <doc> [--status open|addressed|answered|declined|needs_input|resolved|outdated|actionable|
//  unresolved|all] [--json]` (design 9.2). One line per thread (default: every unresolved thread).
// Uses the engine's threads(ctx, doc, { status }) + formatThreads when available; otherwise reads the store's
// thread files and prints:
//   t1  open         blocking  comment   L42-43  §3 Tokens > 3.2 Token refresh  Eric: Rotation on every use…
// `outdated` = anchor state changed/orphaned at head; `active` is accepted as an alias of `unresolved`.

import { UsageError } from '../../core/store/errors.js';
import { EXIT, THREAD_STATUS } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { formatWith } from '../engine.js';
import { anchorLines, formatThreadList, hasBody, headAnchor, isOutdated } from '../format.js';
import { docContext } from '../runtime.js';

const FILTERS = [...THREAD_STATUS, 'outdated', 'actionable', 'unresolved', 'all'];

export const spec = {
  name: 'threads',
  usage: `threads <doc> [--status ${FILTERS.join('|')}] [--json]`,
  summary: 'List threads, one line each (default: every thread that is not resolved).',
  options: { status: { type: 'string' } },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('threads', positionals, 1, 1, spec.usage);
  return { doc: positionals[0], status: values.status };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, status?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const filter = input.status === 'active' ? 'unresolved' : input.status;
  if (filter !== undefined && !FILTERS.includes(filter)) throw new UsageError(`threads: --status must be one of ${FILTERS.join(', ')}`);
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  if (typeof engine.ops.threads === 'function') {
    const list = await engine.ops.threads(ctx, docId, filter ? { status: filter } : {});
    const text = formatWith(engine, 'formatThreads', list, () => formatThreadList(list?.threads ?? [], { doc: docId, filter: list?.filter ?? filter }));
    return { exit: EXIT.OK, text, json: list };
  }
  const head = typeof doc.head === 'number' ? doc.head : undefined;
  const all = await loadThreads(engine, ctx, docId);
  const f = filter ?? 'unresolved';
  const keep = (/** @type {any} */ t) =>
    f === 'all'
      ? true
      : f === 'unresolved'
        ? t.status !== 'resolved'
        : f === 'outdated'
          ? t.status !== 'resolved' && isOutdated(t, head)
          : f === 'actionable'
            ? isActionable(t)
            : t.status === f;
  const threads = all.filter(keep).sort((a, b) => lineOf(a, head) - lineOf(b, head) || idNum(a.id) - idNum(b.id));
  const hidden = f === 'unresolved' ? all.length - threads.length : 0;
  return {
    exit: EXIT.OK,
    text: formatThreadList(threads, { head, doc: docId, filter: f, hidden }),
    json: {
      doc: docId,
      filter: f,
      threads: threads.map((t) => {
        const anchor = headAnchor(t, head);
        const comments = Array.isArray(t.comments) ? t.comments : [];
        const last = comments.filter(hasBody).pop();
        return {
          id: t.id,
          type: t.type ?? null,
          severity: t.severity ?? null,
          status: t.status ?? null,
          actionable: isActionable(t),
          lines: t.lines ?? anchorLines(anchor),
          section: t.section ?? anchor?.section ?? [],
          anchorState: anchor?.state ?? t.anchorState ?? null,
          comments: comments.length,
          last: last ? { by: last.by?.name ?? last.by ?? null, body: last.body } : null,
        };
      }),
    },
  };
}

/**
 * design 9.3: open, or the reviewer's newest comment is newer than the agent's newest and it is not resolved.
 * @param {any} t
 * @returns {boolean}
 */
function isActionable(t) {
  if (t.status === 'open') return true;
  if (t.status === 'resolved') return false;
  const comments = Array.isArray(t.comments) ? t.comments : [];
  const lastHuman = comments.findLastIndex((/** @type {any} */ c) => c.by?.kind === 'human');
  const lastAgent = comments.findLastIndex((/** @type {any} */ c) => c.by?.kind === 'agent');
  return lastHuman > lastAgent;
}

/**
 * Stored threads of a doc: the store's thread files, else docState().threads.
 * @param {import('../engine.js').Engine} engine
 * @param {any} ctx
 * @param {string} docId
 * @returns {Promise<any[]>}
 */
async function loadThreads(engine, ctx, docId) {
  if (ctx?.store && typeof ctx.store.listThreads === 'function') return ctx.store.listThreads(docId);
  if (typeof engine.ops.docState === 'function') return (await engine.ops.docState(ctx, docId))?.threads ?? [];
  throw new UsageError('threads: the review engine cannot list threads');
}

/**
 * @param {any} t
 * @param {number | undefined} head
 * @returns {number}
 */
function lineOf(t, head) {
  const lines = t.lines ?? anchorLines(headAnchor(t, head));
  return Array.isArray(lines) ? lines[0] : Number.MAX_SAFE_INTEGER;
}

/**
 * @param {string} id
 * @returns {number}
 */
function idNum(id) {
  return Number(String(id).replace(/\D+/g, '')) || 0;
}
