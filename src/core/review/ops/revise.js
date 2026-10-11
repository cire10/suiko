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
import { anchorAt, isActionable } from '../threadstate.js';
import { resolveInPlace } from './submit.js';
import { addAgentReply } from './threads.js';
import { commitRecord, prepareRecord, reportHunks } from './record.js';
import { agentActor, changedWorkingAssets, emit, humanActor, readHead, requireThread, requireWorking, respondsToOf, withDoc } from './common.js';
import { docRefFor, isCode, isSnapshot, reviseHint, snapshotNoun } from '../../store/snapshot.js';
import { recordCodeRound, reviseCode } from '../../code/round.js';
import { applyCodeSuggestions } from '../../code/apply.js';
import { decodeText, encodeText } from '../../util/stable-read.js';
import { sha256 } from '../../util/hash.js';

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
 * Records a revision. A file doc records its working copy. A snapshot doc (see store/snapshot.js) has no working
 * file: the new version's bytes come from `snapshot.source` (`revise --source`, the plan gate, re-piped text), its
 * guards only warn (their errors are stored as warnings, never refuse), and the manifest keeps `snapshot.origin`.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {any} input ReviseInput plus flags { dryRun, force, allowRewrite, breakLocks }
 * @param {{ source: string | Buffer, origin?: Record<string, unknown> | null, autoAddress?: boolean } | null} [snapshot]
 *   autoAddress: every actionable thread (without a reply in `input`) that a hunk of the new version is linked to gets
 *   the agent reply "Changed in vN." (addressed): for snapshot sources with no reply channel (the plan gate)
 */
export async function revise(ctx, ref, input, snapshot = null) {
  const p = parseReviseInput(input);
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      // a code doc records a round of its repo files (code engine); --source is for snapshot docs only
      if (isCode(doc)) {
        if (snapshot) throw new UsageError(`${doc.id} is a code review: edit the files, then run revise without --source`, { details: { doc: doc.id, kind: 'code' } });
        return reviseCode(ctx, doc, p);
      }
      const snap = isSnapshot(doc);
      if (snap && !snapshot) {
        throw new UsageError(`${doc.id} is ${snapshotNoun(doc)}: there is no working file to record. To revise it, ${reviseHint(doc, docRefFor(doc.id, ctx.root))}.`, {
          details: { doc: doc.id, kind: 'snapshot' },
        });
      }
      if (!snap && snapshot) {
        throw new UsageError(`${doc.id} tracks the file ${doc.path}: edit the file, then run revise without --source`, { details: { doc: doc.id } });
      }
      for (const tid of Object.keys(p.threads)) await requireThread(ctx, doc.id, tid);
      for (const lid of Object.keys(p.breakLocks)) {
        if (!(await ctx.store.getLock(doc.id, lid))) throw new UsageError(`--break-lock ${lid}: no such lock`);
      }
      const head = await readHead(ctx, doc);
      const working = snapshot ? snapshotWorking(head, snapshot.source) : await requireWorking(ctx, doc, head);
      const replies = Object.entries(p.threads).map(([thread, r]) => ({ thread, status: r.status }));
      const base = {
        doc: doc.id,
        ref: docRefFor(doc.id, ctx.root),
        snapshot: snap,
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

      const prepare = () =>
        prepareRecord(ctx, doc, {
          head,
          working,
          replies: p.threads,
          other: p.other,
          guards: true,
          flags: { force: p.force, allowRewrite: p.allowRewrite, breakLocks: p.breakLocks },
        });
      let prep = await prepare();
      if (snap && snapshot?.autoAddress) {
        const auto = autoReplies(prep, p.threads, head.v + 1);
        if (Object.keys(auto).length) {
          // the replies change the guards' view (answered threads), not the attribution: those threads were
          // actionable, so already linkable
          p.threads = { ...p.threads, ...auto };
          prep = await prepare();
          base.replies = Object.entries(p.threads).map(([thread, r]) => ({ thread, status: r.status }));
        }
      }
      const g = /** @type {import('../guards.js').GuardResult} */ (prep.guards);
      if (snap) warnOnly(g);
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
        capturedBy: snap ? 'snapshot' : 'revise',
        respondsTo,
        replies: p.threads,
        breakLocks: p.breakLocks,
        manifestExtra: snap ? { origin: snapshot?.origin ?? /** @type {any} */ (doc).origin ?? null } : {},
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
 * Replies for the actionable threads a hunk of the new version is linked to (and that have no reply yet).
 * @param {import('./record.js').Prepared} prep
 * @param {Record<string, unknown>} replies
 * @param {number} v the new version
 * @returns {Record<string, { status: string, reply: string }>}
 */
function autoReplies(prep, replies, v) {
  /** @type {Record<string, { status: string, reply: string }>} */
  const out = {};
  for (const t of prep.threads) {
    if (replies[t.id] || !isActionable(t) || !(prep.attribution.threadLinks[t.id] ?? []).length) continue;
    out[t.id] = { status: 'addressed', reply: `Changed in v${v}.` };
  }
  return out;
}

/**
 * The "working copy" of a snapshot revision: the given bytes (a string is UTF-8), compared with head. Whether the
 * text ends with a newline follows head: the new text usually comes from a file the agent wrote or from `show`
 * (which ends its output with a newline), and a final-newline-only difference must not become a hunk (or turn a
 * replies-only round into a new version).
 * @param {import('./common.js').HeadState} head
 * @param {string | Buffer} source
 * @returns {import('./common.js').WorkingState & { sha256: string, buf: Buffer }}
 */
function snapshotWorking(head, source) {
  let buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source ?? ''), 'utf8');
  if (!buf.length) throw new UsageError('the new version is empty');
  const decoded = decodeText(buf);
  let text = decoded.text;
  if (!text.trim()) throw new UsageError('the new version is empty');
  const headNl = /\n$/.test(head.source);
  if (headNl !== /\n$/.test(text)) {
    text = headNl ? `${text}${eolOf(head.source)}` : text.replace(/\r?\n$/, '');
    buf = encodeText(text, decoded.encoding);
  }
  const hash = sha256(buf);
  return { text, sha256: hash, buf, missing: false, dirty: hash !== head.manifest.sha256 };
}

