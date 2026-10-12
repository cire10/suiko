// @ts-check
// Agent questions and re-anchoring on a code doc (`ask --file`, `reanchor --file`; design 4.2). The lines the agent
// gives are lines of the WORKING file now; they are mapped onto the head blob (the round the reviewer sees):
//   ask       an agent-question thread on those head lines (a whole-file thread without --lines, a whole-review
//             thread without --file); lines that exist only in the working tree are refused (revise first)
//   reanchor  the working file equals the head blob: the head anchor is overridden now; otherwise the override is
//             staged (pending {via: 'override', thread, file, lines}) and applied by the next round

import { SSE } from '../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../store/errors.js';
import { docRefFor } from '../store/snapshot.js';
import { lineIndex } from '../text/index.js';
import { resolveCodePath } from '../util/code-at.js';
import { anchorAt } from '../review/threadstate.js';
import { preciseMapper } from '../review/workmap.js';
import { agentActor, emit, readHead, requireThread } from '../review/ops/common.js';
import { codeOf, hasText, lineAnchor, reader, wholeAnchor } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 */

/**
 * The head file a path names (as the agent wrote it: repo-relative, cwd-relative, absolute or a unique suffix).
 * @param {Ctx} ctx
 * @param {CodeManifest} H
 * @param {string} written
 * @param {number} v
 * @returns {CodeFile}
 */
function headFile(ctx, H, written, v) {
  const paths = [...new Set(H.files.flatMap((f) => [f.path, f.oldPath].filter((x) => typeof x === 'string')))];
  const res = resolveCodePath(written, /** @type {string[]} */ (paths), { root: ctx.root, cwd: ctx.cwd });
  if (!res.file) {
    if (res.candidates.length > 1) throw new RefusedError(`--file ${written} matches ${res.candidates.length} files of the review (${res.candidates.join(', ')}): give the path from the repo root`, { details: { candidates: res.candidates } });
    throw new NotFoundError(`${written} is not a file of round v${v}`, { details: { path: written, version: v } });
  }
  const f = H.files.find((x) => x.path === res.file) ?? H.files.find((x) => x.oldPath === res.file);
  return /** @type {CodeFile} */ (f);
}

/**
 * Working-file lines -> head blob lines. null when the working file is missing (the lines are taken as head lines);
 * RefusedError when the lines exist only in the working tree.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {CodeFile} f
 * @param {string} headText
 * @param {[number, number]} lines
 * @param {number} v
 * @returns {Promise<{ lines: [number, number], workingText: string | null }>}
 */
async function toHeadLines(ctx, doc, f, headText, lines, v) {
  const w = await ctx.store.readRepoFile(f.path).catch(() => null);
  const text = w?.kind === 'file' ? w.text : w?.kind === 'symlink' ? w.target : null;
  const hli = lineIndex(headText);
  if (text === null || text === headText) {
    if (lines[1] > hli.count) throw new UsageError(`${f.path} has ${hli.count} lines in v${v}; L${lines[1]} is past its end`);
    return { lines, workingText: text };
  }
  const wli = lineIndex(text);
  if (lines[1] > wli.count) throw new UsageError(`${f.path} has ${wli.count} lines in your working tree; L${lines[1]} is past its end`);
  const back = preciseMapper(text, headText);
  const m = back.mapRange(wli.startOf(lines[0]), wli.endOf(lines[1]));
  if (m.end <= m.start || !headText.slice(m.start, m.end).trim()) {
    throw new RefusedError(`${f.path}:L${lines[0]}-${lines[1]} exist only in your working tree (not in v${v} yet): run specreview revise ${docRefFor(doc.id, ctx.root)} first`, { details: { path: f.path } });
  }
  const a = hli.lineOf(m.start);
  return { lines: [a, Math.max(a, hli.lineOf(m.end - 1))], workingText: text };
}

/**
 * ops.ask on a code doc: an agent-question thread on `file` lines of head (new side), or a whole-review thread when
 * `file` is absent.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ file?: string | null, lines?: [number, number] | null, body: string }} input
 * @returns {Promise<{ thread: Thread, version: number, lines: [number, number] | null }>}
 */
