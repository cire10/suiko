// @ts-check
// Thread operations (design 3.7-3.10, 7.6, 8.8, 9.2, 9.6):
//   reviewer: resolveThread (Accept, optional decision), unresolveThread, moveThread ("Move here")
//   agent:    reply (no version), ask (agent-question thread, status needs_input), reanchorThread (override;
//             applied to head when the working copy is clean, else staged until the next revise)
//   readers:  threads (one line per thread), show (a thread's timeline, or exact old source lines)
// Agent ops acknowledge delivered reviews (amendments 2.4).

import { AGENT_REPLY_STATUS, SSE } from '../../../shared/protocol.js';
import { RefusedError, UsageError } from '../../store/errors.js';
import { compareIds } from '../../store/store.js';
import { lineHunks } from '../../diff/index.js';
import { lineIndex } from '../../text/index.js';
import { parseLinesArg } from '../../util/lines-arg.js';
import { anchorForCapture, describe, envOf, forwardAnchor, label as anchorLabel, overrideAnchor } from '../anchoring.js';
import { sectionPath, truncate } from '../labels.js';
import { anchorAt, hasContent, isActionable, isOutdated, lastIndexes } from '../threadstate.js';
import { resolveInPlace } from './submit.js';
import {
  agentActor, emit, humanActor, loadSnapshot, oneOf, parseVersionArg, readHead, readWorkingState, requireThread,
  resolveDoc, versionLoader, withDoc,
} from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Anchor} Anchor
 */

/**
 * Accept: resolves a thread immediately (design C18), optionally recording a decision.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ by?: string, decision?: string | null }} [opts]
 * @returns {Promise<Thread>}
 */
export async function resolveThread(ctx, ref, tid, { by, decision } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const t = await requireThread(ctx, doc.id, tid);
    resolveInPlace(ctx, doc, t, { decision, at: ctx.now(), head: doc.head });
    /** @type {any} */ (t).resolvedBy = humanActor(ctx, by).name;
    if (t.decision) await ctx.store.saveDoc(doc);
    await ctx.store.saveThread(doc.id, t);
    await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: t.status });
    return t;
  });
}

/**
 * Undoes a resolve: the thread returns to the agent's last reply status (or open).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ by?: string }} [_opts]
 * @returns {Promise<Thread>}
 */
export async function unresolveThread(ctx, ref, tid, _opts = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const t = await requireThread(ctx, doc.id, tid);
    if (t.status === 'resolved') {
      const { lastAgent, lastHuman } = lastIndexes(t);
      const agentStatus = lastAgent >= 0 ? t.comments[lastAgent].status : null;
      t.status = agentStatus && lastAgent > lastHuman ? agentStatus : 'open';
      t.resolvedIn = null;
      delete (/** @type {any} */ (t).resolvedAt);
      delete (/** @type {any} */ (t).resolvedBy);
      t.updatedAt = ctx.now();
      await ctx.store.saveThread(doc.id, t);
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: t.status });
    }
    return t;
  });
}

/**
 * Reviewer "Move here": re-anchors a thread to a capture (or lines / quote) of a recorded version; the anchor is
 * carried forward to head and marked as an override.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ version?: number | string, capture?: any, lines?: string | [number, number], quote?: string, by?: string }} input
 * @returns {Promise<Thread>}
 */
export async function moveThread(ctx, ref, tid, input) {
  return withDoc(ctx, ref, async (doc) => {
    const t = await requireThread(ctx, doc.id, tid);
    const v = /** @type {number} */ (parseVersionArg(input.version, { fallback: doc.head }));
    const load = versionLoader(ctx, doc);
    const { source, render, manifest } = await load(v);
    const env = envOf(doc, ctx.config);
    /** @type {Anchor | null} */
    let anchor;
    if (input.capture) anchor = { ...anchorForCapture({ version: v, capture: input.capture, source, render, env, assets: manifest.assets ?? null }), state: 'exact', mappedBy: 'override' };
    else anchor = overrideAnchor({ version: v, lines: toRange(input.lines), quote: input.quote ?? null, source, render, env });
    if (!anchor) throw new RefusedError(`text not found in v${v}: ${truncate(String(input.quote ?? ''), 60)}`);
    const forwarded = v < doc.head ? await forwardAnchor(anchor, doc.head, load, env) : { [String(v)]: anchor };
    const headAnchor = forwarded[String(doc.head)];
    t.anchors = { ...t.anchors, [String(doc.head)]: { ...headAnchor, state: 'exact', mappedBy: 'override' } };
    t.override = { version: doc.head, ...(input.quote ? { quote: input.quote } : { lines: [headAnchor.src.startLine, headAnchor.src.endLine] }), by: 'human' };
    t.updatedAt = ctx.now();
    await ctx.store.saveThread(doc.id, t);
    await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, moved: true });
    return t;
  });
}

