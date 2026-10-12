// @ts-check
// Applying code suggestions to the real repo files (design 4.11). Per file, inside the doc lock:
//   head = blob(F@head, new); w = Store#readRepoFile(F) (a missing file or a symlink is a conflict);
//   each suggestion is located where its thread is anchored now (head anchor mapped onto the working file:
//   review/apply.js suggestionTarget / lineWindow / locateSuggestion; never another copy elsewhere in the file),
//   spliced top-down (CRLF files keep CRLF: matchEol), and the file is written once with Store#writeRepoFile
//   (CAS against the bytes read, `allowed` = the head round's files; on a CAS conflict the file is re-read and the
//   whole file retried once). Each applied suggestion records a pending edit {via: 'apply', threads, file, lines}
//   (the next round links its hunk as "tagged: apply") and becomes `staged`.

import { SSE } from '../../shared/protocol.js';
import { ConflictError, NotFoundError, RefusedError } from '../store/errors.js';
import { eolOf, lineWindow, locateSuggestion, matchEol, spliceText, suggestionTarget } from '../review/apply.js';
import { anchorAt } from '../review/threadstate.js';
import { preciseMapper } from '../review/workmap.js';
import { emit, readHead, requireThread } from '../review/ops/common.js';
import { invalidateCodeState } from './state.js';
import { codeOf, fileOfAnchor, reader } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Actor} Actor
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 */

/**
 * The replacement text of a lines-mode suggestion. `old` is the anchored whole lines without their final line
 * terminator, so one trailing newline of `new` (as a reviewer types it) is dropped: replacing L2 with "y = 3\n"
 * must not add an empty line.
 * @param {{ old?: string, new?: string }} s
 * @returns {string}
 */
export function wholeLinesText(s) {
  const text = String(s.new ?? '');
  if (/\r?\n$/.test(String(s.old ?? ''))) return text;
  return text.replace(/\r?\n$/, '');
}

/**
 * `apply` on a code doc, and the reviewer's "Apply now" (actor human; ops/revise.js then records a 'ui-apply'
 * round). Each thread needs `suggestion.file` and a new-side anchor; otherwise it is a conflict.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string[]} tids
 * @param {{ dryRun?: boolean, actor: Actor }} opts
 * @returns {Promise<{ applied: Array<{ id: string, file: string, lines: [number, number], how: string }>,
 *   conflicts: Array<{ id: string, reason: string }>, skipped?: Array<{ id: string, reason: string }>, dryRun: boolean }>}
 */
