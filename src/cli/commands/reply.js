// @ts-check
// `specreview reply <doc> <tid> -m <md> [--status answered|declined|needs_input|addressed] [--at L42-46]
//  [--decision "text"] [--json]` (design 9.2). Posts an agent reply on a thread without recording a version.
// On a code review `--at` names repo files: `--at src/a.js:L42-46` (a bare `L42-46` means the thread's file).
// Exit 0; 4 when the doc or thread does not exist.

import { UsageError } from '../../core/store/errors.js';
import { AGENT_REPLY_STATUS, EXIT } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals, normalizeAt } from '../args.js';
import { formatWith } from '../engine.js';
import { actorName, excerpt } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'reply',
  usage: 'reply <doc> <tid> -m <markdown> [--status answered|declined|needs_input|addressed] [--at L42-46 | --at src/a.js:L42-46] [--decision "text"] [--json]',
  summary: 'Reply on a thread without recording a version.',
  options: {
    message: { type: 'string', short: 'm' },
    status: { type: 'string' },
    at: { type: 'string' },
    decision: { type: 'string' },
  },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('reply', positionals, 2, 2, spec.usage);
  const [doc, thread] = positionals;
  assertThreadId(thread, 'reply');
  return {
    doc,
    thread,
    body: values.message,
    status: values.status,
    at: values.at,
    decision: values.decision,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, thread: string, body?: string, status?: string, at?: string, decision?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (!input.body || !input.body.trim()) throw new UsageError('reply: -m <markdown> is required');
  if (input.status !== undefined && !AGENT_REPLY_STATUS.includes(input.status)) {
    throw new UsageError(`reply: --status must be one of ${AGENT_REPLY_STATUS.join(', ')}`);
  }
  const at = input.at !== undefined ? normalizeAt(input.at) : undefined;
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = await callOp(engine, 'reply', ctx, docId, input.thread, {
    body: input.body,
    status: input.status,
    at,
    decision: input.decision,
  });
  const summary = threadSummary(res, input.thread);
  const status = res?.status ?? summary.status ?? input.status ?? 'replied';
  const text = formatWith(engine, 'formatReply', res, () =>
    `replied on ${summary.id} (${status}) · no version recorded${input.decision ? ` · decision proposed: ${excerpt(input.decision, 60)}` : ''}`,
  );
  return { exit: EXIT.OK, text, json: { doc: docId, ...summary, status } };
}

/**
 * Compact thread summary for reply/ask/reanchor results.
 * @param {any} thread
 * @param {string} fallbackId
 * @returns {{ id: string, type: string | null, status: string | null, comments: number, last: { by: string, body: string } | null }}
 */
export function threadSummary(thread, fallbackId) {
  const t = thread?.thread && typeof thread.thread === 'object' ? thread.thread : thread;
  const comments = Array.isArray(t?.comments) ? t.comments : [];
  const last = comments.length ? comments[comments.length - 1] : null;
  return {
    id: t?.id ?? fallbackId,
    type: t?.type ?? null,
    status: t?.status ?? null,
    comments: comments.length,
    last: last ? { by: actorName(last.by), body: last.body } : null,
  };
}
