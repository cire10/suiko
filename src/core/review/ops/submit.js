// @ts-check
// Submitting a review (design 3.5, 5.4 "Review submit", 11.6):
//   submitReview(ctx, doc, { verdict, body, markFinal, resolveAddressed, by, draftIds }) -> Review
// Inside the doc lock:
//   1. take the selected drafts (draftIds omitted = all; "Send now" passes one);
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
// when another version was recorded since: approving or marking final a version nobody reviewed is refused.

import { SSE, VERDICTS } from '../../../shared/protocol.js';
import { ConflictError, NotFoundError, UsageError } from '../../store/errors.js';
import { compareIds } from '../../store/store.js';
import { anchorAt } from '../threadstate.js';
import { kindOf } from '../kinds.js';
import { humanActor, oneOf, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Review} Review
 * @typedef {import('../../../shared/types.js').DraftItem} DraftItem
 */

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ verdict?: string, body?: string, markFinal?: boolean, resolveAddressed?: boolean, by?: string,
 *   draftIds?: string[] | null, expectHead?: number | string | null }} [input]
 * @returns {Promise<Review>}
 */
export async function submitReview(ctx, ref, input = {}) {
  const verdict = oneOf(input.verdict ?? 'comment', VERDICTS, 'verdict');
  const body = String(input.body ?? '');
  const expectHead = input.expectHead == null || input.expectHead === '' ? null : Number(String(input.expectHead).replace(/^v/i, ''));
  if (expectHead !== null && !Number.isSafeInteger(expectHead)) throw new UsageError(`invalid expectHead: ${JSON.stringify(input.expectHead)}`);
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
    const wanted = input.draftIds ? new Set(input.draftIds) : null;
    if (wanted) {
      for (const id of wanted) {
        if (!drafts.items.some((d) => d.id === id)) throw new NotFoundError(`draft ${id} not found in ${doc.id}`, { details: { doc: doc.id, draft: id } });
      }
    }
    const items = drafts.items.filter((d) => !wanted || wanted.has(d.id));
    if (!items.length && !body.trim() && verdict === 'comment') throw new UsageError('nothing to submit: no drafts and no summary');

    const reviews = await ctx.store.listReviews(doc.id);
    const prevAt = reviews.reduce((m, r) => (r.submittedAt > m ? r.submittedAt : m), '');
    const reviewId = ctx.store.nextId(doc, 'review');
    const head = doc.head;
    // drafts made on older versions are carried forward by the doc kind (a code anchor keeps its file and lines)
    /** @type {ReturnType<import('../kinds.js').KindAdapter['forwarder']> | null} */
    let forward = null;

    // Existing threads touched by this review (committed only).
    /** @type {Map<string, Thread>} */
    const existing = new Map((await ctx.store.listThreads(doc.id)).map((t) => [t.id, t]));
    /** @type {Set<string>} */
    const touched = new Set();

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
        const cid = ctx.store.nextId(doc, 'comment');
        t.comments.push({ id: cid, by, body: d.body ?? '', at, review: reviewId, version: head });
        replies.push({ thread: t.id, comment: cid });
        if (d.reopen) {
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
    doc.lastReviewedVersion = head;
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
      newThreads: created.map((t) => t.id),
      replies,
      reopened,
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
