// @ts-check
// Reviewer drafts and capture resolution (design 7.2, 10.2, 11.4; BUILD_AMENDMENTS 3.3):
//   resolveCapture(ctx, doc, { version, capture })      -> { anchor, preview: { label, lines, section, src, text } }
//   saveDraft(ctx, doc, item, { source? })               -> DraftItem (id allocated, anchor resolved); `source`
//                                                           ('snip' for `specreview snip`) rides on the
//                                                           drafts.changed event so the UI can announce the draft
//   updateDraft(ctx, doc, draftId, patch)                -> DraftItem
//   deleteDraft(ctx, doc, draftId)                       -> { ok, deleted }
//   listDrafts(ctx, doc)                                 -> Drafts
// Drafts live in the runtime dir (SPECREVIEW_HOME); they become threads, replies and resolutions on submitReview.
// Comments are allowed only on recorded versions (design C19), never on the live working copy.
// Draft item kinds: 'thread' {type, severity, anchor | capture(+version), body, suggestion?, attachments?},
// 'reply' {thread, body, reopen?}, 'resolve' {thread, decision?}.

import { SEVERITIES, SSE, THREAD_TYPES } from '../../../shared/protocol.js';
import { NotFoundError, UsageError } from '../../store/errors.js';
import { lineIndex } from '../../text/index.js';
import { isCode } from '../../store/snapshot.js';
import { kindOf } from '../kinds.js';
import { codeSuggestionFor } from '../../code/capture.js';
import { emit, oneOf, parseVersionArg, requireThread, resolveDoc, withDoc } from './common.js';

export { preview } from '../kinds.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../../shared/types.js').Capture} Capture
 * @typedef {import('../../../shared/types.js').DraftItem} DraftItem
 * @typedef {import('../../../shared/types.js').Suggestion} Suggestion
 */

const REVIEWER_TYPES = THREAD_TYPES.filter((t) => t !== 'agent-question');

/**
 * Resolves a guest capture against a recorded version (default: head), through the doc kind's adapter (kinds.js):
 * spec captures (text, element, cell, section, source, snip, doc) for spec and snapshot docs; line / file / doc
 * captures for code docs.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ version?: number | string, capture: Capture, widen?: boolean }} input widen: "Widen to block"
 * @returns {Promise<{ anchor: Anchor, preview: { label: string, lines: [number, number] | null, section: string[], src: string, text: string } }>}
 */
