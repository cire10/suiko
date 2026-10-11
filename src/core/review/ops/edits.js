// @ts-check
// Deterministic working-copy edits by the agent (design 9.4; BUILD_AMENDMENTS 5):
//   applySuggestions(ctx, doc, tids, { dryRun })                       -> { applied, conflicts, skipped, dryRun }
//   taggedEdit(ctx, doc, { threads, oldString, newString, replaceAll, expectSha256 }) -> { threads, lines, count }
//   taggedEdits(ctx, doc, edits)  `edit --stdin` [{threads, old, new, all?}]  -> { edits: [{threads, lines, count}] }
//   revert(ctx, doc, { hunk } | { lock })                                -> { hunk|lock, lines, noop? }
// Every write is a compare-and-swap of the working copy (Store.writeWorking): on a concurrent change the op
// re-reads and recomputes, up to 3 attempts, then fails with ConflictError (exit 3). When the caller passes
// `expectSha256` (the hash it last read) a mismatch fails at once. Successful apply/edit/revert append tagged
// pending edits (attribution links the resulting hunks to the threads). Suggestions become `staged`.

import { SSE } from '../../../shared/protocol.js';
import { ConflictError, NotFoundError, RefusedError, UsageError } from '../../store/errors.js';
import { lineHunks } from '../../diff/index.js';
import { lineIndex } from '../../text/index.js';
import { effectivePendingLines } from '../attribution.js';
import { eolOf, lineWindow, locateSuggestion, matchEol, replaceExact, spliceText, suggestionTarget } from '../apply.js';
import { anchorAt } from '../threadstate.js';
import { preciseMapper } from '../workmap.js';
import { emit, readHead, refuseSnapshot, requireThread, requireWorking, withDoc } from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').PendingEdit} PendingEdit
 * @typedef {import('../apply.js').Spliced} Spliced
 */

const CAS_ATTEMPTS = 3;
/** Inserted text kept in a pending edit so attribution can re-find it after untracked edits (capped). */
const TAG_TEXT_MAX = 4000;

/**
 * @param {string | null | undefined} text
 * @returns {string | undefined}
 */
function tagText(text) {
  return typeof text === 'string' && text.trim() && text.length <= TAG_TEXT_MAX ? text : undefined;
}

/**
 * Runs `attempt()` (read, compute, CAS write) up to CAS_ATTEMPTS times while it throws ConflictError.
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {boolean} retry
 * @returns {Promise<T>}
 */
async function withCasRetry(attempt, retry) {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ConflictError) || !retry || i >= CAS_ATTEMPTS) throw err;
    }
  }
}