/**
 * Agent reply without recording a version.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ body: string, status?: string | null, at?: string | null, decision?: string | null }} input
 * @returns {Promise<{ thread: Thread, comment: object, status: string | null }>}
 */
export async function reply(ctx, ref, tid, input) {
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      const t = await requireThread(ctx, doc.id, tid);
      const comment = addAgentReply(ctx, doc, t, input);
      await ctx.store.saveDoc(doc);
      await ctx.store.saveThread(doc.id, t);
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: t.status });
      return { thread: t, comment, status: /** @type {any} */ (comment).status ?? null };
    },
    { ack: true },
  );
}

/**
 * Appends an agent reply to a thread in memory and updates its status (a resolved thread stays resolved).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Thread} t
 * @param {{ body?: string, reply?: string, status?: string | null, at?: string | null, decision?: string | null }} input
 * @param {number} [version] version the reply refers to (default head)
 * @returns {import('../../../shared/types.js').Comment}
 */
export function addAgentReply(ctx, doc, t, input, version = doc.head) {
  const body = String(input.body ?? input.reply ?? '');
  if (!body.trim() && !input.status) throw new UsageError(`reply to ${t.id}: a message is required`);
  const status = input.status ? oneOf(input.status, AGENT_REPLY_STATUS, 'reply status') : null;
  /** @type {any} */
  const c = { id: ctx.store.nextId(doc, 'comment'), by: agentActor(ctx), body, at: ctx.now(), version };
  if (status) c.status = status;
  if (input.at) {
    try {
      c.atLines = parseLinesArg(input.at);
    } catch (err) {
      throw new UsageError(`reply to ${t.id}: invalid "at" ${JSON.stringify(input.at)}: ${/** @type {Error} */ (err).message}`);
    }
  }
  if (input.decision) c.decision = String(input.decision);
  t.comments.push(c);
  if (status && t.status !== 'resolved') t.status = status;
  t.updatedAt = c.at;
  return c;
}

/**
 * Agent question to the reviewer: an `agent-question` thread (status needs_input) anchored on head.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ quote?: string | null, lines?: string | [number, number] | null, body: string }} input
 * @returns {Promise<{ thread: Thread, version: number, lines: [number, number] | null }>}
 */
export async function ask(ctx, ref, input) {
  const body = String(input?.body ?? '').trim();
  if (!body) throw new UsageError('ask: a question is required');
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      const head = await readHead(ctx, doc);
      const working = await readWorkingState(ctx, doc, head);
      const lines = toRange(input.lines);
      if (lines && working.dirty) {
        throw new RefusedError('the working copy differs from head; record it with specreview revise first, or ask with --quote');
      }
      const render = await ctx.render(doc, head.v);
      const env = envOf(doc, ctx.config);
      /** @type {Anchor | null} */
      let anchor = null;
      if (lines || input.quote) anchor = overrideAnchor({ version: head.v, lines, quote: input.quote ?? null, source: head.source, render, env });
      else anchor = anchorForCapture({ version: head.v, capture: { kind: 'doc' }, source: head.source, render, env });
      if (!anchor) throw new RefusedError(`text not found in v${head.v}: ${truncate(String(input.quote ?? ''), 60)}`);
      anchor = { ...anchor, state: 'exact' };
      const at = ctx.now();
      /** @type {Thread} */
      const t = {
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
      };
      await ctx.store.saveDoc(doc);
      await ctx.store.saveThread(doc.id, t);
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: t.status, created: true });
      return { thread: t, version: head.v, lines: anchor.kind === 'doc' ? null : [anchor.src.startLine, anchor.src.endLine] };
    },
    { ack: true },
  );
}

