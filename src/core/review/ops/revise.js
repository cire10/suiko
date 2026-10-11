// @ts-check
// Recording revisions (design 3.8, 8.1, 9.5; BUILD_AMENDMENTS 4.3 / 4.4):
//   revise(ctx, doc, ReviseInput & { dryRun, force, allowRewrite, breakLocks }) -> ReviseReport
//     - working copy == head (text and local assets): replies only (or "nothing to record"); pending tagged edits
//       are stale then (undone / reverted) and are dropped, their `staged` suggestions set back to `pending`;
//     - otherwise hunks + attribution + guards; refused => report.refused (nothing written, exit 3 in the CLI);
//       dryRun => the full report, nothing written; else the version is recorded (see ops/record.js).
//   recordReviewerVersion(ctx, doc, { summary, by })     -> VersionManifest ("Record as my revision")
//   applySuggestionAsReviewer(ctx, doc, tid, { by })     -> VersionManifest ("Apply now"; clean working copy only;
//     the suggestion's text must still be on the thread's anchored lines - never another copy elsewhere)
//
// ReviseReport = { doc, from, version, refused, dryRun, nothing, repliesOnly, respondsTo,
//   stats: { added, removed, hunks, rewriteRatio }, hunks: [{ id, oldRange, newRange, fromVersion, section, threads,
//   linkedBy, via, other, stats }], assets: [{ path, threads }], replies: [{ thread, status }],
//   guards: GuardResult, anchors: { threads, locks, exact, moved, edited, changed, orphaned } | null,
//   notified, git }

import { AGENT_REPLY_STATUS, SSE } from '../../../shared/protocol.js';
import { ConflictError, RefusedError, UsageError } from '../../store/errors.js';
import { eolOf, lineWindow, locateSuggestion, matchEol, spliceText, suggestionTarget } from '../apply.js';
import { anchorAt } from '../threadstate.js';
import { resolveInPlace } from './submit.js';
import { addAgentReply } from './threads.js';
import { commitRecord, prepareRecord, reportHunks } from './record.js';
import { agentActor, changedWorkingAssets, emit, humanActor, readHead, requireThread, requireWorking, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Review} Review
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 */

/**
 * Validates and normalises a ReviseInput.
 * @param {any} input
 */
export function parseReviseInput(input) {
  const src = input ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) throw new UsageError('revise input must be a JSON object');
  /** @type {Record<string, { status: string, reply: string, at?: string }>} */
  const threads = {};
  const rawThreads = src.threads ?? {};
  if (typeof rawThreads !== 'object' || Array.isArray(rawThreads)) throw new UsageError('"threads" must be an object keyed by thread id');
  for (const [tid, r] of Object.entries(rawThreads)) {
    if (!/^t\d+$/.test(tid)) throw new UsageError(`invalid thread id in "threads": ${JSON.stringify(tid)}`);
    if (!r || typeof r !== 'object') throw new UsageError(`"threads.${tid}" must be an object {status, reply, at?}`);
    const entry = /** @type {any} */ (r);
    if (!AGENT_REPLY_STATUS.includes(entry.status)) {
      throw new UsageError(`"threads.${tid}.status" must be one of ${AGENT_REPLY_STATUS.join(' | ')}`);
    }
    if (typeof entry.reply !== 'string' || !entry.reply.trim()) throw new UsageError(`"threads.${tid}.reply" must be a non-empty string`);
    threads[tid] = { status: entry.status, reply: entry.reply, ...(entry.at ? { at: String(entry.at) } : {}) };
  }
  const other = src.other ?? [];
  if (!Array.isArray(other)) throw new UsageError('"other" must be an array of {at, why}');
  for (const o of other) {
    if (!o || typeof o.at !== 'string' || typeof o.why !== 'string') throw new UsageError('each "other" entry needs string "at" and "why"');
  }
  const breakLocks = src.breakLocks ?? {};
  if (typeof breakLocks !== 'object' || Array.isArray(breakLocks)) throw new UsageError('"breakLocks" must be an object {L1: "reason"}');
  return {
    summary: typeof src.summary === 'string' ? src.summary.trim() : '',
    threads,
    other: other.map((/** @type {any} */ o) => ({ at: o.at, why: o.why })),
    breakLocks: /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(breakLocks).map(([k, v]) => [k, String(v ?? '')]))),
    allowRewrite: Boolean(src.allowRewrite),
    force: Boolean(src.force),
    dryRun: Boolean(src.dryRun),
  };
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {any} input ReviseInput plus flags { dryRun, force, allowRewrite, breakLocks }
 */