export async function resolveCapture(ctx, ref, { version, capture, widen = false }) {
  const doc = await resolveDoc(ctx, ref);
  const v = /** @type {number} */ (parseVersionArg(version, { fallback: doc.head }));
  if (!capture || typeof capture !== 'object') throw new UsageError('a capture is required');
  return kindOf(doc).capture(ctx, doc, capture, v, { widen });
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @returns {Promise<import('../../../shared/types.js').Drafts>}
 */
export async function listDrafts(ctx, ref) {
  const doc = await resolveDoc(ctx, ref);
  return ctx.store.getDrafts(doc.id);
}

/**
 * Creates a draft. A thread draft may carry a resolved `anchor` or a `capture` (+ `version`, default head).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {any} item DraftItem without id
 * @param {{ source?: string | null }} [opts] source: where the draft came from, added to the drafts.changed event
 *   ({draft, source: 'snip'} for `specreview snip`)
 * @returns {Promise<DraftItem>}
 */
export async function saveDraft(ctx, ref, item, { source = null } = {}) {
  return withDoc(ctx, ref, async (doc) => {
    const draft = await normalizeDraft(ctx, doc, item ?? {}, null);
    draft.id = ctx.store.nextId(doc, 'draft');
    await ctx.store.saveDoc(doc);
    const drafts = await ctx.store.getDrafts(doc.id);
    drafts.items.push(draft);
    await ctx.store.saveDrafts(doc.id, drafts);
    await emit(ctx, doc.id, SSE.DRAFTS_CHANGED, source ? { draft: draft.id, source: String(source) } : { draft: draft.id });
    return draft;
  });
}

/**
 * Patches a draft (body, severity, type, suggestion, attachments, reopen, decision, anchor/capture).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} draftId
 * @param {any} patch
 * @returns {Promise<DraftItem>}
 */
export async function updateDraft(ctx, ref, draftId, patch) {
  return withDoc(ctx, ref, async (doc) => {
    const drafts = await ctx.store.getDrafts(doc.id);
    const i = drafts.items.findIndex((d) => d.id === draftId);
    if (i < 0) throw new NotFoundError(`draft ${draftId} not found in ${doc.id}`, { details: { doc: doc.id, draft: draftId } });
    const cur = drafts.items[i];
    const { id: _id, kind: _kind, ...rest } = patch ?? {};
    const merged = { ...cur, ...rest };
    if (rest.capture) delete merged.anchor;
    const draft = await normalizeDraft(ctx, doc, merged, cur);
    draft.id = cur.id;
    drafts.items[i] = draft;
    await ctx.store.saveDrafts(doc.id, drafts);
    await emit(ctx, doc.id, SSE.DRAFTS_CHANGED, { draft: draft.id });
    return draft;
  });
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} draftId
 * @returns {Promise<{ ok: true, deleted: boolean }>}
 */
export async function deleteDraft(ctx, ref, draftId) {
  return withDoc(ctx, ref, async (doc) => {
    const drafts = await ctx.store.getDrafts(doc.id);
    const before = drafts.items.length;
    drafts.items = drafts.items.filter((d) => d.id !== draftId);
    const deleted = drafts.items.length !== before;
    if (deleted) {
      await ctx.store.saveDrafts(doc.id, drafts);
      await emit(ctx, doc.id, SSE.DRAFTS_CHANGED, { draft: draftId, deleted: true });
    }
    return { ok: true, deleted };
  });
}

/**
 * Validates a draft and fills derived fields (anchor from capture, suggestion slice).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {any} item
 * @param {DraftItem | null} prev
 * @returns {Promise<any>}
 */
async function normalizeDraft(ctx, doc, item, prev) {
  const kind = item.kind ?? prev?.kind ?? 'thread';
  const updatedAt = ctx.now();
  if (kind === 'reply') {
    await requireThread(ctx, doc.id, item.thread);
    const body = String(item.body ?? '');
    return { id: '', kind, thread: item.thread, body, reopen: Boolean(item.reopen), updatedAt };
  }
  if (kind === 'resolve') {
    await requireThread(ctx, doc.id, item.thread);
    const out = { id: '', kind, thread: item.thread, updatedAt };
    if (item.decision) /** @type {any} */ (out).decision = String(item.decision);
    return out;
  }
  if (kind !== 'thread') throw new UsageError(`invalid draft kind: ${JSON.stringify(kind)} (expected thread | reply | resolve)`);

  const type = oneOf(item.type ?? (item.suggestion ? 'suggestion' : 'comment'), REVIEWER_TYPES, 'thread type');
  const severity = oneOf(item.severity ?? 'normal', SEVERITIES, 'severity');
  /** @type {Anchor | null} */
  let anchor = item.anchor ?? null;
  if (!anchor) {
    if (!item.capture) throw new UsageError('a thread draft needs an anchor or a capture');
    const v = /** @type {number} */ (parseVersionArg(item.version, { fallback: doc.head }));
    anchor = (await resolveCapture(ctx, doc, { version: v, capture: item.capture })).anchor;
  }
  if (!anchor || typeof anchor.v !== 'number' || anchor.v < 1 || anchor.v > doc.head) {
    throw new UsageError('the draft anchor must refer to a recorded version');
  }
  const attachments = Array.isArray(item.attachments) ? item.attachments.map(String) : [];
  /** @type {Suggestion | null} */
  let suggestion = null;
  if (type === 'suggestion') {
    if (!item.suggestion || typeof item.suggestion.new !== 'string') throw new UsageError('a suggestion draft needs suggestion.new');
    suggestion = await suggestionFor(ctx, doc, anchor, item.suggestion);
  }
  const out = { id: '', kind, type, severity, anchor, body: String(item.body ?? ''), suggestion, attachments, updatedAt, version: anchor.v };
  return out;
}

/**
 * Builds the stored suggestion from the anchor: mode 'text' replaces the exact anchored slice, 'source' replaces
 * the anchor's whole lines. The anchored source is authoritative for `old`.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Anchor} anchor
 * @param {{ mode?: string, new: string }} input
 * @returns {Promise<Suggestion>}
 */
export async function suggestionFor(ctx, doc, anchor, input) {
  // code docs: whole lines of the anchored repo file (new side), built by the code engine
  // (one trailing line break is dropped, as `apply` does, so the packet shows what will be written)
  if (isCode(doc)) return { ...(await codeSuggestionFor(ctx, doc, anchor, anchor.v)), new: String(input.new).replace(/\r?\n$/, ''), status: 'pending', appliedIn: null };
  const mode = input.mode === 'source' ? 'source' : 'text';
  const { source } = await ctx.store.readVersion(doc.id, anchor.v);
  let start = anchor.src.start;
  let end = anchor.src.end;
  if (mode === 'source') {
    const li = lineIndex(source);
    start = li.startOf(anchor.src.startLine);
    end = li.endOf(anchor.src.endLine);
  }
  const li = lineIndex(source);
  return {
    mode,
    version: anchor.v,
    start,
    end,
    startLine: li.lineOf(start),
    endLine: end > start ? li.lineOf(end - 1) : li.lineOf(start),
    old: source.slice(start, end),
    new: String(input.new),
    status: 'pending',
    appliedIn: null,
  };
}
