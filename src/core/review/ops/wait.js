// @ts-check
// Blocking wait for reviewer feedback (design 9.2 `wait`, C10; BUILD_AMENDMENTS 2.4):
//   waitForFeedback(ctx, { docIds, timeoutMs, allowDirty, requireAnswers, signal, onStart, write, pid, pollMs,
//                          heartbeatMs, minVersion })
//     -> { status: 'delivered' | 'timeout' | 'closed' | 'dirty' | 'unanswered' | 'superseded', packets, text, docId?,
//          threads?, by?, aborted? }
// 1. Refuses at once ('dirty') when a working copy differs from head, unless allowDirty; 'closed' when a doc's
//    session is closed. With requireAnswers (`suiko wait`; never the plan gate), also refuses ('unanswered', with
//    the threads) when every review of a doc reached this agent but a thread they handed over still waits on its
//    reply: the reviewer reads replies in Suiko, so an answer given only in the agent's chat never reaches them.
// 2. Registers a waiter per doc (or '_all' for every doc), which supersedes older waiters of the same agent;
//    heartbeats every heartbeatMs (10 s). A superseded waiter returns 'superseded' and never delivers.
// 3. Checks for undelivered reviews now and on every change: fs.watch on each doc's reviews/ directory and its
//    events file, plus a poll every pollMs (2 s) as the safety net.
// 4. Delivery happens under the doc lock: build packet -> await write(text) -> deliveredTo[agent] -> event. A
//    killed wait (write never resolved) therefore re-delivers next time.
// The waiter file is always removed on exit. `docIds` null / '*' = every doc of the workspace (`wait --all`),
// except gated snapshots (a Claude Code plan, store/snapshot.js isGated): their reviews are delivered only by the
// plan gate blocking on them, or by a wait that names the doc. In that mode virtual docs (snapshot and code) skip
// the dirty pre-check: a code doc is checked for unrecorded edits only by a wait that names it (its working state
// is the repo, kindOf(doc).workingState).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SSE } from '../../../shared/protocol.js';
import { NotFoundError } from '../../store/errors.js';
import { ALL_DOCS } from '../../store/store.js';
import { isGated, isVirtual } from '../../store/snapshot.js';
import { createLogger } from '../../util/log.js';
import { isActionable, lastIndexes } from '../threadstate.js';
import { deliverPacket } from './feedback.js';
import { readHead, readWorkingState, resolveDoc } from './common.js';

const log = createLogger('review:wait');

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../packet-data.js').Packet} Packet
 * @typedef {{ id: string, type: string, status: string, replied: boolean }} UnansweredThread
 * @typedef {{ status: 'delivered' | 'timeout' | 'closed' | 'dirty' | 'unanswered' | 'superseded', packets: Packet[],
 *   text: string, docId?: string, threads?: UnansweredThread[], by?: number, aborted?: boolean }} WaitResult
 */

/**
 * The threads a doc's delivered reviews handed to `agent` that still wait on its reply (actionable: open, or the
 * reviewer spoke last). `replied`: the agent's reply is the newest comment, so the thread is open only because that
 * reply set no status. Empty while any review has not reached the agent yet: the wait delivers it at once, together
 * with every thread that needs action.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string} agent
 * @returns {Promise<UnansweredThread[]>}
 */
export async function unansweredThreads(ctx, doc, agent) {
  const reviews = await ctx.store.listReviews(doc.id);
  if (!reviews.length || reviews.some((r) => !r.deliveredTo?.[agent])) return [];
  /** @type {Set<string>} */
  const handed = new Set();
  for (const r of reviews) {
    for (const id of r.newThreads ?? []) handed.add(id);
    for (const x of r.replies ?? []) handed.add(x.thread);
    for (const id of r.reopened ?? []) handed.add(id);
  }
  if (!handed.size) return [];
  return (await ctx.store.listThreads(doc.id))
    .filter((t) => handed.has(t.id) && isActionable(t))
    .map((t) => {
      const { lastAgent, lastHuman } = lastIndexes(t);
      return { id: t.id, type: t.type, status: t.status, replied: lastAgent > lastHuman };
    });
}

/**
 * @param {Ctx} ctx
 * @param {object} [opts]
 * @param {string[] | string | null} [opts.docIds] doc ids/paths; null or '*' = all docs
 * @param {number} [opts.timeoutMs] 0 / undefined = no timeout
 * @param {boolean} [opts.allowDirty]
 * @param {boolean} [opts.requireAnswers] refuse ('unanswered') while a thread handed to this agent has no reply
 * @param {AbortSignal} [opts.signal]
 * @param {(info: { docs: Array<{ id: string, head: number, path: string }>, agent: string, pid: number }) => void} [opts.onStart]
 * @param {(text: string, packet: Packet) => Promise<void> | void} [opts.write] called under the doc lock with the
 *   formatted packet and its object; the delivery is recorded only after it resolves
 * @param {number} [opts.pid] waiter pid (default process.pid)
 * @param {number} [opts.pollMs]
 * @param {number} [opts.heartbeatMs]
 * @param {number} [opts.minVersion] only a review on this version or later triggers a delivery (older undelivered
 *   reviews come along): the plan gate waits for a verdict on the plan it is gating, never an older one
 * @returns {Promise<WaitResult>}
 */
