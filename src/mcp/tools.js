// @ts-check
// MCP tool table (design 9.7, agent-protocol 15). Every tool maps its arguments onto the input of the matching CLI
// command module and runs the same execute(), so the tool's text content is the CLI text and its structuredContent
// is the CLI's --json value. Additive tools beyond the design table: specreview_ask, specreview_threads.
// specreview_revise deliberately has no `force` (only a user at a terminal should force a refused revision).

import path from 'node:path';
import * as z from 'zod/v4';
import { AGENT_REPLY_STATUS } from '../shared/protocol.js';
import { normalizeAt, parseSingleRange, parseVersionRef } from '../cli/args.js';
import { buildReviseInput } from '../cli/commands/revise.js';
import { OtherSchema, ThreadReplySchema } from '../cli/schemas.js';
import { defaultDocId } from '../cli/runtime.js';

/** MCP wait bounds (amendments 5): default 50 s, max 600 s. */
export const WAIT_DEFAULT_SEC = 50;
export const WAIT_MAX_SEC = 600;

const docArg = z.string().min(1).describe('Doc id (e.g. "token-service") or the spec file path');
const threadId = z.string().regex(/^t\d+$/).describe('Thread id, e.g. "t3"');
const linesArg = z.string().describe('Inclusive line range of the current file, e.g. "42-46" or "L42-46"');
const versionArg = z.union([z.number().int().min(1), z.string().min(1)]).describe('Version: 3, "v3", "head" or "live"');
const workspaceArg = z.string().optional().describe('Workspace root (optional; default: discovered from the path or the server cwd)');