/**
 * Agent override of a thread's anchor (`specreview reanchor`).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ lines?: string | [number, number] | null, quote?: string | null }} input
 * @returns {Promise<{ thread: Thread, anchor: Anchor | null, staged: boolean }>}
 */
export async function reanchorThread(ctx, ref, tid, input) {
  const lines = toRange(input?.lines);
  const quote = input?.quote ? String(input.quote) : null;
  if (!lines && !quote) throw new UsageError('reanchor: --lines or --quote is required');
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      const t = await requireThread(ctx, doc.id, tid);
      const head = await readHead(ctx, doc);
      const working = await readWorkingState(ctx, doc, head);
      if (working.dirty && !working.missing) {
        if (quote && !working.text.includes(quote)) throw new RefusedError(`text not found in the working copy: ${truncate(quote, 60)}`);
        await ctx.store.appendPendingEdit(doc.id, { via: 'override', thread: tid, ...(lines ? { lines } : { quote }) });
        t.override = { version: doc.head + 1, ...(lines ? { lines } : { quote }), by: 'agent' };
        await ctx.store.saveThread(doc.id, t);
        await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, staged: true });
        return { thread: t, anchor: null, staged: true };
      }
      const render = await ctx.render(doc, head.v);
      const anchor = overrideAnchor({ version: head.v, lines, quote, source: head.source, render, env: envOf(doc, ctx.config) });
      if (!anchor) throw new RefusedError(`text not found in v${head.v}: ${truncate(String(quote), 60)}`);
      t.anchors = { ...t.anchors, [String(head.v)]: anchor };
      t.override = { version: head.v, ...(lines ? { lines } : { quote }), by: 'agent' };
      t.updatedAt = ctx.now();
      await ctx.store.saveThread(doc.id, t);
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, moved: true });
      return { thread: t, anchor, staged: false };
    },
    { ack: true },
  );
}

/**
 * One row per thread, optionally filtered: open | addressed | answered | declined | needs_input | resolved |
 * outdated | actionable | all (default: every unresolved thread).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ status?: string }} [opts]
 */
export async function threads(ctx, ref, { status } = {}) {
  const doc = await resolveDoc(ctx, ref);
  const snap = await loadSnapshot(ctx, doc);
  const li = lineIndex(snap.working.text);
  const filter = status ?? 'unresolved';
  const rows = snap.threads
    .filter((t) => {
      const a = anchorAt(t, doc.head);
      switch (filter) {
        case 'all':
          return true;
        case 'unresolved':
          return t.status !== 'resolved';
        case 'outdated':
          return t.status !== 'resolved' && isOutdated(a);
        case 'actionable':
          return isActionable(t);
        default:
          return t.status === filter;
      }
    })
    .map((t) => {
      const a = anchorAt(t, doc.head);
      let lines = null;
      if (a && a.kind !== 'doc' && a.state !== 'orphaned') {
        const m = snap.mapper.mapRange(a.src.start, a.src.end);
        const l0 = li.lineOf(m.start);
        lines = [l0, Math.max(l0, m.end > m.start ? li.lineOf(m.end - 1) : l0)];
      }
      const first = t.comments[0];
      return {
        id: t.id,
        type: t.type,
        severity: t.severity,
        status: t.status,
        actionable: isActionable(t),
        lines,
        target: a?.kind ?? 'doc',
        label: anchorLabel(a),
        anchorState: a?.state ?? null,
        sectionLabel: sectionPath(a?.section ?? [], doc.title),
        // a suggestion may come without a comment: summarise it by its replacement text
        summary: first?.body || (t.suggestion ? `suggests: ${t.suggestion.new}` : ''),
        comments: t.comments.length,
      };
    })
    .sort((a, b) => compareIds(a.id, b.id));
  return { doc: doc.id, filter, threads: rows };
}

/**
 * `show <doc> <tid>`: a thread with its timeline and the changes linked to it; `show <doc> --version N
 * [--lines A-B]`: exact source of an old version (no line numbers, so it can be copied).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ thread?: string | null, version?: number | string | null, lines?: string | [number, number] | null }} [opts]
 */