export async function revise(ctx, ref, input) {
  const p = parseReviseInput(input);
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      for (const tid of Object.keys(p.threads)) await requireThread(ctx, doc.id, tid);
      for (const lid of Object.keys(p.breakLocks)) {
        if (!(await ctx.store.getLock(doc.id, lid))) throw new UsageError(`--break-lock ${lid}: no such lock`);
      }
      const head = await readHead(ctx, doc);
      const working = await requireWorking(ctx, doc, head);
      const replies = Object.entries(p.threads).map(([thread, r]) => ({ thread, status: r.status }));
      const base = {
        doc: doc.id,
        from: head.v,
        version: /** @type {number | null} */ (null),
        refused: false,
        dryRun: p.dryRun,
        nothing: false,
        repliesOnly: false,
        respondsTo: /** @type {string | null} */ (null),
        stats: { added: 0, removed: 0, hunks: 0, rewriteRatio: 0 },
        hunks: /** @type {any[]} */ ([]),
        assets: /** @type {Array<{ path: string, threads: string[] }>} */ ([]),
        replies,
        guards: /** @type {any} */ ({ refused: false, forced: false, errors: [], warnings: [], brokenLocks: [], intactLocks: [], unexplained: [], rewriteRatio: 0 }),
        anchors: /** @type {any} */ (null),
        notified: false,
        git: /** @type {any} */ (null),
      };

      // An unchanged spec with a replaced image is still a revision (BUILD_AMENDMENTS 4.5).
      if (!working.dirty && !(await changedWorkingAssets(ctx, doc, head)).length) {
        // The working copy equals head, so nothing applied or edited since is in it any more (undone by hand or
        // with `revert`): drop the stale tagged edits and un-stage their suggestions, or they would tag (and
        // "apply") a later unrelated change.
        const unstaged = p.dryRun ? [] : await dropStalePending(ctx, doc);
        if (!replies.length) return { ...base, nothing: true };
        if (!p.dryRun) {
          for (const [tid, r] of Object.entries(p.threads)) {
            const t = unstaged.find((x) => x.id === tid) ?? (await requireThread(ctx, doc.id, tid));
            addAgentReply(ctx, doc, t, { body: r.reply, status: r.status, at: r.at });
            await ctx.store.saveThread(doc.id, t);
          }
          await ctx.store.saveDoc(doc);
          await emit(ctx, doc.id, SSE.THREAD_UPDATED, { threads: Object.keys(p.threads), replies: true });
        }
        return { ...base, repliesOnly: true, notified: !p.dryRun };
      }

      const prep = await prepareRecord(ctx, doc, {
        head,
        working,
        replies: p.threads,
        other: p.other,
        guards: true,
        flags: { force: p.force, allowRewrite: p.allowRewrite, breakLocks: p.breakLocks },
      });
      const g = /** @type {import('../guards.js').GuardResult} */ (prep.guards);
      const respondsTo = respondsToOf(prep.reviews, ctx.agent);
      const report = {
        ...base,
        respondsTo,
        stats: {
          added: prep.hunks.reduce((n, h) => n + h.newLines, 0),
          removed: prep.hunks.reduce((n, h) => n + h.oldLines, 0),
          hunks: prep.hunks.length,
          rewriteRatio: Math.round(g.rewriteRatio * 10000) / 10000,
        },
        hunks: reportHunks(prep),
        assets: prep.changedAssets.map((path) => ({
          path,
          threads: Object.entries(prep.assetLinks).filter(([, ps]) => ps.includes(path)).map(([t]) => t).sort(),
        })),
        guards: g,
      };
      if (g.refused) return { ...report, refused: true };
      if (p.dryRun) return { ...report, version: head.v + 1 };

      const summary = p.summary || defaultSummary(respondsTo, Object.keys(p.threads));
      const res = await commitRecord(ctx, doc, prep, {
        author: agentActor(ctx),
        summary,
        capturedBy: 'revise',
        respondsTo,
        replies: p.threads,
        breakLocks: p.breakLocks,
      });
      return { ...report, version: res.manifest.v, anchors: res.anchors, notified: true, git: res.git };
    },
    { ack: true },
  );
}

/**
 * The working copy equals head: clears the pending tagged edits and sets every `staged` suggestion back to
 * `pending` (saved). Returns the threads changed.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {Promise<import('../../../shared/types.js').Thread[]>}
 */
async function dropStalePending(ctx, doc) {
  const pending = await ctx.store.readPendingEdits(doc.id);
  if (pending.length) await ctx.store.clearPendingEdits(doc.id);
  const changed = [];
  for (const t of await ctx.store.listThreads(doc.id)) {
    if (t.suggestion?.status !== 'staged') continue;
    t.suggestion.status = 'pending';
    t.updatedAt = ctx.now();
    await ctx.store.saveThread(doc.id, t);
    changed.push(t);
  }
  if (changed.length) await emit(ctx, doc.id, SSE.THREAD_UPDATED, { threads: changed.map((t) => t.id) });
  return changed;
}