/**
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {z.ZodType} schema
 * @property {string} command CLI command module name
 * @property {(args: any, rt: import('../cli/runtime.js').Runtime) => Promise<any>} toInput
 * @property {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} [annotations]
 * @property {boolean} [wait] the long-polling wait tool
 */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: 'specreview_open',
    title: 'Open a spec for review',
    description:
      'Track an HTML/Markdown spec (recording v1 if new), make sure the local review server runs, open the review UI in the default browser (unless SPECREVIEW_BROWSER is pane or none), and return its URL. Write the spec once before calling this; afterwards only make targeted edits.',
    schema: z.object({ path: z.string().min(1).describe('Path of the .md/.html spec'), title: z.string().optional(), workspace: workspaceArg }),
    command: 'open',
    toInput: async (a) => ({ paths: [a.path], title: a.title }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_wait',
    title: 'Wait for the review',
    description:
      'Block until the reviewer submits a review (or closes the session), up to timeout_sec (default 50, max 600). Returns the feedback packet, {"status":"waiting"} (call it again), or {"status":"closed"} (stop waiting).',
    schema: z.object({
      doc: docArg.optional(),
      all: z.boolean().optional().describe('Wait on every doc of the workspace'),
      timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`Seconds to wait (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC})`),
      allow_dirty: z.boolean().optional().describe('Wait even if the working copy has unrecorded edits'),
      workspace: workspaceArg,
    }),
    command: 'wait',
    toInput: async (a) => ({
      doc: a.doc,
      all: Boolean(a.all),
      timeoutMs: Math.min(a.timeout_sec ?? WAIT_DEFAULT_SEC, WAIT_MAX_SEC) * 1000,
      allowDirty: Boolean(a.allow_dirty),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    wait: true,
  },
  {
    name: 'specreview_feedback',
    title: 'Get the feedback packet now',
    description:
      'Return the feedback packet without blocking (marks the reviews delivered unless peek). include_drafts also lists unsubmitted drafts (never act on them).',
    schema: z.object({
      doc: docArg,
      peek: z.boolean().optional(),
      include_drafts: z.boolean().optional(),
      all_open: z.boolean().optional(),
      workspace: workspaceArg,
    }),
    command: 'feedback',
    toInput: async (a) => ({ doc: a.doc, peek: Boolean(a.peek), includeDrafts: Boolean(a.include_drafts), allOpen: Boolean(a.all_open) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_apply',
    title: 'Apply suggestions verbatim',
    description:
      'Apply suggestion threads verbatim to the working copy (staged until revise). Do Edit-tool edits first; re-read the file afterwards. A conflict means: treat the thread as a normal comment.',
    schema: z.object({ doc: docArg, thread_ids: z.array(threadId).min(1), dry_run: z.boolean().optional(), workspace: workspaceArg }),
    command: 'apply',
    toInput: async (a) => ({ doc: a.doc, threads: [...new Set(/** @type {string[]} */ (a.thread_ids))], dryRun: Boolean(a.dry_run) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_edit',
    title: 'Thread-tagged exact replace',
    description:
      'Replace old_string with new_string in the working copy, tagged to the given threads (old_string must occur exactly once unless replace_all). Use the packet\'s src> text as old_string.',
    schema: z.object({
      doc: docArg,
      thread_ids: z.array(threadId).min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
      workspace: workspaceArg,
    }),
    command: 'edit',
    toInput: async (a) => ({ doc: a.doc, edits: [{ threads: a.thread_ids, old: a.old_string, new: a.new_string, all: Boolean(a.replace_all) }] }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_reply',
    title: 'Reply on a thread',
    description: 'Reply on a thread without recording a version (status: answered, declined, needs_input or addressed).',
    schema: z.object({
      doc: docArg,
      thread_id: threadId,
      body: z.string().min(1).describe('Markdown reply'),
      status: z.enum(/** @type {[string, ...string[]]} */ ([...AGENT_REPLY_STATUS])).optional(),
      at: z.string().optional().describe('Lines you changed for it, e.g. "L42-46"'),
      decision: z.string().optional(),
      workspace: workspaceArg,
    }),
    command: 'reply',
    toInput: async (a) => ({ doc: a.doc, thread: a.thread_id, body: a.body, status: a.status, at: a.at !== undefined ? normalizeAt(a.at, 'at') : undefined, decision: a.decision }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_revise',
    title: 'Record a revision with replies',
    description:
      'Record the working copy as a new version with one reply per thread of the packet. threads: {"t1":{"status":"addressed","reply":"...","at":"L90-91"}}; other: [{"at":"L12"|"L12-14"|"del:h6"|"h6","why":"..."}] explains changes no thread asked for. A refusal (isError) records nothing: follow its fix lines. Never use break_locks or allow_rewrite unless the user explicitly asked.',
    schema: z.object({
      doc: docArg,
      summary: z.string(),
      threads: z.record(threadId, ThreadReplySchema),
      other: z.array(OtherSchema).optional(),
      break_locks: z.record(z.string().regex(/^L\d+$/), z.string().min(1)).optional(),
      allow_rewrite: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      workspace: workspaceArg,
    }),
    command: 'revise',
    toInput: async (a) => ({
      doc: a.doc,
      input: buildReviseInput(
        { summary: a.summary, threads: a.threads, ...(a.other ? { other: a.other } : {}) },
        { breakLocks: a.break_locks, allowRewrite: a.allow_rewrite, dryRun: a.dry_run },
      ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_revert',
    title: 'Revert a hunk or a lock',
    description: 'Undo one unrecorded hunk (hunk: "h5") or restore the agreed text of a lock (lock: "L1") in the working copy. Never revert changes you did not make.',
    schema: z.object({ doc: docArg, hunk: z.string().regex(/^h\d+$/).optional(), lock: z.string().regex(/^L\d+$/).optional(), workspace: workspaceArg }),
    command: 'revert',
    toInput: async (a) => ({ doc: a.doc, hunk: a.hunk, lock: a.lock }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_reanchor',
    title: "Move a thread's anchor",
    description: "Move a thread's anchor to other lines (\"42-46\") or to an exact quote of the current file.",
    schema: z.object({ doc: docArg, thread_id: threadId, lines: linesArg.optional(), quote: z.string().optional(), workspace: workspaceArg }),
    command: 'reanchor',
    toInput: async (a) => ({ doc: a.doc, thread: a.thread_id, lines: a.lines !== undefined ? parseSingleRange(a.lines, 'lines') : undefined, quote: a.quote }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_ask',
    title: 'Ask the reviewer a question',
    description: 'Create an agent-question thread anchored on a quote or lines of the doc; the answer arrives in a later packet as ANSWER.',
    schema: z.object({ doc: docArg, quote: z.string().optional(), lines: linesArg.optional(), body: z.string().min(1), workspace: workspaceArg }),
    command: 'ask',
    toInput: async (a) => ({ doc: a.doc, quote: a.quote, lines: a.lines !== undefined ? parseSingleRange(a.lines, 'lines') : undefined, body: a.body }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_threads',
    title: 'List threads',
    description: 'List the threads of a doc, one line each (status: open, addressed, answered, declined, needs_input, resolved, outdated, active (default) or all).',
    schema: z.object({ doc: docArg, status: z.string().optional(), workspace: workspaceArg }),
    command: 'threads',
    toInput: async (a) => ({ doc: a.doc, status: a.status }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_diff',
    title: 'Diff two versions',
    description: 'What changed between two versions (default: last reviewed..head). format "stat" (default) or "unified".',
    schema: z.object({
      doc: docArg,
      from: versionArg.optional(),
      to: versionArg.optional(),
      format: z.enum(['stat', 'unified']).optional(),
      workspace: workspaceArg,
    }),
    command: 'diff',
    toInput: async (a) => ({
      doc: a.doc,
      from: a.from !== undefined ? parseVersionRef(a.from, 'from') : undefined,
      to: a.to !== undefined ? parseVersionRef(a.to, 'to') : undefined,
      format: a.format ?? 'stat',
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_log',
    title: 'Version and review timeline',
    description: 'Timeline of versions and reviews of a doc (doc optional when only one is tracked).',
    schema: z.object({ doc: docArg.optional(), workspace: workspaceArg }),
    command: 'log',
    toInput: async (a, rt) => ({ doc: a.doc ?? (await defaultDocId(rt)) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_status',
    title: 'Review status',
    description: 'Docs, head versions, thread counts, undelivered reviews, listening agents and working-copy state.',
    schema: z.object({ doc: docArg.optional(), workspace: workspaceArg }),
    command: 'status',
    toInput: async (a) => ({ doc: a.doc }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'specreview_show',
    title: 'Show a thread or old source',
    description: 'A thread with its full timeline (thread_id), or the exact source of a version (version + lines).',
    schema: z.object({ doc: docArg, thread_id: threadId.optional(), version: versionArg.optional(), lines: linesArg.optional(), workspace: workspaceArg }),
    command: 'show',
    toInput: async (a) => ({
      doc: a.doc,
      thread: a.thread_id,
      version: a.version !== undefined ? parseVersionRef(a.version, 'version') : undefined,
      lines: a.lines !== undefined ? parseSingleRange(a.lines, 'lines') : undefined,
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'specreview_final',
    title: 'Finalize an approved spec',
    description: 'After an APPROVED packet: check the working copy equals the final version and (decisions: true) write <name>.decisions.md.',
    schema: z.object({ doc: docArg, decisions: z.boolean().optional(), out_dir: z.string().optional(), workspace: workspaceArg }),
    command: 'final',
    toInput: async (a, rt) => ({ doc: a.doc, decisions: Boolean(a.decisions), outDir: a.out_dir ? path.resolve(rt.cwd, a.out_dir) : undefined }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