/**
 * The snapshot guard profile: the guards run and report, but never refuse. Their errors become warnings (stored on
 * the manifest): a snapshot records what the agent produced, whatever it is; the reviewer judges it in the UI.
 * @param {import('../guards.js').GuardResult} g mutated
 */
function warnOnly(g) {
  g.warnings = [...g.errors, ...g.warnings];
  g.errors = [];
  g.refused = false;
  g.forced = false;
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
    if (isCode(doc)) {
      // "Re-snapshot": a round of the working tree recorded by the reviewer
      const res = await recordCodeRound(ctx, doc, { author: humanActor(ctx, by), capturedBy: 'ui-record' });
      if ('nothing' in res) throw new RefusedError(`the working tree matches v${res.v}; nothing to record`);
      return res.manifest;
    }
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
    if (isCode(doc)) return applyCodeSuggestionAsReviewer(ctx, doc, t, humanActor(ctx, by));
    if (isSnapshot(doc)) throw new RefusedError(`${doc.id} is a snapshot, not a file: its suggestions are applied by the agent when it revises (send the review)`);
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

/**
 * "Apply now" on a code doc: the code engine writes the suggestion into the repo file, then a 'ui-apply' round
 * records it, and the thread is resolved.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {import('../../../shared/types.js').Thread} t
 * @param {import('../../../shared/types.js').Actor} actor
 * @returns {Promise<VersionManifest>}
 */
async function applyCodeSuggestionAsReviewer(ctx, doc, t, actor) {
  if (t.suggestion?.status === 'applied') throw new RefusedError(`${t.id} was already applied in v${t.suggestion.appliedIn}`);
  const r = await applyCodeSuggestions(ctx, doc, [t.id], { dryRun: false, actor });
  const conflict = r.conflicts.find((c) => c.id === t.id);
  if (conflict) throw new RefusedError(`conflict ${t.id}: ${conflict.reason}`);
  const res = await recordCodeRound(ctx, doc, { author: actor, capturedBy: 'ui-apply' });
  if ('nothing' in res) throw new RefusedError(`applying ${t.id} changed nothing; nothing to record`);
  const after = await ctx.store.getThread(doc.id, t.id);
  if (after && after.status !== 'resolved') {
    const fresh = (await ctx.store.getDoc(doc.id)) ?? doc;
    resolveInPlace(ctx, fresh, after, { at: ctx.now(), head: res.manifest.v });
    /** @type {any} */ (after).resolvedBy = actor.name;
    if (after.decision) await ctx.store.saveDoc(fresh);
    await ctx.store.saveThread(doc.id, after);
    await emit(ctx, doc.id, SSE.THREAD_UPDATED, { thread: t.id, status: after.status });
  }
  return res.manifest;
}
