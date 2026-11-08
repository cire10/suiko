// @ts-check
// Submitting a review (design 3.5, 5.4 "Review submit", 11.6):
//   submitReview(ctx, doc, { verdict, body, markFinal, resolveAddressed, by, draftIds, expectHead, edits, apply,
//     instant }) -> Review
// Inside the doc lock:
//   1. take the selected drafts (draftIds omitted = all, except with a non-empty `apply`: then none, so the
//      reviewer's unsent drafts never go out with an Apply unless draftIds names them; "Send now" passes one);
//   2. allocate ids and compute everything in memory: new threads (anchors carried forward to head for drafts made
//      on older versions), replies / reopens / resolutions on existing threads, doc.json (counters,
//      lastReviewedVersion, final);
//   3. write the new thread files (ignored by readers and removed by recovery until the review exists);
//   4. write the redo journal (doc.json, touched threads, consumed drafts, events; see Store.writeJournal);
//   5. write reviews/rvN.json - the COMMIT POINT;
//   6. apply the journal: doc.json, touched threads, remove the submitted drafts, append review.submitted
//      (+ doc.approved, drafts.changed, thread.updated) events.
// A crash before (5) changes nothing visible (no phantom final or approval: doc.json is written after it); a crash
// after it is rolled forward by recoverDoc (no lost reply, no draft left to be submitted twice).
// A reviewer reply on a needs_input thread (an ANSWER) or with `reopen` makes the thread `open` again.
// Approve + resolveAddressed resolves addressed/answered threads; approve + markFinal marks head final.
// `expectHead` (the version the reviewer was looking at) makes an approval fail with ConflictError (HTTP 409)
// when another version was recorded since: approving or marking final a version nobody reviewed is refused. It is
// also the doc's lastReviewedVersion ("since your last review"), which never moves back; without it, the head.
// `instant` (the UI's one-item sends: a comment or reply sent right away, a draft's Send, Use in doc, Apply) is
// stored on the review (`instant: true`) and leaves lastReviewedVersion where it is: sending one comment is not
// reviewing the version, so its changes stay new until a review from the Send dialog, an approval, or the reviewer
// accepting them (acceptRevisions). An approval is never instant.
// Batched edits ("talk now, edit later"):
// - `edits` ('now' | 'batch', protocol.js REVIEW_EDITS; default 'now', always 'now' on an approval) is stored on
//   the review; a packet that delivers a 'batch' review asks the agent to answer every thread now and to reply
//   `planned` for a change it agrees to make, instead of editing.
// - `apply` (thread ids) applies planned changes: each must be `planned` (else ConflictError, HTTP 409; unknown:
//   NotFoundError); it is reopened (status open) with a reviewer comment "Apply this change." marked `apply`, and
//   listed in review.apply; the packet labels it APPLY. It cannot come with an approval, nor resolve the same thread.
// A reviewer reply may carry `use` (attachment paths of its thread, attachments.js normalizeUse): stored on the
// reviewer's comment, it asks the agent to put those files into the doc (packet `use:` lines). A `use` reply on a
// resolved thread reopens it, so the request reaches the agent.

import { REVIEW_EDITS, SSE, VERDICTS } from '../../../shared/protocol.js';
import { ConflictError, NotFoundError, UsageError } from '../../store/errors.js';
import { compareIds } from '../../store/store.js';
import { anchorAt } from '../threadstate.js';
import { normalizeUse } from '../attachments.js';
import { kindOf } from '../kinds.js';
import { humanActor, oneOf, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Review} Review
 * @typedef {import('../../../shared/types.js').DraftItem} DraftItem
 */

/** The reviewer comment an `apply` adds to each applied thread. */
export const APPLY_COMMENT = 'Apply this change.';

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ verdict?: string, body?: string, markFinal?: boolean, resolveAddressed?: boolean, by?: string,
 *   draftIds?: string[] | null, expectHead?: number | string | null, edits?: string | null,
 *   apply?: string[] | null, instant?: boolean | null }} [input]
 * @returns {Promise<Review>}
 */