/**
 * Applies suggestions verbatim and stages them.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string[]} tids
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function applySuggestions(ctx, ref, tids, { dryRun = false } = {}) {
  if (!Array.isArray(tids) || !tids.length) throw new UsageError('apply: at least one thread id is required');
  return withDoc(
    ctx,
    ref,
    (doc) =>
      withCasRetry(async () => {
        refuseSnapshot(ctx, doc, 'apply suggestions to');
        const head = await readHead(ctx, doc);
        const working = await requireWorking(ctx, doc, head);
        const mapper = preciseMapper(head.source, working.text);
        const li = lineIndex(working.text);
        /** @type {Array<{ id: string, reason: string }>} */
        const conflicts = [];
        /** @type {Array<{ id: string, reason: string }>} */
        const skipped = [];
        /** @type {Array<{ t: Thread, expected: number, within: { start: number, end: number } }>} */
        const todo = [];
        /** @type {Thread[]} */
        const changedThreads = [];
        for (const tid of [...new Set(tids)]) {
          const t = await requireThread(ctx, doc.id, tid);
          const s = t.suggestion;
          if (!s) {
            skipped.push({ id: tid, reason: 'not a suggestion (edit it yourself, then reply)' });
            continue;
          }
          if (s.status === 'staged') {
            skipped.push({ id: tid, reason: 'already applied to the working copy (staged)' });
            continue;
          }
          if (s.status === 'applied') {
            skipped.push({ id: tid, reason: `already applied in v${s.appliedIn}` });
            continue;
          }
          const a = anchorAt(t, head.v);
          if (!a || a.state === 'orphaned') {
            conflicts.push({ id: tid, reason: 'its anchor was lost (orphaned); treat it as a normal comment' });
            if (s.status !== 'conflict') {
              s.status = 'conflict';
              changedThreads.push(t);
            }
            continue;
          }
          const { expected, window } = suggestionTarget(a, s, head.v);
          const m = mapper.mapRange(window.start, window.end);
          todo.push({ t, expected: mapper.map(expected, 'right'), within: lineWindow(working.text, m.start, m.end) });
        }

        // Bottom-up, so earlier offsets stay valid (a window reaching past a later splice is shifted by it).
        todo.sort((x, y) => y.expected - x.expected);
        let text = working.text;
        const eol = eolOf(working.text);
        /** @type {Array<{ t: Thread, splice: Spliced, how: string, insert: string }>} */
        const done = [];
        for (const [i, { t, expected, within }] of todo.entries()) {
          const s = /** @type {NonNullable<Thread['suggestion']>} */ (t.suggestion);
          const loc = locateSuggestion(text, s.old, expected, within);
          if (!loc) {
            conflicts.push({ id: t.id, reason: `expected text not found near L${li.lineOf(expected)}; treat as a normal comment` });
            if (s.status !== 'conflict') {
              s.status = 'conflict';
              changedThreads.push(t);
            }
            continue;
          }
          const insert = matchEol(s.new, eol);
          const splice = spliceText(text, loc.start, loc.end, insert);
          const delta = splice.end - loc.end;
          for (const later of todo.slice(i + 1)) if (later.within.end > loc.start) later.within.end = Math.max(later.within.start, later.within.end + delta);
          text = splice.text;
          done.push({ t, splice, how: loc.how, insert });
        }

        /** @type {PendingEdit[]} */
        const pending = done.map(({ t, splice, insert }) => ({ via: 'apply', threads: [t.id], oldLines: splice.oldLines, newLines: splice.newLines, newText: tagText(insert) }));
        const finalLines = effectivePendingLines(pending).map((e) => /** @type {[number, number]} */ (e.newLines));
        const applied = done.map((d, i) => ({ id: d.t.id, lines: finalLines[i], how: d.how })).sort((a, b) => a.lines[0] - b.lines[0]);
        if (dryRun) return { applied, conflicts, skipped, dryRun: true };

        if (done.length) {
          const res = await ctx.store.writeWorking(doc, text, { expectSha256: working.sha256 });
          for (const e of pending) await ctx.store.appendPendingEdit(doc.id, { ...e, beforeSha256: working.sha256, afterSha256: res.sha256 });
          for (const d of done) {
            /** @type {NonNullable<Thread['suggestion']>} */ (d.t.suggestion).status = 'staged';
            d.t.updatedAt = ctx.now();
            changedThreads.push(d.t);
          }
        }
        for (const t of changedThreads) await ctx.store.saveThread(doc.id, t);
        if (changedThreads.length) await emit(ctx, doc.id, SSE.THREAD_UPDATED, { threads: changedThreads.map((t) => t.id) });
        return { applied, conflicts, skipped, dryRun: false };
      }, true),
    { ack: true },
  );
}

/**
 * Thread-tagged exact replacement (Edit-tool semantics).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ threads: string[], oldString: string, newString: string, replaceAll?: boolean, expectSha256?: string }} input
 * @returns {Promise<{ threads: string[], lines: [number, number], count: number }>}
 */
export async function taggedEdit(ctx, ref, input) {
  const res = await taggedEdits(ctx, ref, [{ threads: input.threads, old: input.oldString, new: input.newString, all: input.replaceAll }], {
    expectSha256: input.expectSha256,
  });
  return res.edits[0];
}

/**
 * Batch of tagged edits applied in order, all or nothing (`edit --stdin`).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {Array<{ threads: string[] | string, old: string, new: string, all?: boolean }>} edits
 * @param {{ expectSha256?: string }} [opts]
 * @returns {Promise<{ edits: Array<{ threads: string[], lines: [number, number], count: number }> }>}
 */
