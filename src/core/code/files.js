// @ts-check
// File lists, per-file diffs and file sources of a code doc (design 4.12; the daemon D/files routes, Changes mode
// and Verify, the CLI `diff` and `show --file`):
//
//   codeFiles({v})            the files of a round, with the threads anchored on each
//   codeFiles({from, to})     the interdiff file list: files whose NEW side differs between the two rounds, plus
//                             files added to or dropped from the review
//   codeFileDiff({path, v})   base -> new side of one file at round v (stubs for binary / too large / skipped)
//   codeFileDiff({path, from, to})  the new side of one file between two rounds (thread chips from the round's
//                             manifest hunks for adjacent rounds)
//   codeFileSource            one file side's text at a round
//   codeChanges               ops.changes on a code doc: a ChangeSet-compatible interdiff (hunk ids '<path>#h<n>')
//   codeUnifiedDiff           per-file unified patches labelled a/<path>@vA b/<path>@vB
//   codeThreadMiniDiff        the anchored lines of a thread's file side, before (the reviewer's last round) / now
//
// A file of round B continues a file of round A by new-side lineage: the same path, else the path it was renamed
// from. A file no longer in the review is "dropped" (its new side is back to base).

import { NotFoundError, UsageError } from '../store/errors.js';
import { isCode } from '../store/snapshot.js';
import { compareIds } from '../store/store.js';
import { lineHunks, sourceDiff, unifiedPatch, wordDiff } from '../diff/index.js';
import { lineIndex } from '../text/index.js';
import { resolveCodePath } from '../util/code-at.js';
import { newLineRange } from '../review/attribution.js';
import { anchorAt, lastIndexes } from '../review/threadstate.js';
import { parseVersionArg, requireThread, resolveDoc } from '../review/ops/common.js';
import { codeOf, fileAt, hasText, notInRound, reader, sidePath } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('./util.js').Reader} Reader
 * @typedef {{ path: string, h: CodeFile | null, n: CodeFile | null }} Pair
 */

/**
 * A code doc (UsageError for any other kind).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @returns {Promise<Doc>}
 */
async function codeDoc(ctx, ref) {
  const doc = await resolveDoc(ctx, ref);
  if (!isCode(doc)) throw new UsageError(`${doc.id} is not a code review`, { details: { doc: doc.id } });
  return doc;
}

/**
 * A version number of the doc (NotFoundError past head).
 * @param {Doc} doc
 * @param {unknown} v
 * @param {number} [fallback]
 * @returns {number}
 */
function versionOf(doc, v, fallback) {
  const n = /** @type {number} */ (parseVersionArg(v === 'live' ? undefined : v, { fallback: fallback ?? doc.head }));
  if (!doc.head) throw new NotFoundError(`${doc.id} has no recorded round yet`, { details: { doc: doc.id } });
  if (n > doc.head) throw new NotFoundError(`${doc.id} has no v${n} (head is v${doc.head})`, { details: { doc: doc.id, version: n } });
  return n;
}

/**
 * from/to of an interdiff: like ops.changes, from = the round the reviewer last reviewed (else head - 1), to = head.
 * @param {Doc} doc
 * @param {{ from?: unknown, to?: unknown }} range
 * @returns {{ from: number, to: number }}
 */
function rangeOf(doc, range = {}) {
  const defFrom = doc.lastReviewedVersion && doc.lastReviewedVersion < doc.head ? doc.lastReviewedVersion : Math.max(1, doc.head - 1);
  const to = versionOf(doc, range.to, doc.head);
  const from = versionOf(doc, range.from, Math.min(defFrom, to));
  if (from > to) throw new UsageError(`invalid range v${from}..v${to}: the first round must come first`);
  return { from, to };
}

/**
 * Files of round B paired with round A's by new-side lineage (see the header); sorted by path.
 * @param {CodeManifest} A
 * @param {CodeManifest} B
 * @returns {Pair[]}
 */