export async function applyCodeSuggestions(ctx, doc, tids, { dryRun = false, actor }) {
  void actor;
  return ctx.store.withDocLock(doc.id, async () => {
    const fresh = (await ctx.store.getDoc(doc.id)) ?? doc;
    const head = await readHead(ctx, fresh);
    const H = codeOf(head.manifest);
    const read = reader(ctx, doc.id);
    /** @type {Array<{ id: string, file: string, lines: [number, number], how: string }>} */
    const applied = [];
    /** @type {Array<{ id: string, reason: string }>} */
    const conflicts = [];
    /** @type {Array<{ id: string, reason: string }>} */
    const skipped = [];
    /** @type {Set<Thread>} */
    const changed = new Set();
    /** @type {Map<string, Array<{ t: Thread, a: Anchor, f: CodeFile }>>} */
    const byFile = new Map();
    const conflict = (/** @type {Thread} */ t, /** @type {string} */ reason) => {
      conflicts.push({ id: t.id, reason });
      if (t.suggestion && t.suggestion.status !== 'conflict' && !dryRun) {
        t.suggestion.status = 'conflict';
        changed.add(t);
      }
    };

    for (const tid of [...new Set(tids)]) {
      const t = await requireThread(ctx, doc.id, tid);
      const s = t.suggestion;
      if (!s) {
        skipped.push({ id: tid, reason: 'not a suggestion (edit it yourself, then reply)' });
        continue;
      }
      if (s.status === 'staged') {
        skipped.push({ id: tid, reason: 'already applied to the working tree (staged)' });
        continue;
      }
      if (s.status === 'applied') {
        skipped.push({ id: tid, reason: `already applied in v${s.appliedIn}` });
        continue;
      }
      const a = anchorAt(t, head.v);
      if (!s.file || !a?.file || a.file.side !== 'new' || a.kind === 'doc') {
        conflicts.push({ id: tid, reason: 'not a code suggestion (it needs a file and new-side lines); treat it as a normal comment' });
        continue;
      }
      if (a.state === 'orphaned') {
        conflict(t, 'its anchor was lost (orphaned); treat it as a normal comment');
        continue;
      }
      const f = fileOfAnchor(H, a.file);
      if (!f?.new) {
        conflict(t, `${a.file.path} has no text in v${head.v}; treat it as a normal comment`);
        continue;
      }
      const list = byFile.get(f.path) ?? [];
      list.push({ t, a, f });
      byFile.set(f.path, list);
    }

    const allowed = H.files.filter((f) => f.status !== 'D').map((f) => f.path);
    for (const [path, items] of byFile) {
      const headText = /** @type {string} */ (await read.text(items[0].f.new));
      for (let attempt = 0; ; attempt++) {
        let w;
        try {
          w = await ctx.store.readRepoFile(path);
        } catch (err) {
          if (!(err instanceof RefusedError)) throw err;
          for (const it of items) conflict(it.t, /** @type {Error} */ (err).message);
          break;
        }
        if (!w || w.kind !== 'file') {
          const why = !w ? `${path} is missing from your working tree` : w.kind === 'symlink' ? `${path} is a symlink in your working tree (never written through)` : `${path} is not a regular file`;
          for (const it of items) conflict(it.t, why);
          break;
        }
        const working = w.text;
        const mapper = working === headText ? null : preciseMapper(headText, working);
        const map = (/** @type {number} */ off, /** @type {'left' | 'right'} */ bias) => (mapper ? mapper.map(off, bias) : off);
        /** @type {Array<{ it: { t: Thread, a: Anchor, f: CodeFile }, start: number, end: number, how: string }>} */
        const located = [];
        for (const it of items) {
          const s = /** @type {import('../../shared/types.js').Suggestion} */ (it.t.suggestion);
          const { expected, window } = suggestionTarget(it.a, s, head.v);
          const ws = map(window.start, 'right');
          const we = Math.max(ws, map(window.end, 'left'));
          const loc = locateSuggestion(working, s.old, map(expected, 'right'), lineWindow(working, ws, we));
          if (!loc) {
            conflict(it.t, `the suggested lines are no longer where ${it.t.id} is anchored (${path}:L${it.a.src.startLine} in v${head.v}); edit it yourself`);
            continue;
          }
          located.push({ it, start: loc.start, end: loc.end, how: loc.how });
        }
        located.sort((x, y) => x.start - y.start || x.end - y.end);
        /** @type {typeof located} */
        const todo = [];
        for (const l of located) {
          const prev = todo[todo.length - 1];
          if (prev && l.start < prev.end) conflict(l.it.t, `it overlaps ${prev.it.t.id} in ${path}; apply them one at a time`);
          else todo.push(l);
        }
        if (!todo.length) break;
        const eol = eolOf(working);
        let text = working;
        let delta = 0;
        /** @type {Array<{ l: typeof todo[number], sp: import('../review/apply.js').Spliced, insert: string }>} */
        const done = [];
        for (const l of todo) {
          const insert = matchEol(wholeLinesText(/** @type {any} */ (l.it.t.suggestion)), eol);
          const sp = spliceText(text, l.start + delta, l.end + delta, insert);
          text = sp.text;
          delta += insert.length - (l.end - l.start);
          done.push({ l, sp, insert });
        }
        if (dryRun) {
          for (const d of done) applied.push({ id: d.l.it.t.id, file: path, lines: d.sp.newLines, how: d.l.how });
          break;
        }
        let written;
        try {
          written = await ctx.store.writeRepoFile(path, text, { expectSha256: w.sha256, allowed });
        } catch (err) {
          if (err instanceof ConflictError && attempt === 0) continue;
          if (err instanceof ConflictError || err instanceof NotFoundError || err instanceof RefusedError) {
            for (const it of items) if (!conflicts.some((c) => c.id === it.t.id)) conflict(it.t, /** @type {Error} */ (err).message);
            break;
          }
          throw err;
        }
        for (const d of done) {
          const t = d.l.it.t;
          await ctx.store.appendPendingEdit(doc.id, {
            via: 'apply',
            threads: [t.id],
            file: path,
            oldLines: d.sp.oldLines,
            newLines: d.sp.newLines,
            beforeSha256: w.sha256,
            afterSha256: written.sha256,
            ...(d.insert.trim() ? { newText: d.insert } : {}),
          });
          /** @type {any} */ (t.suggestion).status = 'staged';
          changed.add(t);
          applied.push({ id: t.id, file: path, lines: d.sp.newLines, how: d.l.how });
        }
        break;
      }
    }

    if (!dryRun && changed.size) {
      for (const t of changed) {
        t.updatedAt = ctx.now();
        await ctx.store.saveThread(doc.id, t);
      }
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { threads: [...changed].map((t) => t.id), applied: applied.map((x) => x.id) });
    }
    if (!dryRun && applied.length) invalidateCodeState(doc.id);
    const order = new Map(tids.map((id, i) => [id, i]));
    const byOrder = (/** @type {{ id: string }} */ x, /** @type {{ id: string }} */ y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0);
    return { applied: applied.sort(byOrder), conflicts: conflicts.sort(byOrder), skipped: skipped.sort(byOrder), dryRun };
  });
}