export async function taggedEdits(ctx, ref, edits, { expectSha256 } = {}) {
  if (!Array.isArray(edits) || !edits.length) throw new UsageError('edit: at least one edit is required');
  const normalized = edits.map((e, i) => {
    const threads = (Array.isArray(e?.threads) ? e.threads : String(e?.threads ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean);
    if (!threads.length) throw new UsageError(`edit ${i + 1}: at least one thread id is required (--thread t1)`);
    if (typeof e.old !== 'string' || !e.old) throw new UsageError(`edit ${i + 1}: "old" must be a non-empty string`);
    if (typeof e.new !== 'string') throw new UsageError(`edit ${i + 1}: "new" must be a string`);
    if (e.old === e.new) throw new UsageError(`edit ${i + 1}: "old" and "new" are identical`);
    return { threads, old: e.old, new: e.new, all: Boolean(e.all) };
  });
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      refuseSnapshot(ctx, doc, 'edit');
      for (const e of normalized) for (const t of e.threads) await requireThread(ctx, doc.id, t);
      return withCasRetry(async () => {
        const head = await readHead(ctx, doc);
        const working = await requireWorking(ctx, doc, head);
        if (expectSha256 && expectSha256 !== working.sha256) {
          throw new ConflictError(`${doc.path} changed since it was read; re-read it and retry`, { details: { path: doc.path } });
        }
        let text = working.text;
        /** @type {PendingEdit[]} */
        const pending = [];
        /** @type {number[]} */
        const owner = [];
        /** @type {number[]} */
        const counts = [];
        // Line endings follow the file: on a CRLF file, '\n' in old/new strings means CRLF.
        const eol = eolOf(working.text);
        normalized.forEach((e, i) => {
          const neu = matchEol(e.new, eol);
          let r = replaceExact(text, e.old, neu, e.all);
          if (!r.ok && r.count === 0 && matchEol(e.old, eol) !== e.old) r = replaceExact(text, matchEol(e.old, eol), neu, e.all);
          if (!r.ok) {
            const where = normalized.length > 1 ? `edit ${i + 1}: ` : '';
            if (r.count === 0) throw new RefusedError(`${where}old_string not found in ${doc.path} (re-read the file; it may have changed)`, { details: { edit: i } });
            throw new RefusedError(`${where}old_string is not unique (${r.count} occurrences); add surrounding context or use --all`, { details: { edit: i, count: r.count } });
          }
          text = r.text;
          counts.push(r.splices.length);
          for (const s of r.splices) {
            pending.push({ via: 'edit', threads: e.threads, oldLines: s.oldLines, newLines: s.newLines, newText: tagText(neu) });
            owner.push(i);
          }
        });
        const res = await ctx.store.writeWorking(doc, text, { expectSha256: working.sha256 });
        for (const p of pending) await ctx.store.appendPendingEdit(doc.id, { ...p, beforeSha256: working.sha256, afterSha256: res.sha256 });
        const finalLines = effectivePendingLines(pending).map((p) => /** @type {[number, number]} */ (p.newLines));
        const out = normalized.map((e, i) => {
          const mine = finalLines.filter((_, k) => owner[k] === i);
          return { threads: e.threads, lines: /** @type {[number, number]} */ ([Math.min(...mine.map((l) => l[0])), Math.max(...mine.map((l) => l[1]))]), count: counts[i] };
        });
        return { edits: out };
      }, !expectSha256);
    },
    { ack: true },
  );
}

/**
 * Restores part of the working copy: one head->working hunk, or a lock's agreed text.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ hunk?: string, lock?: string }} target
 */
export async function revert(ctx, ref, target) {
  if (!target?.hunk === !target?.lock) throw new UsageError('revert: exactly one of --hunk or --lock is required');
  return withDoc(
    ctx,
    ref,
    (doc) =>
      withCasRetry(async () => {
        refuseSnapshot(ctx, doc, 'revert');
        const head = await readHead(ctx, doc);
        const working = await requireWorking(ctx, doc, head);
        /** @type {Spliced} */
        let splice;
        if (target.hunk) {
          const hunks = lineHunks(head.source, working.text);
          const h = hunks.find((x) => x.id === String(target.hunk).toLowerCase());
          if (!h) {
            const known = hunks.length ? hunks.map((x) => x.id).join(', ') : 'none';
            throw new NotFoundError(`hunk ${target.hunk} not found between v${head.v} and the working copy (hunks: ${known})`, { details: { hunk: target.hunk } });
          }
          splice = spliceText(working.text, h.newStartOff, h.newEndOff, head.source.slice(h.oldStartOff, h.oldEndOff));
        } else {
          const lock = await ctx.store.getLock(doc.id, String(target.lock));
          if (!lock) throw new NotFoundError(`lock ${target.lock} not found in ${doc.id}`, { details: { lock: target.lock } });
          const a = anchorAt(lock, head.v);
          if (!a || a.state === 'orphaned') throw new RefusedError(`lock ${lock.id} lost its place in v${head.v}; restore the text by hand (specreview show ${doc.id} --version ${lock.createdIn})`);
          const m = preciseMapper(head.source, working.text).mapRange(a.src.start, a.src.end);
          if (working.text.slice(m.start, m.end) === lock.text) {
            const li = lineIndex(working.text);
            return { lock: lock.id, lines: /** @type {[number, number]} */ ([li.lineOf(m.start), li.lineOf(Math.max(m.start, m.end - 1))]), noop: true, reason: `lock ${lock.id} text is already intact` };
          }
          splice = spliceText(working.text, m.start, m.end, lock.text);
        }
        const res = await ctx.store.writeWorking(doc, splice.text, { expectSha256: working.sha256 });
        await ctx.store.appendPendingEdit(doc.id, {
          via: 'revert',
          oldLines: splice.oldLines,
          newLines: splice.newLines,
          beforeSha256: working.sha256,
          afterSha256: res.sha256,
        });
        return target.hunk ? { hunk: String(target.hunk).toLowerCase(), lines: splice.newLines } : { lock: String(target.lock), lines: splice.newLines };
      }, true),
    { ack: true },
  );
}
