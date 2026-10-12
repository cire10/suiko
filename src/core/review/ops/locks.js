// @ts-check
// Locks ("Mark agreed", design 5.3 locks/LN.json, 8.4; BUILD_AMENDMENTS 4.4). Created immediately (not batched
// with the review). A lock records the exact source slice it agreed on (`text`, used by `revert --lock`) and is
// re-anchored at every version like a thread. `revise` refuses a version in which an active lock's text is not
// intact (unless --break-lock / --force).
//   addLock(ctx, doc, { version, capture, note, by }) -> Lock
//   removeLock(ctx, doc, lockId, { by })              -> { ok, lock } (kept as history, inactive)
//   relock(ctx, doc, lockId, { by })                  -> Lock (active again; agrees on the current head text)

import { SSE } from '../../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../../store/errors.js';
import { isCode } from '../../store/snapshot.js';
import { sha256 } from '../../util/hash.js';
import { anchorForCapture, envOf, forwardAnchor } from '../anchoring.js';
import { anchorAt } from '../threadstate.js';
import { emit, humanActor, parseVersionArg, versionLoader, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Lock} Lock
 */

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ version?: number | string, capture: any, note?: string, by?: string }} input
 * @returns {Promise<Lock>}
 */
export async function addLock(ctx, ref, input) {
  return withDoc(ctx, ref, async (doc) => {
    refuseCodeLock(doc);
    if (!input?.capture) throw new UsageError('a capture is required to lock a region');
    if (input.capture.kind === 'doc') throw new UsageError('lock a section or a passage, not the whole doc');
    const v = /** @type {number} */ (parseVersionArg(input.version, { fallback: doc.head }));
    const load = versionLoader(ctx, doc);
    const { source, render, manifest } = await load(v);
    const env = envOf(doc, ctx.config);
    const anchor = anchorForCapture({ version: v, capture: input.capture, source, render, env, assets: manifest.assets ?? null });
    const anchors = v < doc.head ? await forwardAnchor(anchor, doc.head, load, env) : { [String(v)]: anchor };
    const headAnchor = anchors[String(doc.head)];
    const at = ctx.now();
    /** @type {Lock} */
    const lock = {
      schema: 1,
      id: ctx.store.nextId(doc, 'lock'),
      active: true,
      note: input.note ? String(input.note) : 'Agreed',
      createdIn: v,
      by: humanActor(ctx, input.by),
      anchors,
      text: headAnchor.src.text,
      textSha256: sha256(headAnchor.src.text),
      breaks: [],
      createdAt: at,
    };
    await ctx.store.saveDoc(doc);
    await ctx.store.saveLock(doc.id, lock);
    await emit(ctx, doc.id, SSE.LOCK_CHANGED, { lock: lock.id, active: true });
    return lock;
  });
}

/**
 * "Unlock": deactivates a lock (the file stays as history).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} lockId
 * @param {{ by?: string }} [opts]
 * @returns {Promise<{ ok: true, lock: Lock }>}
 */
export async function removeLock(ctx, ref, lockId, { by } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const lock = await requireLock(ctx, doc.id, lockId);
    if (lock.active) {
      lock.active = false;
      /** @type {any} */ (lock).removed = { by: humanActor(ctx, by).name, at: ctx.now(), version: doc.head };
      await ctx.store.saveLock(doc.id, lock);
      await emit(ctx, doc.id, SSE.LOCK_CHANGED, { lock: lock.id, active: false });
    }
    return { ok: true, lock };
  });
}

/**
 * Re-activates a lock (after a break or an unlock); the agreed text becomes the lock's current head text.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} lockId
 * @param {{ by?: string }} [opts]
 * @returns {Promise<Lock>}
 */
export async function relock(ctx, ref, lockId, { by } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    refuseCodeLock(doc);
    const lock = await requireLock(ctx, doc.id, lockId);
    const a = anchorAt(lock, doc.head);
    if (!a || a.state === 'orphaned') throw new UsageError(`lock ${lockId} lost its place; create a new lock instead`);
    lock.active = true;
    lock.text = a.src.text;
    lock.textSha256 = sha256(a.src.text);
    delete (/** @type {any} */ (lock).removed);
    /** @type {any} */ (lock).relocked = { by: humanActor(ctx, by).name, at: ctx.now(), version: doc.head };
    await ctx.store.saveLock(doc.id, lock);
    await emit(ctx, doc.id, SSE.LOCK_CHANGED, { lock: lock.id, active: true });
    return lock;
  });
}

/**
 * @param {Ctx} ctx
 * @param {string} docId
 * @param {string} lockId
 * @returns {Promise<Lock>}
 */
async function requireLock(ctx, docId, lockId) {
  const lock = await ctx.store.getLock(docId, lockId);
  if (!lock) throw new NotFoundError(`lock ${lockId} not found in ${docId}`, { details: { doc: docId, lock: lockId } });
  return lock;
}

/**
 * Code reviews have no locks (refused before any render or capture).
 * @param {Doc} doc
 */
function refuseCodeLock(doc) {
  if (isCode(doc)) throw new RefusedError('code reviews have no locks', { details: { doc: doc.id, kind: 'code' } });
}
