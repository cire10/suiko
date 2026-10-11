// @ts-check
// Feedback packets and delivery (design 3.6, 5.4 "Delivery", 9.3; BUILD_AMENDMENTS 2.4):
//   feedback(ctx, doc, { peek, includeDrafts, allOpen, write }) -> Packet
//     Same packet as `wait`, without blocking. Unless `peek`: acknowledges earlier deliveries (agent op), then
//     delivers the undelivered reviews. With `write(text, packet)`, delivery is recorded only after it resolves
//     (the CLI passes a stdout writer that awaits the flush); without it, the reviews are marked delivered on return.
//   deliverPacket(ctx, doc, opts)  (inside the doc lock) build -> write -> deliveredTo[agent] -> review.delivered
//   buildDocPacket(ctx, doc, opts) the packet without delivering anything

import { SSE } from '../../../shared/protocol.js';
import { buildPacket } from '../packet-data.js';
import { formatPacket } from '../packet.js';
import { emit, loadSnapshot, resolveDoc, undeliveredReviews, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../packet-data.js').Packet} Packet
 * @typedef {(text: string, packet: Packet) => Promise<void> | void} Writer formatted text + the packet object (--json)
 */

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ peek?: boolean, includeDrafts?: boolean, allOpen?: boolean, write?: Writer }} [opts]
 * @returns {Promise<Packet>}
 */
export async function feedback(ctx, ref, { peek = false, includeDrafts = false, allOpen = false, write } = {}) {
  if (peek) {
    const doc = await resolveDoc(ctx, ref);
    const { packet, text } = await buildDocPacket(ctx, doc, { includeDrafts, allOpen });
    if (write) await write(text, packet);
    return packet;
  }
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      const res = await deliverPacket(ctx, doc, { includeDrafts, allOpen, write });
      return /** @type {Packet} */ (res?.packet);
    },
    { ack: true },
  );
}

/**
 * Builds the packet for a doc (nothing is written).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ includeDrafts?: boolean, allOpen?: boolean }} [opts]
 * @returns {Promise<{ packet: Packet, text: string, deliver: import('../../../shared/types.js').Review[] }>}
 */
export async function buildDocPacket(ctx, doc, { includeDrafts = false, allOpen = false } = {}) {
  const snap = await loadSnapshot(ctx, doc);
  const deliver = undeliveredReviews(snap.reviews, ctx.agent);
  const drafts = includeDrafts ? (await ctx.store.getDrafts(doc.id)).items : null;
  const packet = buildPacket(snap, {
    agent: ctx.agent,
    deliver,
    attachmentPath: (rel) => ctx.store.attachmentPath(doc.id, rel),
    allOpen,
    drafts,
    config: ctx.config,
    root: ctx.root,
    cwd: ctx.cwd,
  });
  return { packet, text: formatPacket(packet), deliver };
}

/**
 * Builds, writes and marks delivered, in that order (call inside the doc lock).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ includeDrafts?: boolean, allOpen?: boolean, write?: Writer, onlyIfUndelivered?: boolean,
 *   isSuperseded?: () => Promise<number | null>, minVersion?: number }} [opts] `minVersion` (with onlyIfUndelivered):
 *   deliver only when an undelivered review is on that version or a later one (the older ones come along)
 * @returns {Promise<{ packet: Packet, text: string, delivered: string[] } | { superseded: number } | null>}
 *   null when onlyIfUndelivered and nothing is pending
 */
export async function deliverPacket(ctx, doc, { includeDrafts = false, allOpen = false, write, onlyIfUndelivered = false, isSuperseded, minVersion = 0 } = {}) {
  const { packet, text, deliver } = await buildDocPacket(ctx, doc, { includeDrafts, allOpen });
  if (onlyIfUndelivered && !deliver.some((r) => !minVersion || r.version >= minVersion)) return null;
  if (isSuperseded) {
    const by = await isSuperseded();
    if (by) return { superseded: by };
  }
  if (write) await write(text, packet);
  const at = ctx.now();
  for (const r of deliver) {
    r.deliveredTo = { ...(r.deliveredTo ?? {}), [ctx.agent]: at };
    await ctx.store.saveReview(doc.id, r);
  }
  for (const r of deliver) await emit(ctx, doc.id, SSE.REVIEW_DELIVERED, { review: r.id, agent: ctx.agent, at });
  return { packet, text, delivered: deliver.map((r) => r.id) };
}