export async function submitReview(ctx, ref, input = {}) {
  const verdict = oneOf(input.verdict ?? 'comment', VERDICTS, 'verdict');
  const body = String(input.body ?? '');
  if (input.instant != null && typeof input.instant !== 'boolean') throw new UsageError(`instant must be a boolean, not ${JSON.stringify(input.instant)}`);
  // a one-item send; an approval always reviews the version
  const instant = input.instant === true && verdict !== 'approved';
  const expectHead = input.expectHead == null || input.expectHead === '' ? null : Number(String(input.expectHead).replace(/^v/i, ''));
  if (expectHead !== null && !Number.isSafeInteger(expectHead)) throw new UsageError(`invalid expectHead: ${JSON.stringify(input.expectHead)}`);
  const askedEdits = input.edits == null ? 'now' : oneOf(input.edits, REVIEW_EDITS, 'edits');
  // an approval asks for no edits
  const edits = verdict === 'approved' ? 'now' : askedEdits;
  const apply = applyList(input.apply);
  if (apply.length && verdict === 'approved') throw new UsageError('apply asks for changes: it cannot come with an approval');
  return withDoc(ctx, ref, async (doc) => {
    if (!doc.head) throw new UsageError(`${doc.id} has no recorded version to review`);
    if (verdict === 'approved' && expectHead !== null && expectHead !== doc.head) {
      throw new ConflictError(`v${doc.head} of ${doc.id} was recorded after you opened v${expectHead}; review it before approving${input.markFinal ? ' or marking it final' : ''}`, {
        details: { doc: doc.id, head: doc.head, expectHead },
      });
    }
    const by = humanActor(ctx, input.by);
    const at = ctx.now();
    const drafts = await ctx.store.getDrafts(doc.id);
    // an Apply takes only the drafts it names (none without draftIds); any other review, all of them by default
    const wanted = input.draftIds ? new Set(input.draftIds) : apply.length ? new Set() : null;
    if (wanted) {
      for (const id of wanted) {
        if (!drafts.items.some((d) => d.id === id)) throw new NotFoundError(`draft ${id} not found in ${doc.id}`, { details: { doc: doc.id, draft: id } });
      }
    }
    const items = drafts.items.filter((d) => !wanted || wanted.has(d.id));
    if (!items.length && !body.trim() && !apply.length && verdict === 'comment') throw new UsageError('nothing to submit: no drafts and no summary');

    const reviews = await ctx.store.listReviews(doc.id);
    const prevAt = reviews.reduce((m, r) => (r.submittedAt > m ? r.submittedAt : m), '');

    // Existing threads touched by this review (committed only).
    /** @type {Map<string, Thread>} */
    const existing = new Map((await ctx.store.listThreads(doc.id)).map((t) => [t.id, t]));
    /** @type {Set<string>} */
    const touched = new Set();
    // Apply: only planned threads (checked before anything changes, against their state before this review)
    for (const tid of apply) {
      const t = existing.get(tid);
      if (!t) throw new NotFoundError(`apply: thread ${tid} not found in ${doc.id}`, { details: { doc: doc.id, thread: tid } });
      if (t.status !== 'planned') {
        throw new ConflictError(`apply: ${tid} is ${t.status.replace('_', ' ')}, not planned; only a planned change (the agent said what it will change) can be applied`, {
          details: { doc: doc.id, thread: tid, status: t.status },
        });
      }
      if (items.some((d) => d.kind === 'resolve' && d.thread === tid)) throw new UsageError(`apply: ${tid} is also resolved by this review`);
    }

    const reviewId = ctx.store.nextId(doc, 'review');
    const head = doc.head;
    // drafts made on older versions are carried forward by the doc kind (a code anchor keeps its file and lines)
    /** @type {ReturnType<import('../kinds.js').KindAdapter['forwarder']> | null} */
    let forward = null;

    // New threads.
    /** @type {Thread[]} */
    const created = [];
    for (const d of items) {
      if (d.kind !== 'thread') continue;
      const anchors = d.anchor.v < head ? await (forward ??= kindOf(doc).forwarder(ctx, doc))(d.anchor, head) : { [String(d.anchor.v)]: d.anchor };
      const tid = ctx.store.nextId(doc, 'thread');
      const cid = ctx.store.nextId(doc, 'comment');
      created.push({
        schema: 1,
        id: tid,
        doc: doc.id,
        type: d.type,
        severity: d.severity ?? 'normal',
        status: 'open',
        createdIn: d.anchor.v,
        createdBy: by,
        review: reviewId,
        anchors,
        override: null,
        suggestion: d.suggestion ? { ...d.suggestion, status: 'pending', appliedIn: null } : null,
        comments: [{ id: cid, by, body: d.body ?? '', at, review: reviewId, version: d.anchor.v }],
        changes: [],
        attachments: d.attachments ?? [],
        decision: null,
        resolvedIn: null,
        updatedAt: at,
      });
    }

    // Replies, reopens and resolutions on existing threads.
    /** @type {Review['replies']} */
    const replies = [];
    /** @type {string[]} */
    const reopened = [];
    /** @type {string[]} */
    const resolvedNow = [];
    for (const d of items) {
      if (d.kind === 'thread') continue;
      const t = existing.get(d.thread);
      if (!t) throw new NotFoundError(`thread ${d.thread} (draft ${d.id}) not found in ${doc.id}`, { details: { doc: doc.id, thread: d.thread } });
      if (d.kind === 'reply') {
        const use = normalizeUse(t, /** @type {any} */ (d).use);
        const cid = ctx.store.nextId(doc, 'comment');
        t.comments.push({ id: cid, by, body: d.body ?? '', at, review: reviewId, version: head, ...(use.length ? { use } : {}) });
        replies.push({ thread: t.id, comment: cid });
        if (d.reopen || (use.length && t.status === 'resolved')) {
          if (t.status !== 'open') reopened.push(t.id);
          t.status = 'open';
          t.resolvedIn = null;
        } else if (t.status === 'needs_input') {
          t.status = 'open';
        }
      } else if (d.kind === 'resolve') {
        resolveInPlace(ctx, doc, t, { decision: /** @type {any} */ (d).decision, at, head });
        resolvedNow.push(t.id);
      }
      t.updatedAt = at;
      touched.add(t.id);
    }

    // Apply: reopen each planned thread with the "Apply this change." request (after the drafts: a reply sent with
    // the Apply comes first, the request last)
    for (const tid of apply) {
      const t = /** @type {Thread} */ (existing.get(tid));
      t.comments.push({ id: ctx.store.nextId(doc, 'comment'), by, body: APPLY_COMMENT, at, review: reviewId, version: head, apply: true });
      t.status = 'open';
      t.resolvedIn = null;
      t.updatedAt = at;
      touched.add(t.id);
    }

    if (verdict === 'approved' && input.resolveAddressed) {
      for (const t of existing.values()) {
        if ((t.status === 'addressed' || t.status === 'answered') && !touched.has(t.id)) {
          resolveInPlace(ctx, doc, t, { at, head });
          resolvedNow.push(t.id);
          touched.add(t.id);
        }
      }
    }

    // Threads resolved since the previous review (Accept is immediate) plus the ones resolved now.
    const resolvedSince = [...existing.values()]
      .filter((t) => t.status === 'resolved' && /** @type {any} */ (t).resolvedAt && (!prevAt || /** @type {any} */ (t).resolvedAt > prevAt))
      .map((t) => t.id);
    const locksAdded = (await ctx.store.listLocks(doc.id))
      .filter((l) => l.createdAt && (!prevAt || l.createdAt > prevAt))
      .map((l) => l.id);

    const markFinal = verdict === 'approved' && Boolean(input.markFinal);
    // "Since your last review" starts at the version the reviewer was looking at (expectHead): a newer one recorded
    // meanwhile stays new to them. It never moves back (a comment sent while browsing an older version), and a
    // one-item send (instant) does not move it at all.
    if (!instant) {
      const seen = expectHead !== null && expectHead >= 1 && expectHead < head ? expectHead : head;
      doc.lastReviewedVersion = Math.max(seen, Number(doc.lastReviewedVersion) || 0);
    }
    if (markFinal) {
      doc.state = 'approved';
      doc.final = { version: head, review: reviewId, at, by: by.name };
    } else if (doc.state === 'closed') {
      doc.state = 'in_review';
    }

    for (const t of created) await ctx.store.saveThread(doc.id, t);

    /** @type {Review} */
    const review = {
      schema: 1,
      id: reviewId,
      version: head,
      by,
      verdict,
      body,
      markFinal,
      edits,
      ...(instant ? { instant: true } : {}),
      newThreads: created.map((t) => t.id),
      replies,
      reopened,
      ...(apply.length ? { apply: [...apply].sort(compareIds) } : {}),
      resolved: [...new Set([...resolvedSince, ...resolvedNow])].sort(compareIds),
      locksAdded,
      submittedAt: at,
      deliveredTo: {},
      ackedBy: {},
    };
    const touchedIds = [...touched].sort(compareIds);
    const submitted = items.map((d) => d.id);
    /** @type {Array<{ type: string } & Record<string, unknown>>} */
    const events = [{ type: SSE.REVIEW_SUBMITTED, review: reviewId, verdict }];
    if (touchedIds.length) events.push({ type: SSE.THREAD_UPDATED, threads: touchedIds });
    if (submitted.length) events.push({ type: SSE.DRAFTS_CHANGED, submitted });
    if (markFinal) events.push({ type: SSE.DOC_APPROVED, v: head, review: reviewId });
    /** @type {import('../../store/store.js').Journal} */
    const journal = {
      review: reviewId,
      doc: { ...doc },
      threads: touchedIds.map((id) => /** @type {Thread} */ (existing.get(id))),
      removeDrafts: submitted,
      events,
    };
    await ctx.store.writeJournal(doc.id, journal);
    await ctx.store.saveReview(doc.id, review); // commit point
    await ctx.store.applyJournal(doc.id, journal);
    return review;
  });
}

/**
 * The thread ids of `apply` (deduplicated; [] when absent), else UsageError.
 * @param {unknown} list
 * @returns {string[]}
 */
function applyList(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && /^t\d+$/.test(t))) {
    throw new UsageError('apply must be a list of thread ids (e.g. ["t2", "t5"])');
  }
  return [...new Set(/** @type {string[]} */ (list))];
}

/**
 * Resolves a thread in memory (status, resolvedIn, resolvedAt and an optional decision with a new D-id).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Thread} t
 * @param {{ decision?: string | null, at: string, head: number }} p
 */
export function resolveInPlace(ctx, doc, t, { decision, at, head }) {
  t.status = 'resolved';
  t.resolvedIn = head;
  /** @type {any} */ (t).resolvedAt = at;
  t.updatedAt = at;
  const text = decision ? String(decision).trim() : '';
  if (text) {
    const anchor = anchorAt(t, head);
    t.decision = { id: t.decision?.id ?? ctx.store.nextId(doc, 'decision'), text, version: head, srcText: anchor?.src?.text ?? '', at };
  }
}
