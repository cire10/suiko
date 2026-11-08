// @ts-check
// `suiko reply <doc> <tid> -m <md> [--status answered|declined|needs_input|addressed|planned] [--at L42-46]
//  [--attach <file>]... [--decision "text"] [--json]` (design 9.2). Posts an agent reply on a thread without
// recording a version. On a code review `--at` names repo files: `--at src/a.js:L42-46` (a bare `L42-46` means the
// thread's file). `--status planned` (batched edits): what you will change, applied later in an APPLY round.
// `--attach` (repeatable, at most 6): an image (.png .jpg .jpeg .gif .webp .svg) or an HTML preview (.html .htm) you
// made, shown in the thread; a path relative to the cwd or absolute; checked by the engine (core/review/attachments.js).
// Exit 0; 4 when the doc, thread or an attached file does not exist; 1 for an attachment that is refused.

import { UsageError } from '../../core/store/errors.js';
import { AGENT_REPLY_STATUS, EXIT, LIMITS } from '../../shared/protocol.js';
import { assertThreadId, expectPositionals, normalizeAt } from '../args.js';
import { formatWith } from '../engine.js';
import { actorName, excerpt } from '../format.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'reply',
  usage: 'reply <doc> <tid> -m <markdown> [--status answered|declined|needs_input|addressed|planned] [--at L42-46 | --at src/a.js:L42-46] [--attach <file>]... [--decision "text"] [--json]',
  summary: 'Reply on a thread without recording a version (optionally with images or an HTML preview attached).',
  options: {
    message: { type: 'string', short: 'm' },
    status: { type: 'string' },
    at: { type: 'string' },
    attach: { type: 'string', multiple: true },
    decision: { type: 'string' },
  },
  details: [
    '--status planned    batched edits: say exactly what you will change; you edit later, in the APPLY round',
    `--attach <file>     attach an image (.png .jpg .jpeg .gif .webp .svg) or an HTML preview (.html .htm) you made;`,
    `                    repeatable (at most ${LIMITS.maxReplyAttachments}, ${LIMITS.maxAttachmentBytes / (1024 * 1024)} MB each); relative to the cwd or absolute`,
  ],
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
    ...(values.attach?.length ? { attachments: values.attach } : {}),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, thread: string, body?: string, status?: string, at?: string, decision?: string,
 *   attachments?: string[] }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (!input.body || !input.body.trim()) throw new UsageError('reply: -m <markdown> is required');
  if (input.status !== undefined && !AGENT_REPLY_STATUS.includes(input.status)) {
    throw new UsageError(`reply: --status must be one of ${AGENT_REPLY_STATUS.join(', ')}`);
  }
  if (input.attachments && input.attachments.length > LIMITS.maxReplyAttachments) {
    throw new UsageError(`reply: at most ${LIMITS.maxReplyAttachments} --attach files per reply`);
  }
  const at = input.at !== undefined ? normalizeAt(input.at) : undefined;
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = await callOp(engine, 'reply', ctx, docId, input.thread, {
    body: input.body,
    status: input.status,
    at,
    decision: input.decision,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
  const summary = threadSummary(res, input.thread);
  const status = res?.status ?? summary.status ?? input.status ?? 'replied';
  const text = formatWith(engine, 'formatReply', res, () =>
    `replied on ${summary.id} (${status}) · no version recorded${input.decision ? ` · decision proposed: ${excerpt(input.decision, 60)}` : ''}`,
  );
  const attachments = Array.isArray(res?.comment?.attachments) && res.comment.attachments.length ? { attachments: res.comment.attachments } : {};
  return { exit: EXIT.OK, text, json: { doc: docId, ...summary, status, ...attachments } };
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