export async function waitForFeedback(ctx, opts = {}) {
  const { timeoutMs = 0, allowDirty = false, requireAnswers = false, signal, onStart, write, pid = process.pid, pollMs = 2000, heartbeatMs = 10000, minVersion = 0 } = opts;
  const all = opts.docIds == null || opts.docIds === '*' || (Array.isArray(opts.docIds) && opts.docIds.length === 0);
  const refs = all ? [] : Array.isArray(opts.docIds) ? opts.docIds : [/** @type {string} */ (opts.docIds)];
  const listDocs = async () => (all ? (await ctx.store.listDocs()).filter((d) => !isGated(d)) : Promise.all(refs.map((r) => resolveDoc(ctx, r))));

  const initial = await listDocs();
  if (!initial.length) throw new NotFoundError('no tracked docs to wait for (run suiko open <file> first)');
  for (const doc of initial) {
    if (doc.state === 'closed') return { status: 'closed', packets: [], text: '', docId: doc.id };
    if (!allowDirty && doc.head && !(all && isVirtual(doc))) {
      const head = await readHead(ctx, doc);
      const w = await readWorkingState(ctx, doc, head);
      if (w.dirty) return { status: 'dirty', packets: [], text: '', docId: doc.id };
    }
  }
  if (requireAnswers) {
    for (const doc of initial) {
      const threads = await unansweredThreads(ctx, doc, ctx.agent);
      if (threads.length) return { status: 'unanswered', packets: [], text: '', docId: doc.id, threads };
    }
  }

  const keys = all ? [ALL_DOCS] : [...new Set(initial.map((d) => d.id))];
  const handles = await Promise.all(keys.map((k) => ctx.store.registerWaiter(k, { agent: ctx.agent, pid })));
  /** @type {Map<string, number>} */
  const startSeq = new Map();
  for (const d of initial) startSeq.set(d.id, await ctx.store.lastSeq(d.id));
  onStart?.({ docs: initial.map((d) => ({ id: d.id, head: d.head, path: d.path })), agent: ctx.agent, pid });

  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();
  /** @type {(() => void) | null} */
  let wake = null;
  /** A change noticed while no sleep was pending: the next sleep returns at once. */
  let pokedEarly = false;
  const poke = () => {
    const w = wake;
    wake = null;
    if (w) w();
    else pokedEarly = true;
  };
  const watchDocs = async (/** @type {Doc[]} */ docs) => {
    for (const d of docs) {
      for (const dir of [ctx.store.reviewsDir(d.id), path.dirname(ctx.store.eventsFile(d.id))]) {
        try {
          await fsp.mkdir(dir, { recursive: true });
          const w = fs.watch(dir, { persistent: false }, poke);
          w.on('error', () => w.close());
          watchers.push(w);
        } catch (err) {
          log.debug(`cannot watch ${dir}; polling only`, err);
        }
      }
    }
  };
  await watchDocs(initial);

  const isSuperseded = async () => {
    for (const h of handles) {
      const by = await h.isSuperseded();
      if (by) return by;
    }
    return null;
  };
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let lastBeat = Date.now();
  /** @type {Set<string>} */
  const watched = new Set(initial.map((d) => d.id));

  try {
    for (;;) {
      if (signal?.aborted) return { status: 'timeout', packets: [], text: '', aborted: true };
      if (Date.now() - lastBeat >= heartbeatMs) {
        lastBeat = Date.now();
        for (const h of handles) {
          const by = await h.heartbeat();
          if (by) return { status: 'superseded', packets: [], text: '', by };
        }
      }
      const superseded = await isSuperseded();
      if (superseded) return { status: 'superseded', packets: [], text: '', by: superseded };

      const docs = await listDocs();
      const fresh = docs.filter((d) => !watched.has(d.id));
      if (fresh.length) {
        for (const d of fresh) {
          watched.add(d.id);
          startSeq.set(d.id, await ctx.store.lastSeq(d.id));
        }
        await watchDocs(fresh);
      }
      /** @type {Packet[]} */
      const packets = [];
      const texts = [];
      for (const doc of docs) {
        if (await isClosed(ctx, doc, startSeq.get(doc.id) ?? 0)) return { status: 'closed', packets: [], text: '', docId: doc.id };
        const pending = (await ctx.store.listReviews(doc.id)).some((r) => !r.deliveredTo?.[ctx.agent] && (!minVersion || r.version >= minVersion));
        if (!pending) continue;
        const res = await ctx.store.withDocLock(doc.id, async () => {
          const current = await ctx.store.getDoc(doc.id);
          return current ? deliverPacket(ctx, current, { write, onlyIfUndelivered: true, isSuperseded, minVersion }) : null;
        });
        if (!res) continue;
        if ('superseded' in res) return { status: 'superseded', packets, text: texts.join('\n'), by: res.superseded };
        packets.push(res.packet);
        texts.push(res.text);
      }
      if (packets.length) return { status: 'delivered', packets, text: texts.join('\n'), docId: packets[0].doc };

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout', packets: [], text: '' };
      if (pokedEarly) {
        pokedEarly = false;
        continue;
      }
      await new Promise((resolve) => {
        const delay = Math.max(1, Math.min(pollMs, remaining, heartbeatMs - (Date.now() - lastBeat)));
        const timer = setTimeout(() => {
          timers.delete(timer);
          poke();
        }, delay);
        timers.add(timer);
        const onAbort = () => poke();
        signal?.addEventListener('abort', onAbort, { once: true });
        wake = () => {
          clearTimeout(timer);
          timers.delete(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(undefined);
        };
        // Aborted between the check at the top of the loop and here: 'abort' will not fire again.
        if (signal?.aborted) poke();
      });
    }
  } finally {
    for (const w of watchers) w.close();
    for (const t of timers) clearTimeout(t);
    for (const h of handles) await h.remove().catch(() => {});
  }
}

/**
 * Whether the doc's session was closed (state, or a session.closed event since the wait started).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {number} sinceSeq
 */
async function isClosed(ctx, doc, sinceSeq) {
  if (doc.state === 'closed') return true;
  const events = await ctx.store.readEvents(doc.id, sinceSeq);
  return events.some((e) => e.type === SSE.SESSION_CLOSED);
}