function pairRounds(A, B) {
  /** @type {Pair[]} */
  const out = [];
  const used = new Set();
  for (const n of B.files) {
    let h = A.files.find((x) => x.path === n.path && !used.has(x)) ?? null;
    if (!h && n.oldPath) h = A.files.find((x) => x.path === n.oldPath && x.status !== 'D' && !used.has(x)) ?? null;
    if (h) used.add(h);
    out.push({ path: n.path, h, n });
  }
  for (const h of A.files) if (!used.has(h)) out.push({ path: h.path, h, n: null });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * The new-side text of a file of a pair (a dropped file: its base text; a missing side: ''); null for a stub.
 * @param {Reader} r
 * @param {CodeFile | null} f
 * @param {CodeFile | null} other the paired file (a file new to the review: its base text was its content)
 */
async function newText(r, f, other) {
  if (!f) {
    if (!other || other.status === 'A' || other.status === 'R') return '';
    return other.binary || !hasText(other, 'old') ? null : r.text(other.old);
  }
  if (f.status === 'D') return '';
  return hasText(f, 'new') ? r.text(f.new) : null;
}

/**
 * The content identity of a file's new side.
 * @param {CodeFile | null} f
 */
function identity(f) {
  if (!f || f.status === 'D') return 'none';
  return JSON.stringify([f.new ?? null, /** @type {any} */ (f).ids?.new ?? null, f.binary ?? false, f.tooLarge?.side === 'new' ? f.tooLarge.bytes : null, f.mode?.new ?? null]);
}

/**
 * Thread ids whose anchor at round v is on file f (any side), sorted.
 * @param {Thread[]} threads
 * @param {CodeFile | { path: string, oldPath?: string }} f
 * @param {number} v
 */
function threadsOn(threads, f, v) {
  return threads
    .filter((t) => {
      const a = anchorAt(t, v);
      return a?.file && (a.file.path === f.path || (f.oldPath && a.file.path === f.oldPath));
    })
    .map((t) => t.id)
    .sort(compareIds);
}

/**
 * GET D/files?v=N -> { v, files: Array<CodeFile & { threads: string[] }>, skipped };
 * GET D/files?from=A&to=B -> { from, to, files: Array<{ path, oldPath?, change: 'changed' | 'added' | 'dropped' |
 * 'renamed', added, removed, threads }> }.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ v: number } | { from: number, to: number }} q
 * @returns {Promise<object>}
 */
export async function codeFiles(ctx, ref, q) {
  const doc = await codeDoc(ctx, ref);
  const r = reader(ctx, doc.id);
  const threads = await ctx.store.listThreads(doc.id);
  const qq = /** @type {any} */ (q ?? {});
  if (qq.from === undefined && qq.to === undefined) {
    const v = versionOf(doc, qq.v);
    const { code } = await r.version(v);
    return { v, files: code.files.map((f) => ({ ...f, threads: threadsOn(threads, f, v) })), skipped: code.skipped ?? [] };
  }
  const { from, to } = rangeOf(doc, qq);
  const [A, B] = await Promise.all([r.version(from), r.version(to)]);
  const out = [];
  for (const p of pairRounds(A.code, B.code)) {
    /** @type {'changed' | 'added' | 'dropped' | 'renamed' | null} */
    let change = null;
    if (!p.h) change = p.n?.status === '=' ? null : 'added';
    else if (!p.n) change = 'dropped';
    else if (p.n.path !== p.h.path) change = 'renamed';
    else if (identity(p.h) !== identity(p.n)) change = 'changed';
    if (!change || from === to) continue;
    const [a, b] = await Promise.all([newText(r, p.h, p.n), newText(r, p.n, p.h)]);
    let added = 0;
    let removed = 0;
    if (a !== null && b !== null) {
      if (a === b && change === 'added') continue;
      for (const h of lineHunks(a, b)) {
        added += h.newLines;
        removed += h.oldLines;
      }
    }
    const linked = new Set();
    for (const t of threads) {
      for (const ch of t.changes ?? []) {
        if (ch.version > from && ch.version <= to && typeof ch.hunk === 'string' && (ch.hunk.startsWith(`${p.path}#`) || (p.h && ch.hunk.startsWith(`${p.h.path}#`)))) linked.add(t.id);
      }
    }
    out.push({ path: p.path, ...(p.n && p.h && p.n.path !== p.h.path ? { oldPath: p.h.path } : {}), change, added, removed, threads: [...linked].sort(compareIds) });
  }
  return { from, to, files: out };
}

/**
 * A file of a round by the path a caller gives (its path or old path), or its skipped entry.
 * @param {CodeManifest} code
 * @param {string} p
 */
function lookup(code, p) {
  const f = fileAt(code, p);
  const skip = (code.skipped ?? []).find((s) => s.path === p || (f && s.path === f.path)) ?? null;
  return { f, skip };
}

/**
 * The stub kind of a file (no text diff), or null.
 * @param {CodeFile | null} f
 * @param {{ reason: string } | null} skip
 * @returns {string | null}
 */
function stubOf(f, skip) {
  if (f?.binary) return 'binary';
  if (f?.tooLarge) return 'too-large';
  if (skip) return skip.reason;
  return null;
}

/**
 * Display hunks with namespaced ids and the threads whose lines they show.
 * @param {string} path
 * @param {Array<import('../diff/source-diff.js').DisplayHunk>} hunks
 * @param {(h: import('../diff/source-diff.js').DisplayHunk) => string[]} threadsOf
 */
function decorate(path, hunks, threadsOf) {
  return hunks.map((h) => ({ ...h, id: `${path}#${h.id}`, hunkIds: (h.hunkIds ?? [h.id]).map((id) => `${path}#${id}`), threads: threadsOf(h) }));
}

/**
 * Threads whose anchor at round v (on `path`) intersects a display hunk's rows (new-side anchors by newNo, old-side
 * anchors by oldNo).
 * @param {Thread[]} threads
 * @param {string} path
 * @param {number} v
 */
function rowThreads(threads, path, v) {
  const anchored = threads
    .map((t) => ({ t, a: anchorAt(t, v) }))
    .filter(({ a }) => a?.file?.path === path && a.kind !== 'doc' && a.state !== 'orphaned' && a.v === v);
  return (/** @type {import('../diff/source-diff.js').DisplayHunk} */ h) => {
    const ids = new Set();
    for (const { t, a } of anchored) {
      const key = a?.file?.side === 'old' ? 'oldNo' : 'newNo';
      const s = /** @type {any} */ (a).src.startLine;
      const e = /** @type {any} */ (a).src.endLine;
      if (h.rows.some((row) => row[key] != null && row[key] >= s && row[key] <= e)) ids.add(t.id);
    }
    return [...ids].sort(compareIds);
  };
}

/**
 * GET D/files/diff?path=P&v=N[&context=K] (or &from=A&to=B) -> { path, oldPath?, v | from+to, stub?, hunks }.
 * NotFoundError for a path that is not in the round. Without a path (GET D/diff/source on a code doc): UsageError.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {({ path: string, v: number } | { path: string, from: number, to: number }) & { context?: number }} q
 * @returns {Promise<object>}
 */
export async function codeFileDiff(ctx, ref, q) {
  const doc = await codeDoc(ctx, ref);
  const qq = /** @type {any} */ (q ?? {});
  if (typeof qq.path !== 'string' || !qq.path) throw new UsageError('code reviews diff one file at a time: give its path (GET D/files/diff?path=...)');
  const ctxLines = Number.isSafeInteger(Number(qq.context)) && Number(qq.context) >= 0 ? Math.min(Number(qq.context), 1000) : (/** @type {any} */ (doc.code)?.context ?? 3);
  const r = reader(ctx, doc.id);
  const threads = await ctx.store.listThreads(doc.id);
  if (qq.from === undefined && qq.to === undefined) {
    const v = versionOf(doc, qq.v);
    const { code } = await r.version(v);
    const { f, skip } = lookup(code, qq.path);
    if (!f && !skip) throw notInRound(qq.path, v);
    const path = f?.path ?? /** @type {any} */ (skip).path;
    const head = { path, ...(f?.oldPath ? { oldPath: f.oldPath } : {}), v };
    const stub = stubOf(f, skip);
    if (stub || !f) return { ...head, stub: stub ?? 'binary', hunks: [] };
    const oldT = hasText(f, 'old') ? /** @type {string} */ (await r.text(f.old)) : '';
    const newT = hasText(f, 'new') ? /** @type {string} */ (await r.text(f.new)) : '';
    if (f.status === '=') {
      const li = lineIndex(newT);
      const rows = [];
      for (let l = 1; l <= (newT ? li.count : 0); l++) rows.push({ op: ' ', oldNo: l, newNo: l, text: li.lineText(l).replace(/\r$/, ''), words: [] });
      const whole = { id: 'h0', header: `@@ -1,${rows.length} +1,${rows.length} @@`, hunkIds: [], rows };
      return { ...head, hunks: rows.length ? decorate(path, [/** @type {any} */ (whole)], rowThreads(threads, path, v)) : [] };
    }
    return { ...head, hunks: decorate(path, sourceDiff(oldT, newT, { context: ctxLines }).hunks, rowThreads(threads, path, v)) };
  }
  const { from, to } = rangeOf(doc, qq);
  const [A, B] = await Promise.all([r.version(from), r.version(to)]);
  const pair = pairRounds(A.code, B.code).find((p) => p.path === qq.path || p.n?.oldPath === qq.path || p.h?.path === qq.path) ?? null;
  if (!pair) {
    const sk = (B.code.skipped ?? []).find((s) => s.path === qq.path) ?? (A.code.skipped ?? []).find((s) => s.path === qq.path);
    if (sk) return { path: sk.path, from, to, stub: sk.reason, hunks: [] };
    throw new NotFoundError(`${qq.path} is not a file of v${from} or v${to}`, { details: { path: qq.path, from, to } });
  }
  const head = { path: pair.path, ...(pair.h && pair.n && pair.h.path !== pair.n.path ? { oldPath: pair.h.path } : {}), from, to };
  const [a, b] = await Promise.all([newText(r, pair.h, pair.n), newText(r, pair.n, pair.h)]);
  if (a === null || b === null) return { ...head, stub: pair.n?.binary || pair.h?.binary ? 'binary' : 'too-large', hunks: [] };
  const hs = lineHunks(a, b);
  /** @type {Record<string, string[]>} */
  const byHunk = {};
  if (to === from + 1) for (const h of B.manifest.hunks ?? []) if (h.file === pair.path) byHunk[h.id] = h.threads ?? [];
  const spanThreads = to === from + 1 ? null : rowThreads(threads, pair.path, to);
  const hunks = decorate(pair.path, sourceDiff(a, b, { context: ctxLines, hunks: hs }).hunks, (h) =>
    spanThreads ? spanThreads(h) : [...new Set((h.hunkIds ?? [h.id]).flatMap((id) => byHunk[`${pair.path}#${id}`] ?? []))].sort(compareIds),
  );
  return { ...head, hunks };
}

/**
 * GET D/files/source?path=P&v=N&side=new|old -> { path, side, v, text, lines }.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ path: string, v: number, side: 'new' | 'old' }} q
 * @returns {Promise<{ path: string, side: 'new' | 'old', v: number, text: string, lines: number }>}
 */
export async function codeFileSource(ctx, ref, { path, v, side }) {
  const doc = await codeDoc(ctx, ref);
  if (typeof path !== 'string' || !path) throw new UsageError('a file path is required');
  if (side !== 'new' && side !== 'old') throw new UsageError(`side must be "new" or "old", not ${JSON.stringify(side)}`);
  const ver = versionOf(doc, v);
  const r = reader(ctx, doc.id);
  const { code } = await r.version(ver);
  const f = fileAt(code, path) ?? byWrittenPath(ctx, code, path);
  if (!f) throw notInRound(path, ver);
  if (!hasText(f, side)) {
    const why = f.binary ? 'a binary file' : f.tooLarge ? 'too large to show' : side === 'new' ? 'deleted (no new side)' : 'added (no old side)';
    throw new UsageError(`${f.path} (${side} side) is ${why} in v${ver}`, { details: { path: f.path, side, version: ver } });
  }
  const text = /** @type {string} */ (await r.text(side === 'new' ? f.new : f.old));
  return { path: side === 'old' ? sidePath(f, 'old') : f.path, side, v: ver, text, lines: text ? lineIndex(text).count : 0 };
}

/**
 * A file of a round by a path as an agent writes it (cwd-relative, absolute or a unique suffix), or null.
 * @param {Ctx} ctx
 * @param {CodeManifest} code
 * @param {string} written
 * @returns {CodeFile | null}
 */
function byWrittenPath(ctx, code, written) {
  const paths = [...new Set(code.files.flatMap((f) => [f.path, f.oldPath].filter((x) => typeof x === 'string')))];
  const res = resolveCodePath(written, /** @type {string[]} */ (paths), { root: ctx.root, cwd: ctx.cwd ?? ctx.root });
  return res.file ? fileAt(code, res.file) : null;
}

/**
 * ops.changes on a code doc (Verify, Changes mode, `diff --stat`): the interdiff between two rounds, in the
 * ChangeSet shape the UI keeps in `s.changes` (hunk ids '<path>#h<n>', `file`, `section: [path]`).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | 'live', to?: number | 'live' } & Record<string, unknown>} range
 * @returns {Promise<object>}
 */
export async function codeChanges(ctx, ref, range) {
  const doc = await codeDoc(ctx, ref);
  const { from, to } = rangeOf(doc, range ?? {});
  const r = reader(ctx, doc.id);
  const [A, B] = await Promise.all([r.version(from), r.version(to)]);
  const threads = await ctx.store.listThreads(doc.id);
  /** @type {Map<string, any>} */
  const recorded = new Map();
  let forced = false;
  if (to === from + 1) {
    for (const h of B.manifest.hunks ?? []) recorded.set(h.id, h);
    forced = Boolean(B.manifest.guards?.forced);
  }
  const hunks = [];
  /** @type {Record<string, string[]>} */
  const threadLinks = {};
  let added = 0;
  let removed = 0;
  if (from !== to) {
    for (const p of pairRounds(A.code, B.code)) {
      if (identity(p.h) === identity(p.n) && p.h && p.n && p.h.path === p.n.path) continue;
      const [a, b] = await Promise.all([newText(r, p.h, p.n), newText(r, p.n, p.h)]);
      if (a === null || b === null || a === b) continue;
      const span = to === from + 1 ? null : rowSpanThreads(threads, p.path, to);
      for (const h of lineHunks(a, b)) {
        const id = `${p.path}#${h.id}`;
        const rec = recorded.get(id);
        const ts = rec ? rec.threads ?? [] : span ? span(newLineRange(h)) : [];
        added += h.newLines;
        removed += h.oldLines;
        for (const t of ts) (threadLinks[t] ??= []).push(id);
        hunks.push({
          id,
          file: p.path,
          op: h.oldLines === 0 ? 'add' : h.newLines === 0 ? 'del' : 'mod',
          old: { start: h.oldStart, lines: h.oldLines },
          new: { start: h.newStart, lines: h.newLines },
          srids: [],
          words: [],
          deleted: null,
          insertBefore: null,
          insertAfter: null,
          section: [p.path],
          threads: ts,
          linkedBy: rec?.linkedBy ?? null,
          other: rec?.other ?? null,
        });
      }
    }
  }
  return { from, to, stats: { added, removed, hunks: hunks.length, blocksChanged: 0 }, hunks, assets: [], threadLinks, guards: { forced, brokenLocks: [] } };
}

/**
 * Threads whose new-side anchor at round v on `path` overlaps a new line range.
 * @param {Thread[]} threads
 * @param {string} path
 * @param {number} v
 */
function rowSpanThreads(threads, path, v) {
  const anchored = threads.map((t) => ({ t, a: anchorAt(t, v) })).filter(({ a }) => a?.file?.path === path && a.file.side === 'new' && a.kind !== 'doc' && a.state !== 'orphaned');
  return (/** @type {[number, number]} */ [s, e]) =>
    anchored.filter(({ a }) => /** @type {any} */ (a).src.startLine <= e && s <= /** @type {any} */ (a).src.endLine).map(({ t }) => t.id).sort(compareIds);
}

/**
 * ops.unifiedDiff on a code doc (`diff A..B --unified`): per-file unified patches labelled a/<path>@vA b/<path>@vB.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | 'live', to?: number | 'live' } & Record<string, unknown>} range
 * @returns {Promise<object>}
 */
export async function codeUnifiedDiff(ctx, ref, range) {
  const doc = await codeDoc(ctx, ref);
  const { from, to } = rangeOf(doc, range ?? {});
  const r = reader(ctx, doc.id);
  const [A, B] = await Promise.all([r.version(from), r.version(to)]);
  const context = /** @type {any} */ (doc.code)?.context ?? 3;
  const parts = [];
  if (from !== to) {
    for (const p of pairRounds(A.code, B.code)) {
      const hPath = p.h?.path ?? p.path;
      const [a, b] = await Promise.all([newText(r, p.h, p.n), newText(r, p.n, p.h)]);
      if (a === null || b === null) {
        if (identity(p.h) !== identity(p.n)) parts.push(`Binary or too-large file ${p.path} changed (v${from} -> v${to})\n`);
        continue;
      }
      const patch = unifiedPatch(a, b, { fromLabel: `a/${hPath}@v${from}`, toLabel: `b/${p.path}@v${to}`, context });
      if (patch) parts.push(patch);
    }
  }
  return { from, to, patch: parts.join('') };
}

/**
 * ops.threadMiniDiff on a code doc: the anchored lines of the thread's file side at the round the reviewer last
 * commented on (`before`) and at head (`after`), clipped to 6 lines, with word ranges (ThreadPanel's Verify queue).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 * @returns {Promise<object>}
 */
export async function codeThreadMiniDiff(ctx, ref, tid) {
  const doc = await codeDoc(ctx, ref);
  const t = await requireThread(ctx, doc.id, tid);
  const head = doc.head;
  const { lastHuman } = lastIndexes(t);
  const base = Math.min(head, Math.max(t.createdIn ?? 1, lastHuman >= 0 ? t.comments[lastHuman].version ?? 1 : t.createdIn ?? 1));
  const r = reader(ctx, doc.id);
  const before = anchorAt(t, base);
  const after = anchorAt(t, head);
  const textOf = async (/** @type {import('../../shared/types.js').Anchor | null} */ a, /** @type {number} */ v) => {
    if (!a?.file || a.kind === 'doc' || a.state === 'orphaned') return '';
    const { code } = await r.version(v);
    const f = a.file.side === 'new' ? code.files.find((x) => x.path === a.file?.path && x.status !== 'D') : fileAt(code, a.file.oldPath ?? a.file.path);
    const ref2 = f ? (a.file.side === 'new' ? f.new : f.old) : null;
    const text = ref2 ? await r.text(ref2) : null;
    if (text == null) return a.src.text ?? '';
    const li = lineIndex(text);
    const lines = text.slice(li.startOf(a.src.startLine), li.endOf(a.src.endLine)).split('\n').map((l) => l.replace(/\r$/, ''));
    return lines.length > 6 ? [...lines.slice(0, 5), `…(${lines.length - 5} more lines)`].join('\n') : lines.join('\n');
  };
  const b = await textOf(before, base);
  const a = await textOf(after, head);
  return { kind: 'text', version: head, from: base, before: b, after: a, words: wordDiff(b, a), state: after?.state ?? null, file: after?.file ?? null };
}
