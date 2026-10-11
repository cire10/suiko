// @ts-check
// Pure rules about thread state shared by packets, guards, status and the UI state (design 9.3):
// - A thread is ACTIONABLE (the agent must act) when its status is `open`, or when its newest comment is the
//   reviewer's and comes after the newest agent comment and it is not `resolved`.
// - `why` labels an actionable thread in a packet: `new` (the agent has not received it before), `reopened`,
//   `answer` (the reviewer replied to the agent's needs_input), `reply` (a reviewer reply on an addressed,
//   answered or declined thread) or `open` (still open from an earlier packet).
// - AWAITING REVIEWER: not actionable and not resolved (the agent replied; the reviewer has to verify).
// - The packet conversation shows the last agent reply and every reviewer comment after it; older comments are
//   collapsed into a count. Comments without content (an empty body, e.g. a suggestion submitted without a
//   comment) are left out everywhere they are printed.

/**
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Comment} Comment
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {'new' | 'reopened' | 'reply' | 'answer' | 'open'} Why
 */

/**
 * @param {Thread} thread
 * @returns {{ lastAgent: number, lastHuman: number }} indexes into thread.comments (-1 when none)
 */
export function lastIndexes(thread) {
  let lastAgent = -1;
  let lastHuman = -1;
  (thread.comments ?? []).forEach((c, i) => {
    if (c?.by?.kind === 'agent') lastAgent = i;
    else lastHuman = i;
  });
  return { lastAgent, lastHuman };
}

/**
 * @param {Thread} thread
 * @returns {boolean}
 */
export function isActionable(thread) {
  if (!thread || thread.status === 'resolved') return false;
  if (thread.status === 'open') return true;
  const { lastAgent, lastHuman } = lastIndexes(thread);
  return lastHuman > lastAgent;
}

/**
 * @param {Thread} thread
 * @returns {boolean}
 */
export function isAwaitingReviewer(thread) {
  return Boolean(thread) && thread.status !== 'resolved' && !isActionable(thread);
}

/**
 * Why an actionable thread is in a packet.
 * @param {Thread} thread
 * @param {{ deliveredBefore: (reviewId: string | null) => boolean, reopenedIn?: Set<string> }} ctx
 *   deliveredBefore(rv): whether review `rv` reached the agent before this packet; reopenedIn: ids of threads
 *   reopened by the reviews being delivered
 * @returns {Why | null} null when not actionable
 */
export function whyOf(thread, ctx) {
  if (!isActionable(thread)) return null;
  const { lastAgent, lastHuman } = lastIndexes(thread);
  if (lastAgent < 0) {
    return thread.review && !ctx.deliveredBefore(thread.review) ? 'new' : 'open';
  }
  if (lastHuman > lastAgent) {
    const agentStatus = thread.comments[lastAgent]?.status;
    if (ctx.reopenedIn?.has(thread.id)) return 'reopened';
    if (agentStatus === 'needs_input') return 'answer';
    if (thread.status === 'open' && agentStatus && agentStatus !== 'needs_input') return 'reopened';
    return 'reply';
  }
  return 'open';
}

/**
 * Whether a comment has anything to show: a non-blank body, or (agent replies) a status. A suggestion thread created
 * without a comment carries an empty reviewer comment; packets, `show` and decisions.md leave such comments out.
 * @param {Partial<Comment> | null | undefined} c
 * @returns {boolean}
 */
export function hasContent(c) {
  if (!c) return false;
  if (String(c.body ?? '').trim()) return true;
  return c.by?.kind === 'agent' && Boolean(c.status);
}

/**
 * The comments a packet shows: the last agent reply and every reviewer comment after it (all comments when the
 * agent never replied), plus how many older comments were collapsed. Comments without content (see hasContent)
 * are neither shown nor counted.
 * @param {Thread} thread
 * @returns {{ shown: Comment[], earlier: number }}
 */
export function conversation(thread) {
  const comments = thread.comments ?? [];
  const { lastAgent } = lastIndexes(thread);
  const from = lastAgent < 0 ? 0 : lastAgent;
  return { shown: comments.slice(from).filter(hasContent), earlier: comments.slice(0, from).filter(hasContent).length };
}

/**
 * Latest anchor of a thread or lock at or before version `maxV` (the newest when maxV is omitted).
 * @param {{ anchors?: Record<string, Anchor> }} item
 * @param {number} [maxV]
 * @returns {Anchor | null}
 */
export function anchorAt(item, maxV = Infinity) {
  let best = -1;
  for (const k of Object.keys(item?.anchors ?? {})) {
    const v = Number(k);
    if (Number.isFinite(v) && v <= maxV && v > best) best = v;
  }
  return best >= 0 ? /** @type {Anchor} */ (item.anchors?.[String(best)]) : null;
}

/**
 * The anchor of the version the thread was created on (re-anchoring falls back to it).
 * @param {{ anchors?: Record<string, Anchor>, createdIn?: number }} item
 * @returns {Anchor | null}
 */
export function originalAnchor(item) {
  const first = item?.createdIn != null ? item.anchors?.[String(item.createdIn)] : null;
  if (first) return first;
  let best = Infinity;
  for (const k of Object.keys(item?.anchors ?? {})) {
    const v = Number(k);
    if (Number.isFinite(v) && v < best) best = v;
  }
  return Number.isFinite(best) ? /** @type {Anchor} */ (item.anchors?.[String(best)]) : null;
}

/**
 * Display number of an id: 't12' -> 12.
 * @param {string} id
 * @returns {number}
 */
export function idNumber(id) {
  const m = /(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Whether a thread's anchor is "outdated" for counts and UI states (text changed without a link, or orphaned).
 * @param {Anchor | null} anchor
 * @returns {boolean}
 */
export function isOutdated(anchor) {
  return anchor?.state === 'changed' || anchor?.state === 'orphaned';
}
