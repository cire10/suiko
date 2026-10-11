// @ts-check
// Shared plumbing for the review ops (design 4.4 / 5.4, BUILD_AMENDMENTS 2.3 / 2.4):
// - withDoc: the per-doc critical section every mutating op runs in (doc lock -> recoverDoc -> fresh doc.json ->
//   optional ack of delivered reviews -> fn). Re-entrant, so ops may call ops.
// - resolveDoc: also rolls forward an interrupted commit (its redo journal) before a reader looks at the doc.
// - ackDelivered: the agent's next op on a doc acknowledges reviews delivered to it (review.ackedBy[agent]).
// - loadSnapshot: head version, working copy, head->working mapper, threads, locks and reviews in one read.
// - actors, events (SSE names from protocol.js), version loaders with render caching, small lookups.

import fs from 'node:fs';
import { SSE } from '../../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../../store/errors.js';
import { changedAssets, hashWorkingAssets } from '../assets.js';
import { preciseMapper } from '../workmap.js';
import { docRefFor, isSnapshot, snapshotRefusal } from '../../store/snapshot.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Actor} Actor
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Review} Review
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {import('../../render/index.js').RenderResult} RenderResult
 * @typedef {{ text: string, sha256: string | null, buf: Buffer | null, missing: boolean, dirty: boolean }} WorkingState
 * @typedef {{ v: number, manifest: VersionManifest, source: string }} HeadState
 * @typedef {import('../packet-data.js').Snapshot & { head: HeadState, working: WorkingState }} Snapshot
 */

/**
 * Resolves a doc reference (id or path) to its Doc (NotFoundError, exit 4).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @returns {Promise<Doc>}
 */
export async function resolveDoc(ctx, ref) {
  if (ref && typeof ref === 'object' && 'id' in ref) return /** @type {Doc} */ (ref);
  if (typeof ref !== 'string' || !ref) throw new UsageError('a doc id or path is required');
  const doc = await ctx.store.requireDoc(ref);
  // A multi-file commit interrupted after its commit point (a killed `revise` or review submit) leaves its redo
  // journal: roll it forward before anyone reads the doc, or readers would take v(N-1) anchors as vN offsets.
  if (fs.existsSync(ctx.store.journalFile(doc.id))) {
    await ctx.store.withDocLock(doc.id, () => ctx.store.recoverDoc(doc.id));
    return (await ctx.store.getDoc(doc.id)) ?? doc;
  }
  return doc;
}

/**
 * Runs `fn(doc)` inside the doc's critical section with a freshly read doc.json.
 * @template T
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {(doc: Doc) => Promise<T>} fn
 * @param {{ ack?: boolean, recover?: boolean }} [opts] ack: acknowledge reviews delivered to ctx.agent
 * @returns {Promise<T>}
 */
export async function withDoc(ctx, ref, fn, { ack = false, recover = true } = {}) {
  const docId = (await resolveDoc(ctx, ref)).id;
  return ctx.store.withDocLock(docId, async () => {
    if (recover) await ctx.store.recoverDoc(docId);
    const doc = await ctx.store.getDoc(docId);
    if (!doc) throw new NotFoundError(`doc not found: ${docId}`, { details: { doc: docId } });
    if (ack) await ackDelivered(ctx, doc);
    return fn(doc);
  });
}

/**
 * Marks reviews delivered to ctx.agent but not yet acknowledged as acked (call inside the doc lock).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {Promise<string[]>} acked review ids
 */
export async function ackDelivered(ctx, doc) {
  const at = ctx.now();
  /** @type {string[]} */
  const acked = [];
  for (const r of await ctx.store.listReviews(doc.id)) {
    if (!r.deliveredTo?.[ctx.agent] || r.ackedBy?.[ctx.agent]) continue;
    r.ackedBy = { ...(r.ackedBy ?? {}), [ctx.agent]: at };
    await ctx.store.saveReview(doc.id, r);
    acked.push(r.id);
  }
  for (const id of acked) await emit(ctx, doc.id, SSE.REVIEW_ACKED, { review: id, agent: ctx.agent });
  return acked;
}

/** @param {Ctx} ctx @returns {Actor} */
export function agentActor(ctx) {
  return { kind: 'agent', name: ctx.agent };
}

/**
 * @param {Ctx} ctx
 * @param {string | null | undefined} [by]
 * @returns {Actor}
 */
export function humanActor(ctx, by) {
  return { kind: 'human', name: (by && String(by).trim()) || ctx.reviewer };
}

/**
 * Appends a store event (SSE name) for the doc.
 * @param {Ctx} ctx
 * @param {string} docId
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<number>}
 */
export function emit(ctx, docId, type, payload = {}) {
  return ctx.store.appendEvent(docId, { type, ...payload });
}

/**
 * The head version (NotFoundError when the doc has no version yet).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {Promise<HeadState>}
 */
export async function readHead(ctx, doc) {
  if (!doc.head) throw new NotFoundError(`${doc.id} has no recorded version yet`, { details: { doc: doc.id } });
  const { manifest, source } = await ctx.store.readVersion(doc.id, doc.head);
  return { v: doc.head, manifest, source };
}

/**
 * The working copy; a missing file yields `missing: true` and the head text (so readers can still work).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {HeadState | null} head
 * @returns {Promise<WorkingState>}
 */