export async function show(ctx, ref, { thread, version, lines } = {}) {
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      if (!thread) {
        const v = /** @type {number} */ (parseVersionArg(version, { fallback: doc.head }));
        const { source } = await ctx.store.readVersion(doc.id, v);
        const li = lineIndex(source);
        const range = toRange(lines) ?? [1, li.count];
        const from = Math.max(1, range[0]);
        const to = Math.min(li.count, range[1]);
        const out = [];
        for (let l = from; l <= to; l++) out.push(li.lineText(l));
        return { kind: 'source', doc: doc.id, version: v, startLine: from, endLine: to, lines: out };
      }
      const t = await requireThread(ctx, doc.id, thread);
      return showThread(ctx, doc, t);
    },
    { ack: true },
  );
}

/**
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Thread} t
 */
async function showThread(ctx, doc, t) {
  const a = anchorAt(t, doc.head);
  const head = await readHead(ctx, doc);
  const working = await readWorkingState(ctx, doc, head);
  const snapLines = a && a.kind !== 'doc' && a.state !== 'orphaned' ? [a.src.startLine, a.src.endLine] : null;
  const load = versionLoader(ctx, doc);
  /** @type {Array<{ from: number, to: number, hunk: string, before: string, after: string }>} */
  const changes = [];
  for (const ch of t.changes ?? []) {
    if (!ch.hunk || ch.version < 2) continue;
    try {
      const [prev, cur] = await Promise.all([load(ch.version - 1), load(ch.version)]);
      const h = lineHunks(prev.source, cur.source).find((x) => x.id === ch.hunk);
      if (!h) continue;
      changes.push({ from: ch.version - 1, to: ch.version, hunk: ch.hunk, before: prev.source.slice(h.oldStartOff, h.oldEndOff).trim(), after: cur.source.slice(h.newStartOff, h.newEndOff).trim() });
    } catch {
      // a version file is unreadable: skip the change line
    }
  }
  // comments without content (a suggestion submitted without a comment) are left out of the timeline
  const timeline = t.comments.filter(hasContent).map((c) => ({
    version: c.version,
    by: c.by?.name ?? '',
    kind: c.by?.kind ?? 'human',
    review: c.review ?? null,
    status: c.status ?? null,
    hunk: c.by?.kind === 'agent' ? (t.changes ?? []).filter((ch) => ch.version === c.version).map((ch) => ch.hunk).join(' ') || null : null,
    body: c.body ?? '',
    at: c.at,
  }));
  const { lastAgent, lastHuman } = lastIndexes(t);
  let statusLabel = t.status.toUpperCase();
  if (t.status === 'open' && lastAgent >= 0 && lastHuman > lastAgent) statusLabel = 'REOPENED';
  const d = a
    ? describe(a, {
        headSource: head.source,
        workingSource: working.missing ? head.source : working.text,
        hunks: lineHunks(head.source, working.missing ? head.source : working.text),
        env: envOf(doc, ctx.config),
        attachments: t.attachments ?? [],
        absAttachmentPath: (rel) => ctx.store.attachmentPath(doc.id, rel),
      })
    : null;
  return {
    kind: 'thread',
    doc: doc.id,
    thread: t,
    statusLabel,
    anchor: a ? { state: a.state, v: a.v, lines: snapLines, kind: a.kind, section: a.section } : null,
    workingLines: d?.lines ?? null,
    label: d?.label ?? '',
    on: d?.on ?? null,
    src: d?.src ?? null,
    srcUnique: d?.srcUnique ?? false,
    srcEditable: d?.srcEditable ?? true,
    attachments: d?.crops ?? [],
    timeline,
    changes,
  };
}

/**
 * 'L42-46' | '42-46' | [42, 46] -> [42, 46]; null for empty.
 * @param {string | [number, number] | number[] | null | undefined} v
 * @returns {[number, number] | null}
 */
export function toRange(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    const a = Number(v[0]);
    const b = Number(v[1] ?? v[0]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) throw new UsageError(`invalid line range: ${JSON.stringify(v)}`);
    return [a, b];
  }
  try {
    const ranges = parseLinesArg(String(v));
    return [ranges[0][0], ranges[ranges.length - 1][1]];
  } catch (err) {
    throw new UsageError(/** @type {Error} */ (err).message);
  }
}