/**
 * The review a revision answers: the newest review delivered to the agent, else the newest review.
 * @param {Review[]} reviews
 * @param {string} agent
 * @returns {string | null}
 */
function respondsToOf(reviews, agent) {
  const sorted = [...reviews].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  const delivered = sorted.filter((r) => r.deliveredTo?.[agent]);
  return (delivered[delivered.length - 1] ?? sorted[sorted.length - 1])?.id ?? null;
}

/**
 * @param {string | null} respondsTo
 * @param {string[]} threads
 */
function defaultSummary(respondsTo, threads) {
  const t = threads.length ? `: ${threads.join(' ')}` : '';
  return respondsTo ? `${respondsTo}${t}` : `revision${t}`;
}

/**
 * Reviewer "Record as my revision": records the working copy as a human-authored version (no guards).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ summary?: string, by?: string }} [opts]
 * @returns {Promise<VersionManifest>}
 */
export async function recordReviewerVersion(ctx, ref, { summary, by } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const head = await readHead(ctx, doc);
    const working = await requireWorking(ctx, doc, head);
    if (!working.dirty && !(await changedWorkingAssets(ctx, doc, head)).length) {
      throw new RefusedError(`the working copy matches v${head.v}; nothing to record`);
    }
    const prep = await prepareRecord(ctx, doc, { head, working });
    const res = await commitRecord(ctx, doc, prep, {
      author: humanActor(ctx, by),
      summary: summary?.trim() || 'Recorded by the reviewer',
      capturedBy: 'ui-record',
      respondsTo: null,
    });
    return res.manifest;
  });
}

/**
 * Reviewer "Apply now": applies a suggestion to a clean working copy, records it as a version and resolves the
 * thread. ConflictError (HTTP 409) when the working copy has unrecorded changes.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @param {{ by?: string }} [opts]
 * @returns {Promise<VersionManifest>}
 */
export async function applySuggestionAsReviewer(ctx, ref, tid, { by } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const t = await requireThread(ctx, doc.id, tid);
    const s = t.suggestion;
    if (!s) throw new UsageError(`${tid} is not a suggestion`);
    if (s.status === 'applied') throw new RefusedError(`${tid} was already applied in v${s.appliedIn}`);
    const head = await readHead(ctx, doc);
    const working = await requireWorking(ctx, doc, head);
    if (working.dirty) throw new ConflictError(`the working copy of ${doc.path} has unrecorded changes; apply needs a clean working copy`);
    const a = anchorAt(t, head.v);
    if (!a || a.state === 'orphaned') throw new RefusedError(`${tid} lost its anchor; it cannot be applied automatically`);
    // Only where the thread is anchored now: never in another copy of the same text elsewhere in the doc.
    const { expected, window } = suggestionTarget(a, s, head.v);
    const loc = locateSuggestion(head.source, s.old, expected, lineWindow(head.source, window.start, window.end));
    if (!loc) throw new RefusedError(`conflict ${tid}: the suggested text is no longer where ${tid} is anchored in v${head.v} (L${a.src.startLine}); it cannot be applied automatically`);
    const insert = matchEol(s.new, eolOf(working.text));
    const splice = spliceText(working.text, loc.start, loc.end, insert);
    const written = await ctx.store.writeWorking(doc, splice.text, { expectSha256: working.sha256 });
    await ctx.store.appendPendingEdit(doc.id, { via: 'apply', threads: [tid], oldLines: splice.oldLines, newLines: splice.newLines, beforeSha256: working.sha256, afterSha256: written.sha256, ...(insert.trim() ? { newText: insert } : {}) });
    s.status = 'staged';
    await ctx.store.saveThread(doc.id, t);

    const fresh = await requireWorking(ctx, doc, head);
    const prep = await prepareRecord(ctx, doc, { head, working: fresh });
    const actor = humanActor(ctx, by);
    const res = await commitRecord(ctx, doc, prep, {
      author: actor,
      summary: `Applied suggestion ${tid}`,
      capturedBy: 'ui-apply',
      respondsTo: null,
      autoReply: false,
      // resolved with the version (inside its commit), not in a separate write after it
      finish: (threads, v, events) => {
        const after = threads.get(tid);
        if (!after) return;
        if (after.suggestion) {
          after.suggestion.status = 'applied';
          after.suggestion.appliedIn = v;
        }
        resolveInPlace(ctx, doc, after, { at: ctx.now(), head: v });
        /** @type {any} */ (after).resolvedBy = actor.name;
        events.push({ type: SSE.THREAD_UPDATED, thread: tid, status: after.status });
      },
    });
    return res.manifest;
  });
}