export async function readWorkingState(ctx, doc, head) {
  try {
    const w = await ctx.store.readWorking(doc);
    return { text: w.text, sha256: w.sha256, buf: w.buf, missing: false, dirty: head ? w.sha256 !== head.manifest.sha256 : true };
  } catch (err) {
    if (err instanceof NotFoundError) return { text: head?.source ?? '', sha256: null, buf: null, missing: true, dirty: true };
    throw err;
  }
}

/**
 * The working copy, failing with NotFoundError when it is missing.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {HeadState} head
 * @returns {Promise<WorkingState & { sha256: string, buf: Buffer }>}
 */
export async function requireWorking(ctx, doc, head) {
  const w = await readWorkingState(ctx, doc, head);
  if (w.missing) throw new NotFoundError(`working copy is missing: ${doc.path}`, { details: { path: doc.path } });
  return /** @type {any} */ (w);
}

/**
 * Local assets (images, ...) whose working-copy bytes differ from the head manifest. Used when the spec text itself
 * is unchanged: a replaced image is still a change worth recording (BUILD_AMENDMENTS 4.5).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {HeadState} head
 * @returns {Promise<string[]>} changed workspace-relative paths, sorted
 */
export async function changedWorkingAssets(ctx, doc, head) {
  if (isSnapshot(doc)) return [];
  const recorded = head.manifest.assets ?? {};
  const render = await ctx.render(doc, head.v);
  const rels = [...new Set([...render.assets, ...Object.keys(recorded)])];
  if (!rels.length) return [];
  return changedAssets(recorded, await hashWorkingAssets(ctx.root, rels, ctx.config.assets.maxBytes));
}

/**
 * Refuses an agent edit of a snapshot doc (it has no working file) with what to do instead (RefusedError, exit 3).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string} what 'apply suggestions to', 'edit', 'revert'...
 */
export function refuseSnapshot(ctx, doc, what) {
  if (!isSnapshot(doc)) return;
  throw new RefusedError(snapshotRefusal(doc, what, docRefFor(doc.id, ctx.root)), { details: { doc: doc.id, kind: 'snapshot' } });
}

/**
 * Everything most read paths need, read once.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ includeUncommitted?: boolean }} [opts]
 * @returns {Promise<Snapshot>}
 */
export async function loadSnapshot(ctx, doc, { includeUncommitted = false } = {}) {
  const head = await readHead(ctx, doc);
  const working = await readWorkingState(ctx, doc, head);
  const [threads, locks, reviews] = await Promise.all([
    ctx.store.listThreads(doc.id, { includeUncommitted }),
    ctx.store.listLocks(doc.id),
    ctx.store.listReviews(doc.id),
  ]);
  const mapper = preciseMapper(head.source, working.missing ? head.source : working.text);
  return { doc, head, working, mapper, threads, locks, reviews };
}

/**
 * Memoised loader of version sources and renders: (v) => { source, render }.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {(v: number) => Promise<{ source: string, render: RenderResult, manifest: VersionManifest }>}
 */
export function versionLoader(ctx, doc) {
  /** @type {Map<number, Promise<{ source: string, render: RenderResult, manifest: VersionManifest }>>} */
  const cache = new Map();
  return (v) => {
    let p = cache.get(v);
    if (!p) {
      p = (async () => {
        const { source, manifest } = await ctx.store.readVersion(doc.id, v);
        return { source, manifest, render: await ctx.render(doc, v) };
      })();
      cache.set(v, p);
    }
    return p;
  };
}

/**
 * ISO time of the newest packet delivered to `agent` (null when none).
 * @param {Review[]} reviews
 * @param {string} agent
 * @returns {string | null}
 */
export function lastDeliveredAt(reviews, agent) {
  let best = null;
  for (const r of reviews) {
    const at = r.deliveredTo?.[agent];
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

/**
 * Reviews not yet delivered to `agent`, oldest first.
 * @param {Review[]} reviews
 * @param {string} agent
 * @returns {Review[]}
 */
export function undeliveredReviews(reviews, agent) {
  return reviews.filter((r) => !r.deliveredTo?.[agent]).sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
}

/**
 * @param {Ctx} ctx
 * @param {string} docId
 * @param {string} tid
 * @returns {Promise<Thread>}
 */
export async function requireThread(ctx, docId, tid) {
  const t = await ctx.store.getThread(docId, tid);
  if (!t) throw new NotFoundError(`thread ${tid} not found in ${docId}`, { details: { doc: docId, thread: tid } });
  return t;
}

/**
 * Validates an enum-like input value.
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} what
 * @returns {T}
 */
export function oneOf(value, allowed, what) {
  if (typeof value === 'string' && /** @type {readonly string[]} */ (allowed).includes(value)) return /** @type {T} */ (value);
  throw new UsageError(`invalid ${what}: ${JSON.stringify(value)} (expected ${allowed.join(' | ')})`);
}

/**
 * Parses a version argument: 3, '3', 'v3' (and 'live' when allowed).
 * @param {unknown} v
 * @param {{ allowLive?: boolean, fallback?: number }} [opts]
 * @returns {number | 'live'}
 */
export function parseVersionArg(v, { allowLive = false, fallback } = {}) {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new UsageError('a version is required');
  }
  if (allowLive && String(v).toLowerCase() === 'live') return 'live';
  const m = /^v?(\d+)$/i.exec(String(v).trim());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`invalid version: ${JSON.stringify(v)}`);
  return n;
}