export async function askCode(ctx, doc, { file, lines, body }) {
  const head = await readHead(ctx, doc);
  const H = codeOf(head.manifest);
  /** @type {Anchor} */
  let anchor;
  if (!file) {
    if (lines) throw new UsageError('ask: --lines needs --file on a code review (the lines of which file?)');
    anchor = wholeAnchor(head.v, null);
  } else {
    const f = headFile(ctx, H, file, head.v);
    if (!lines || !hasText(f, 'new')) {
      if (lines) throw new UsageError(`${f.path} has no text lines in v${head.v} (binary, too large or deleted): ask about the whole file (no --lines)`);
      anchor = wholeAnchor(head.v, { path: f.path, side: f.status === 'D' ? 'old' : 'new', ...(f.oldPath ? { oldPath: f.oldPath } : {}) });
    } else {
      const headText = /** @type {string} */ (await reader(ctx, doc.id).text(f.new));
      const mapped = await toHeadLines(ctx, doc, f, headText, lines, head.v);
      anchor = { ...lineAnchor({ v: head.v, text: headText, startLine: mapped.lines[0], endLine: mapped.lines[1], file: { path: f.path, side: 'new' }, config: ctx.config }), state: 'exact' };
    }
  }
  const at = ctx.now();
  /** @type {Thread} */
  const t = /** @type {any} */ ({
    schema: 1,
    id: ctx.store.nextId(doc, 'thread'),
    doc: doc.id,
    type: 'agent-question',
    severity: 'normal',
    status: 'needs_input',
    createdIn: head.v,
    createdBy: agentActor(ctx),
    review: null,
    anchors: { [String(head.v)]: anchor },
    override: null,
    suggestion: null,
    comments: [{ id: ctx.store.nextId(doc, 'comment'), by: agentActor(ctx), body, at, version: head.v, status: 'needs_input' }],
    changes: [],
    attachments: [],
    decision: null,
    resolvedIn: null,
    updatedAt: at,
  });
  await ctx.store.saveDoc(doc);
  await ctx.store.saveThread(doc.id, t);
  await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: t.status, created: true });
  return { thread: t, version: head.v, lines: anchor.kind === 'doc' ? null : [anchor.src.startLine, anchor.src.endLine] };
}

/**
 * ops.reanchorThread on a code doc: the agent's override of a thread's anchor to `file` lines (default: the file
 * the thread is anchored on).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string} tid
 * @param {{ file?: string | null, lines?: [number, number] | null }} input
 * @returns {Promise<{ thread: Thread, anchor: Anchor | null, staged: boolean }>}
 */
export async function reanchorCode(ctx, doc, tid, { file, lines }) {
  if (!lines) throw new UsageError('reanchor: --lines is required');
  const t = await requireThread(ctx, doc.id, tid);
  const head = await readHead(ctx, doc);
  const H = codeOf(head.manifest);
  const written = file || anchorAt(t, head.v)?.file?.path || anchorAt(t, head.v)?.lastKnown?.file?.path || null;
  if (!written) throw new UsageError(`reanchor: ${tid} is not on a file; give --file <path>`);
  const f = headFile(ctx, H, written, head.v);
  if (f.status === 'D' || !hasText(f, 'new')) throw new RefusedError(`${f.path} has no text lines in your working tree's round (deleted, binary or too large); reply to ${tid} instead`, { details: { path: f.path } });
  const headText = /** @type {string} */ (await reader(ctx, doc.id).text(f.new));
  const w = await ctx.store.readRepoFile(f.path).catch(() => null);
  const text = w?.kind === 'file' ? w.text : null;
  if (text === null) throw new RefusedError(`${f.path} is missing from your working tree (or not a regular file): restore it, or reply to ${tid} instead`, { details: { path: f.path } });
  const count = lineIndex(text).count;
  if (lines[1] > count) throw new UsageError(`${f.path} has ${count} lines in your working tree; L${lines[1]} is past its end`);
  if (text === headText) {
    const anchor = /** @type {Anchor} */ ({ ...lineAnchor({ v: head.v, text: headText, startLine: lines[0], endLine: lines[1], file: { path: f.path, side: 'new' }, config: ctx.config }), state: 'exact', mappedBy: 'override' });
    t.anchors = { ...t.anchors, [String(head.v)]: anchor };
    t.override = /** @type {any} */ ({ version: head.v, lines, file: f.path, by: 'agent' });
    t.updatedAt = ctx.now();
    await ctx.store.saveThread(doc.id, t);
    await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, moved: true });
    return { thread: t, anchor, staged: false };
  }
  await ctx.store.appendPendingEdit(doc.id, /** @type {any} */ ({ via: 'override', thread: tid, lines, file: f.path }));
  t.override = /** @type {any} */ ({ version: head.v + 1, lines, file: f.path, by: 'agent' });
  t.updatedAt = ctx.now();
  await ctx.store.saveThread(doc.id, t);
  await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, staged: true });
  return { thread: t, anchor: null, staged: true };
}
