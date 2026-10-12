// @ts-check
// zod schemas for agent-supplied JSON: the `revise` input (design 9.5 ReviseInput; `--replies <file|->` and the
// MCP specreview_revise tool) and the `edit --stdin` batch (amendments 5). Unknown keys are rejected so a typo
// ("replies" instead of "threads") fails loudly instead of silently dropping the agent's replies.

import * as z from 'zod/v4';
import { UsageError } from '../core/store/errors.js';
import { parseLinesArg } from '../core/util/lines-arg.js';
import { isCodeAt, isCodeOtherAt } from '../core/util/code-at.js';
import { AGENT_REPLY_STATUS } from '../shared/protocol.js';

const THREAD_ID = z.string().regex(/^t\d+$/, 'expected a thread id like t3');
const LOCK_ID = z.string().regex(/^L\d+$/, 'expected a lock id like L1');

/** 'L90-91' | 'L12,L90-91'; code reviews: 'src/a.js:L90-91' | 'src/a.js:L12,L90-91,"a,b.js":L3' (core/util/code-at.js) */
const LinesAt = z.string().refine((s) => isLinesList(s) || isCodeAt(s), {
  message: 'expected lines like "L90-91" or "L12,L90-91" (code reviews: "src/a.js:L90-91")',
});
/** 'L12' | 'L12-14' | 'del:h6' | 'h6'; code reviews: 'src/a.js:L12' | 'src/a.js#h3' | 'del:src/a.js#h3' */
const OtherAt = z
  .string()
  .refine((s) => /^(del:)?h\d+$/.test(s.trim()) || isLinesList(s) || isCodeOtherAt(s), {
    message: 'expected "L12", "L12-14", "del:h6" or "h6" (code reviews: "src/a.js:L12", "src/a.js#h3" or "del:src/a.js#h3")',
  });

/**
 * @param {string} s
 * @returns {boolean}
 */
function isLinesList(s) {
  try {
    parseLinesArg(s);
    return true;
  } catch {
    return false;
  }
}

export const ThreadReplySchema = z
  .object({
    status: z.enum(/** @type {[string, ...string[]]} */ ([...AGENT_REPLY_STATUS])),
    reply: z.string().refine((s) => s.trim().length > 0, { message: 'reply must not be empty' }),
    at: LinesAt.optional(),
  })
  .strict();

export const OtherSchema = z.object({ at: OtherAt, why: z.string().min(1, 'why must not be empty') }).strict();

/** design 9.5 ReviseInput (+ allowRewrite/force/dryRun, which the CLI flags can also set). */
export const ReviseInputSchema = z
  .object({
    summary: z.string().optional(),
    threads: z.record(THREAD_ID, ThreadReplySchema).default({}),
    other: z.array(OtherSchema).optional(),
    breakLocks: z.record(LOCK_ID, z.string().min(1, 'a reason is required')).optional(),
    allowRewrite: z.boolean().optional(),
    force: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const ThreadList = z.union([
  z.array(THREAD_ID).min(1, 'threads must name at least one thread'),
  z
    .string()
    .transform((s) => s.split(/[\s,]+/).filter(Boolean))
    .pipe(z.array(THREAD_ID).min(1, 'threads must name at least one thread')),
]);

export const EditItemSchema = z
  .object({
    threads: ThreadList,
    old: z.string().min(1, 'old must not be empty'),
    new: z.string(),
    all: z.boolean().optional(),
  })
  .strict();

/** `edit --stdin`: one edit object or a non-empty array of them. */
export const EditBatchSchema = z.union([z.array(EditItemSchema).min(1, 'the batch is empty'), EditItemSchema]);

/**
 * Parses JSON text and validates it; throws UsageError with a readable message.
 * @template T
 * @param {string} text
 * @param {z.ZodType<T>} schema
 * @param {string} what e.g. '--replies JSON'
 * @returns {T}
 */
export function parseJsonInput(text, schema, what) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid ${what}: ${/** @type {Error} */ (err).message}`);
  }
  return validate(value, schema, what);
}

/**
 * Validates a value; throws UsageError listing the issues.
 * @template T
 * @param {unknown} value
 * @param {z.ZodType<T>} schema
 * @param {string} what
 * @returns {T}
 */
export function validate(value, schema, what) {
  const res = schema.safeParse(value);
  if (res.success) return res.data;
  throw new UsageError(`invalid ${what}: ${formatIssues(res.error)}`, { details: { issues: res.error.issues } });
}

/**
 * 'threads.t1.status: Invalid option ...; other.0.at: expected ...' (at most 5 issues).
 * @param {z.ZodError} error
 * @returns {string}
 */
export function formatIssues(error) {
  const issues = error.issues.slice(0, 5).map((i) => {
    const where = i.path.length ? `${i.path.map(String).join('.')}: ` : '';
    return `${where}${i.message}`;
  });
  if (error.issues.length > 5) issues.push(`(+${error.issues.length - 5} more)`);
  return issues.join('; ');
}
