// @ts-check
// Rounds of a code review (design 4.6, 4.8, 4.9): `revise` on a code doc (the agent records its working tree as
// vN+1 with replies), the reviewer's "Re-snapshot" / "Apply now" rounds and a `review` re-run.
//
//   1. take the round (dry: no blob written yet) per doc.code, with the files of open threads carried;
//   2. the canonical text equals head's: replies only (or "nothing to record"); an `addressed` reply in a mode that
//      cannot see working-tree edits (staged, branch, range by ref) while the working tree has changes is refused
//      with the missing step (exit 3);
//   3. otherwise per changed file: line hunks head blob -> new blob (ids '<path>#h<n>'), attribution (tagged pending
//      edits of that file, reply hints in file space, overlap with the thread anchors of that file, `other` entries
//      naming it), the code guard profile (notes only, never a refusal), then record.js commitRecord with a
//      Prepared whose stepFor re-anchors in file space (forward.js) and whose `landed` checks a staged suggestion in
//      its own file.

import { SSE } from '../../shared/protocol.js';
import { RefusedError, UsageError } from '../store/errors.js';
import { docRefFor } from '../store/snapshot.js';
import { textRender } from '../render/index.js';
import { lineHunks } from '../diff/index.js';
import { lineIndex } from '../text/index.js';
import { sha256 } from '../util/hash.js';
import { parseLinesArg } from '../util/lines-arg.js';
import { parseCodeAt, parseCodeOtherAt, resolveCodePath } from '../util/code-at.js';
import { attribute } from '../review/attribution.js';
import { eolOf, matchEol } from '../review/apply.js';
import { anchorAt, isActionable, originalAnchor } from '../review/threadstate.js';
import { preciseMapper } from '../review/workmap.js';
import { commitRecord, reportHunks } from '../review/ops/record.js';
import { addAgentReply } from '../review/ops/threads.js';
import { agentActor, emit, readHead, requireThread, respondsToOf } from '../review/ops/common.js';
import { STORE_EXCLUDE, openRepo, splitNul } from './git.js';
import { baseName, short } from './spec.js';
import { skippedText } from './diff-text.js';
import { takeCodeSnapshot } from './snapshot.js';
import { roundOptions } from './state.js';
import { newSideSuccessor, stepCodeAnchor, stepRefs } from './forward.js';
import { codeEnv, codeOf, hasText, lineAnchor, reader } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Actor} Actor
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {import('../review/attribution.js').AttributedHunk} AttributedHunk
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {Record<string, { status: string, reply: string, at?: string }>} Replies
 *
 * @typedef {object} Pair one file of the round compared head -> new (new-side content)
 * @property {string} path the hunk namespace (the new path; a dropped or deleted file's path)
 * @property {CodeFile | null} h the file at head
 * @property {CodeFile | null} n the file in the new round
 * @property {string | null} hText head new-side text (null: a stub)
 * @property {string | null} nText new-side text in the new round (null: a stub)
 * @property {boolean} changed
 */

/** The guard issues of the code profile (design 4.9): notes, never a refusal. */
const NO_GUARDS = Object.freeze({ refused: false, forced: false, errors: [], warnings: [], brokenLocks: [], intactLocks: [], unexplained: [], rewriteRatio: 0 });

/**
 * `revise` on a code doc (dispatched by ops/revise.js inside the doc lock, after the ack). `input` is the parsed
 * ReviseInput: `threads` replies with `at` in the code forms of util/code-at.js, `other`, `summary`, `dryRun`.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {import('../../shared/types.js').ReviseInput & Record<string, unknown>} input
 * @returns {Promise<import('../../shared/types.js').ReviseReport & { code: { files: number, baseMoved: { from: string, to: string } | null, carried: string[] } }>}
 */
export async function reviseCode(ctx, doc, input) {
  const p = /** @type {any} */ (input);
  if (Object.keys(p.breakLocks ?? {}).length) throw new UsageError('code reviews have no locks: --break-lock does not apply');
  /** @type {Replies} */
  const replies = p.threads ?? {};
  for (const tid of Object.keys(replies)) await requireThread(ctx, doc.id, tid);
  return /** @type {any} */ (
    await recordRound(ctx, doc, {
      author: agentActor(ctx),
      capturedBy: 'round',
      replies,
      other: Array.isArray(p.other) ? p.other : [],
      summary: typeof p.summary === 'string' ? p.summary.trim() : '',
      dryRun: Boolean(p.dryRun),
      agentRevise: true,
    })
  );
}

/**
 * Records the working tree as a new round without agent replies (UI "Re-snapshot": capturedBy 'ui-record'; after a
 * reviewer apply: 'ui-apply'; a `review` re-run: 'round'). `{ nothing: true, v }` when the round equals head.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ author: Actor, capturedBy: 'ui-record' | 'ui-apply' | 'round' }} p
 * @returns {Promise<{ manifest: VersionManifest } | { nothing: true, v: number }>}
 */
export async function recordCodeRound(ctx, doc, { author, capturedBy }) {
  return ctx.store.withDocLock(doc.id, async () => {
    const fresh = (await ctx.store.getDoc(doc.id)) ?? doc;
    const summary = capturedBy === 'ui-record' ? 'Re-snapshot by the reviewer' : capturedBy === 'ui-apply' ? 'Applied suggestion' : 'review re-run';
    const r = /** @type {any} */ (await recordRound(ctx, fresh, { author, capturedBy, replies: {}, other: [], summary, dryRun: false, agentRevise: false }));
    if (r.nothing || !r.manifest) return { nothing: true, v: fresh.head };
    return { manifest: r.manifest };
  });
}

/**
 * The round machinery shared by reviseCode and recordCodeRound (inside the doc lock).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ author: Actor, capturedBy: 'round' | 'ui-record' | 'ui-apply', replies: Replies, other: Array<{ at: string, why: string }>,
 *   summary: string, dryRun: boolean, agentRevise: boolean }} o
 */
async function recordRound(ctx, doc, { author, capturedBy, replies, other, summary, dryRun, agentRevise }) {
  const head = await readHead(ctx, doc);
  const H = codeOf(head.manifest);
  const spec = /** @type {CodeSpec} */ (doc.code);
  const ref = docRefFor(doc.id, ctx.root);
  const threads = await ctx.store.listThreads(doc.id);
  const byId = new Map(threads.map((t) => [t.id, t]));
  // replies are checked before anything is taken or written: an unparsable `at` would fail inside the commit
  for (const [tid, r] of Object.entries(replies)) {
    if (!r.at) continue;
    try {
      parseCodeAt(String(r.at), { defaultFile: anchorAt(/** @type {Thread} */ (byId.get(tid)), head.v)?.file?.path ?? null });
    } catch (err) {
      throw new UsageError(`threads.${tid}.at ${JSON.stringify(r.at)}: ${/** @type {Error} */ (err).message}`, { details: { thread: tid } });
    }
  }
  const replyList = Object.entries(replies).map(([thread, r]) => ({ thread, status: r.status }));
  const base = {
    doc: doc.id,
    ref,
    kind: 'code',
    snapshot: false,
    from: head.v,
    version: /** @type {number | null} */ (null),
    refused: false,
    dryRun,
    nothing: false,
    repliesOnly: false,
    respondsTo: /** @type {string | null} */ (null),
    stats: { added: 0, removed: 0, hunks: 0, rewriteRatio: 0 },
    hunks: /** @type {any[]} */ ([]),
    assets: /** @type {any[]} */ ([]),
    replies: replyList,
    guards: /** @type {any} */ ({ ...NO_GUARDS, errors: [], warnings: [], unexplained: [] }),
    anchors: /** @type {any} */ (null),
    notified: false,
    git: /** @type {any} */ (null),
    manifest: /** @type {VersionManifest | null} */ (null),
    code: { files: H.files.length, baseMoved: /** @type {{ from: string, to: string } | null} */ (null), carried: H.files.filter((f) => f.status === '=').map((f) => f.path) },
    text: '',
  };

  // the round; head's carried files are kept for the comparison, so a thread resolved since does not alone make a round
  const keep = await roundOptions(ctx, doc, H, head.v, { keepCarried: true });
  let snap = await takeCodeSnapshot(ctx, spec, { prev: H, ...keep, dry: true });
  const unchanged = sha256(snap.buf) === head.manifest.sha256;
  if (!unchanged) {
    const opts = await roundOptions(ctx, doc, H, head.v);
    if (opts.carry.length !== keep.carry.length) snap = await takeCodeSnapshot(ctx, spec, { prev: H, ...opts, dry: true });
  }

  if (unchanged) {
    if (agentRevise && Object.values(replies).some((r) => r.status === 'addressed')) {
      const step = await missingStep(ctx, spec, H);
      if (step) {
        throw new RefusedError(`v${head.v} of ${doc.id} records ${step.records}, and that is unchanged while your working tree has changes: ${step.fix}, then run specreview revise ${ref} again`, {
          details: { doc: doc.id, mode: spec.mode },
        });
      }
    }
    // the working tree equals head: tagged edits recorded since are stale (undone); their suggestions are pending again
    const unstaged = agentRevise && !dryRun && H.newSide === 'worktree' ? await dropStalePending(ctx, doc) : [];
    if (!replyList.length) {
      const r = { ...base, nothing: true };
      r.text = `specreview: nothing to record (the round matches v${head.v}, no replies)\n`;
      return r;
    }
    if (!dryRun) {
      for (const [tid, r] of Object.entries(replies)) {
        const t = unstaged.find((x) => x.id === tid) ?? (await requireThread(ctx, doc.id, tid));
        addAgentReply(ctx, doc, t, { body: r.reply, status: r.status, at: r.at });
        await ctx.store.saveThread(doc.id, t);
      }
      await ctx.store.saveDoc(doc);
      await emit(ctx, doc.id, SSE.THREAD_UPDATED, { threads: Object.keys(replies), replies: true });
    }
    const r = { ...base, repliesOnly: true, notified: !dryRun };
    const lines = [`specreview: the round matches v${head.v}; ${dryRun ? 'would post' : 'posted'} ${replyList.length} ${replyList.length === 1 ? 'reply' : 'replies'} (no new version)`];
    for (const rep of replyList) lines.push(`  ${rep.thread} ${rep.status}`);
    lines.push(dryRun ? 'dry run: nothing posted' : `next: run \`specreview wait ${ref}\` in the background`);
    r.text = `${lines.join('\n')}\n`;
    return r;
  }

  const N = snap.code;
  const newV = head.v + 1;
  const [reviews, pending] = await Promise.all([ctx.store.listReviews(doc.id), ctx.store.readPendingEdits(doc.id)]);
  const read = reader(ctx, doc.id, snap.texts);
  const prep = await prepareRound(ctx, doc, { head, H, N, threads, byId, pending, reviews, replies, other, read, newV, agentRevise });
  prep.working = { text: snap.text, sha256: sha256(snap.buf), buf: snap.buf, missing: false, dirty: true };
  const respondsTo = author.kind === 'agent' ? respondsToOf(reviews, ctx.agent) : null;
  const report = {
    ...base,
    respondsTo,
    stats: { added: prep.hunks.reduce((n, h) => n + h.newLines, 0), removed: prep.hunks.reduce((n, h) => n + h.oldLines, 0), hunks: prep.hunks.length, rewriteRatio: 0 },
    hunks: reportHunks(/** @type {any} */ (prep)).map((h, i) => ({ ...h, file: prep.hunks[i].file })),
    guards: prep.guards,
    code: { files: N.files.length, baseMoved: N.baseMoved, carried: N.files.filter((f) => f.status === '=').map((f) => f.path) },
  };
  const info = { H, N, head, filesChanged: prep.filesChanged, baseLabel: baseName(spec.mode, N.baseSha, spec.threeDot) };
  if (dryRun) {
    const anchors = predictAnchors(prep, newV);
    const r = { ...report, version: newV, anchors };
    r.text = roundText(r, info);
    return r;
  }

  // the blobs of the new round, then the version (record.js: journal, manifest, events)
  const used = new Set(N.files.flatMap((f) => [f.old, f.new]).filter(Boolean));
  for (const [r, buf] of snap.bufs) if (used.has(r)) await ctx.store.putDocBlob(doc.id, buf);
  const finalSummary = summary || defaultSummary(respondsTo, Object.keys(replies), newV);
  const res = await commitRecord(ctx, doc, /** @type {any} */ (prep), {
    author,
    summary: finalSummary,
    capturedBy,
    respondsTo,
    replies,
    autoReply: author.kind === 'agent',
    manifestExtra: { code: N },
  });
  const r = { ...report, version: res.manifest.v, anchors: res.anchors, notified: true, git: res.git, manifest: res.manifest };
  r.text = roundText(r, info);
  return r;
}

/**
 * @param {string | null} respondsTo
 * @param {string[]} tids
 * @param {number} v
 */
function defaultSummary(respondsTo, tids, v) {
  const t = tids.length ? `: ${tids.join(' ')}` : '';
  return respondsTo ? `${respondsTo}${t}` : `round ${v}${t}`;
}

/**
 * The step a mode that does not record the working tree is missing (staged: `git add`; branch and range by ref:
 * a commit), when the working tree has changes it cannot see; null otherwise.
 * @param {Ctx} ctx
 * @param {CodeSpec} spec
 * @param {CodeManifest} H
 * @returns {Promise<{ records: string, fix: string } | null>}
 */
async function missingStep(ctx, spec, H) {
  if (H.newSide === 'worktree') return null;
  const repo = await openRepo(ctx.root);
  const specArgs = [...(spec.paths ?? []), STORE_EXCLUDE];
  const untracked = (await repo.untracked(specArgs)).length > 0;
  if (H.newSide === 'index') {
    const modified = splitNul((await repo.run(['diff-files', '-z', '--name-only', '--no-ext-diff', '--', ...specArgs])).stdout).length > 0;
    return modified || untracked ? { records: 'the index (staged changes)', fix: 'stage your changes with `git add` first' } : null;
  }
  const headSha = await repo.head();
  if (!headSha) return null;
  const r = await repo.run(['diff-index', '-z', '--name-only', '--no-ext-diff', '--end-of-options', headSha, '--', ...specArgs]);
  const modified = splitNul(r.stdout).length > 0;
  return modified || untracked ? { records: 'commits (HEAD)', fix: 'commit your changes first' } : null;
}

/**
 * The working tree equals head: clears the pending tagged edits and sets every `staged` suggestion back to
 * `pending` (saved). Returns the threads changed.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {Promise<Thread[]>}
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
 * The file pairs head -> new round, by new-side lineage: a file of the new round pairs with head's file at its path
 * (else at its old path); head files no longer in the round are "dropped" (back to base: their new side is the base
 * blob, or nothing for an added file).
 * @param {CodeManifest} H
 * @param {CodeManifest} N
 * @returns {Array<{ path: string, h: CodeFile | null, n: CodeFile | null, dropped: boolean }>}
 */
function pairFiles(H, N) {
  /** @type {Array<{ path: string, h: CodeFile | null, n: CodeFile | null, dropped: boolean }>} */
  const out = [];
  const usedH = new Set();
  for (const n of N.files) {
    let h = H.files.find((x) => x.path === n.path && !usedH.has(x)) ?? null;
    if (!h && n.oldPath) h = H.files.find((x) => x.path === n.oldPath && x.status !== 'D' && !usedH.has(x)) ?? null;
    if (h) usedH.add(h);
    out.push({ path: n.path, h, n, dropped: false });
  }
  for (const h of H.files) if (!usedH.has(h)) out.push({ path: h.path, h, n: null, dropped: true });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The content identity of a file's new side (for "changed").
 * @param {CodeFile | null} f
 */
function newIdentity(f) {
  if (!f || f.status === 'D') return 'none';
  return JSON.stringify([f.new ?? null, /** @type {any} */ (f).ids?.new ?? null, f.binary ?? false, f.tooLarge?.side === 'new' ? f.tooLarge.bytes : null, f.mode?.new ?? null]);
}

/**
 * Builds the code round's Prepared (record.js seams): per-file hunks and attribution, guards, stepFor and landed.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ head: import('../review/ops/common.js').HeadState, H: CodeManifest, N: CodeManifest, threads: Thread[],
 *   byId: Map<string, Thread>, pending: any[], reviews: any[], replies: Replies, other: Array<{ at: string, why: string }>,
 *   read: import('./util.js').Reader, newV: number, agentRevise: boolean }} o
 */
async function prepareRound(ctx, doc, { head, H, N, threads, byId, pending, reviews, replies, other, read, newV, agentRevise }) {
  const env = codeEnv(doc, ctx.config);
  const F = { v: head.v, code: H };
  const T = { v: newV, code: N };
  /** @type {Map<string, string | null>} */
  const texts = new Map();
  const load = async (/** @type {string | undefined | null} */ r) => {
    if (!r) return null;
    if (!texts.has(r)) texts.set(r, await read.text(r));
    return texts.get(r) ?? null;
  };
  const textOf = (/** @type {string | undefined | null} */ r) => (r ? texts.get(r) ?? null : null);

  // file pairs and their texts
  /** @type {Pair[]} */
  const pairs = [];
  for (const { path, h, n, dropped } of pairFiles(H, N)) {
    const hStub = h ? (h.status !== 'D' && !hasText(h, 'new')) || h.binary : false;
    const nStub = n ? (n.status !== 'D' && !hasText(n, 'new')) || n.binary : false;
    /** @type {string | null} */
    let hText = '';
    /** @type {string | null} */
    let nText = '';
    if (h) hText = h.status === 'D' ? '' : hStub ? null : await load(h.new);
    else if (n && n.status !== 'A') hText = n.binary || !hasText(n, 'old') ? null : await load(n.old);
    if (n) nText = n.status === 'D' ? '' : nStub ? null : await load(n.new);
    else if (dropped && h) nText = h.status === 'A' || h.status === 'R' ? '' : h.binary || !hasText(h, 'old') ? null : await load(h.old);
    /** @type {boolean} */
    let changed;
    if (hText !== null && nText !== null) {
      changed = hText !== nText || Boolean(h && n && h.status !== 'D' && n.status !== 'D' && (h.mode?.new ?? null) !== (n.mode?.new ?? null));
    } else changed = newIdentity(h) !== newIdentity(n);
    pairs.push({ path, h, n, hText, nText, changed });
  }
  const changedPairs = pairs.filter((p) => p.changed);
  const roundFiles = [...new Set([...N.files.map((f) => f.path), ...H.files.map((f) => f.path)])];

  // hints (reply `at`s and agent `reply --at` on head) and `other` entries, in file space
  /** @type {Array<{ thread: string, at: string, reason: string }>} */
  const badHints = [];
  /** @type {Map<string, Array<{ thread: string, at: string }>>} */
  const hintsByFile = new Map();
  const addHints = (/** @type {string} */ tid, /** @type {Array<{ file: string, startLine: number, endLine: number }>} */ items, /** @type {string} */ written) => {
    for (const it of items) {
      const res = resolveCodePath(it.file, roundFiles, { root: ctx.root, cwd: ctx.cwd });
      if (!res.file && res.candidates.length > 1) {
        throw new RefusedError(`threads.${tid}.at: "${it.file}" matches ${res.candidates.length} files of the review (${res.candidates.join(', ')}): give the path from the repo root`, { details: { thread: tid, candidates: res.candidates } });
      }
      if (!res.file) {
        badHints.push({ thread: tid, at: written, reason: `${it.file} is not a file of this review` });
        continue;
      }
      const list = hintsByFile.get(res.file) ?? [];
      list.push({ thread: tid, at: `L${it.startLine}-${it.endLine}` });
      hintsByFile.set(res.file, list);
    }
  };
  for (const [tid, r] of Object.entries(replies)) {
    if (!r.at) continue;
    const t = byId.get(tid);
    addHints(tid, parseCodeAt(String(r.at), { defaultFile: t ? anchorAt(t, head.v)?.file?.path ?? null : null }), String(r.at));
  }
  for (const t of threads) {
    if (t.status === 'resolved') continue;
    for (const c of t.comments ?? []) {
      const items = /** @type {any} */ (c).atCode;
      if (/** @type {any} */ (c).recordedWith != null || c.by?.kind !== 'agent' || c.version !== head.v || !Array.isArray(items) || !items.length) continue;
      addHints(t.id, items, items.map((/** @type {any} */ i) => `${i.file}:L${i.startLine}-${i.endLine}`).join(','));
    }
  }
  /** @type {Map<string, Array<{ at: string, why: string, idx: number }>>} */
  const otherByFile = new Map();
  /** @type {Array<{ at: string, why: string, reason: string }>} */
  const unusedOther = [];
  other.forEach((o, idx) => {
    const at = String(o.at ?? '').trim();
    /** @type {{ file: string, lines?: Array<[number, number]>, hunk?: string, del?: boolean } | null} */
    let parsed = null;
    try {
      parsed = parseCodeOtherAt(at);
    } catch {
      const bareHunk = /^(del:)?(h\d+)$/i.exec(at);
      /** @type {Array<[number, number]> | null} */
      let bareLines = null;
      try {
        bareLines = bareHunk ? null : parseLinesArg(at);
      } catch {
        bareLines = null;
      }
      if ((bareHunk || bareLines) && changedPairs.length === 1) {
        parsed = bareHunk ? { file: changedPairs[0].path, hunk: bareHunk[2].toLowerCase(), del: Boolean(bareHunk[1]) } : { file: changedPairs[0].path, lines: /** @type {any} */ (bareLines) };
      } else {
        unusedOther.push({ at, why: o.why, reason: bareHunk || bareLines ? 'name the file, e.g. "src/a.js:L12" (this round changed several files)' : 'not a code location ("src/a.js:L12" or "src/a.js#h3")' });
        return;
      }
    }
    const res = resolveCodePath(parsed.file, roundFiles, { root: ctx.root, cwd: ctx.cwd });
    if (!res.file) {
      unusedOther.push({ at, why: o.why, reason: res.candidates.length > 1 ? `matches several files: ${res.candidates.join(', ')}` : `${parsed.file} is not a file of this review` });
      return;
    }
    const local = parsed.hunk ? `${parsed.del ? 'del:' : ''}${parsed.hunk}` : (parsed.lines ?? []).map(([a, b]) => `L${a}-${b}`).join(',');
    const list = otherByFile.get(res.file) ?? [];
    list.push({ at: local, why: o.why, idx });
    otherByFile.set(res.file, list);
  });

  // per-file attribution
  const replied = new Set(Object.keys(replies));
  /** @type {Array<AttributedHunk & { file: string }>} */
  const hunks = [];
  /** @type {Record<string, string[]>} */
  const threadLinks = {};
  /** @type {Record<string, string>} */
  const sections = {};
  /** @type {Map<string, Hunk[]>} */
  const localHunks = new Map();
  const usedOther = new Set();
  for (const p of pairs) {
    if (!p.changed || p.hText === null || p.nText === null) continue;
    const hs = lineHunks(p.hText, p.nText);
    localHunks.set(p.path, hs);
    if (!hs.length) continue;
    const mapper = preciseMapper(p.hText, p.nText, hs);
    const li = lineIndex(p.hText);
    const hPath = p.h && p.h.status !== 'D' ? p.h.path : null;
    const oldPaths = new Set([p.h?.oldPath ?? p.h?.path, p.n?.oldPath ?? p.n?.path].filter(Boolean));
    /** @type {Array<{ id: string, start: number, end: number }>} */
    const ranges = [];
    /** @type {Record<string, Array<[number, number]> | 'all'>} */
    const scopes = {};
    for (const t of threads) {
      const a = anchorAt(t, head.v);
      if (!a) continue;
      if (!a.file) {
        if (a.kind === 'doc') scopes[t.id] = 'all';
        continue;
      }
      const onNew = a.file.side === 'new' && hPath !== null && a.file.path === hPath;
      const onOld = a.file.side === 'old' && oldPaths.has(a.file.oldPath ?? a.file.path);
      if (!onNew && !onOld) continue;
      if (a.kind === 'doc' || onOld) {
        scopes[t.id] = 'all';
        continue;
      }
      if (a.state === 'orphaned') continue;
      const l0 = Math.max(1, a.src.startLine - 3);
      const l1 = Math.min(li.count, a.src.endLine + 3);
      scopes[t.id] = [[li.startOf(l0), li.nextStartOf(l1)]];
      if (t.status !== 'resolved' && (isActionable(t) || replied.has(t.id))) ranges.push({ id: t.id, start: a.src.start, end: a.src.end });
    }
    const filePending = pending.filter((e) => (e.via === 'apply' || e.via === 'edit') && e.file && (e.file === p.path || e.file === p.h?.path));
    const others = otherByFile.get(p.path) ?? [];
    const attr = attribute({ hunks: hs, headSource: p.hText, workingSource: p.nText, pending: filePending, hints: hintsByFile.get(p.path) ?? [], threads: ranges, other: others.map(({ at, why }) => ({ at, why })), mapper, scopes });
    const unusedHere = attr.unusedOther.map((u) => `${u.at}\u0000${u.why}`);
    for (const o of others) {
      const k = `${o.at}\u0000${o.why}`;
      const i = unusedHere.indexOf(k);
      if (i >= 0) unusedHere.splice(i, 1);
      else usedOther.add(o.idx);
    }
    for (const b of attr.badHints) badHints.push(b);
    for (const h of attr.hunks) {
      const id = `${p.path}#${h.id}`;
      hunks.push({ ...h, id, file: p.path });
      sections[id] = p.path;
      for (const t of h.threads) (threadLinks[t] ??= []).push(id);
    }
  }
  for (const [path, list] of otherByFile) {
    for (const o of list) {
      if (usedOther.has(o.idx)) continue;
      unusedOther.push({ at: String(other[o.idx].at), why: o.why, reason: localHunks.has(path) ? 'matches no hunk' : `${path} did not change in this round` });
    }
  }

  // anchors: preload every text a thread step reads
  for (const t of threads) {
    const a = anchorAt(t, head.v);
    if (!a) continue;
    for (const r of stepRefs(a, F, T, { resolved: t.status === 'resolved' })) await load(r);
  }
  /** @type {Map<string, any>} */
  const overrides = new Map();
  for (const e of pending) if (e.via === 'override' && e.thread && e.file && Array.isArray(e.lines)) overrides.set(e.thread, e);
  for (const e of overrides.values()) {
    const f = newSideSuccessor(N, e.file);
    if (f?.new) await load(f.new);
  }

  /** @type {(item: any, prev: Anchor, linkIds: string[], extra: { linked?: boolean, toVersion: number }) => Anchor} */
  const stepFor = (item, prev, linkIds, extra) => {
    const ov = overrides.get(item.id);
    if (ov) {
      const f = newSideSuccessor(N, ov.file);
      const text = f ? textOf(f.new) : null;
      if (f && text !== null) {
        const count = lineIndex(text).count;
        const a = Math.min(Math.max(1, ov.lines[0]), count);
        const b = Math.min(Math.max(a, ov.lines[1]), count);
        return /** @type {Anchor} */ ({ ...lineAnchor({ v: extra.toVersion, text, startLine: a, endLine: b, file: { path: f.path, side: 'new' }, config: ctx.config }), state: 'exact', mappedBy: 'override' });
      }
    }
    return stepCodeAnchor(prev, {
      from: F,
      to: { v: extra.toVersion, code: N },
      textOf,
      env,
      original: originalAnchor(item),
      links: linkIds,
      linked: Boolean(extra.linked),
      resolved: item.status === 'resolved',
      hunksFor: (from, to) => {
        const p = pairs.find((x) => x.n === to);
        return p && p.h === from ? localHunks.get(p.path) ?? null : null;
      },
    });
  };

  /** @type {(t: Thread, linked: AttributedHunk[]) => boolean} */
  const landed = (t, linked) => {
    const sg = t.suggestion;
    if (!sg?.file) return false;
    const f = newSideSuccessor(N, sg.file);
    if (!f) return false;
    const mine = linked.filter((h) => /** @type {any} */ (h).file === f.path);
    if (!mine.length) return false;
    if (!String(sg.new ?? '').trim()) return true;
    const text = textOf(f.new);
    if (text === null) return false;
    for (const v of new Set([sg.new, matchEol(sg.new, eolOf(text))])) {
      for (let p = text.indexOf(v); p >= 0; p = text.indexOf(v, p + 1)) {
        const e = p + v.length;
        if (mine.some((h) => p <= h.newEndOff && e >= h.newStartOff)) return true;
      }
    }
    return false;
  };
  for (const t of threads) if (t.suggestion?.status === 'staged' && t.suggestion.file) {
    const f = newSideSuccessor(N, t.suggestion.file);
    if (f?.new) await load(f.new);
  }

  const guards = codeGuards({ hunks, threads, replies, threadLinks, unusedOther, badHints, agentRevise, headV: head.v, config: ctx.config });
  return {
    head,
    working: { text: '', sha256: '', buf: Buffer.alloc(0), missing: false, dirty: true },
    hunks,
    mapper: /** @type {any} */ (null),
    attribution: { hunks, threadLinks, unusedOther, badHints },
    render: textRender(),
    workingAssets: {},
    changedAssets: [],
    assetLinks: {},
    sections,
    threads,
    locks: [],
    reviews,
    guards,
    overrides: [],
    stepFor,
    landed,
    assetFiles: {},
    filesChanged: changedPairs.length,
  };
}

/**
 * The code guard profile (design 4.9): notes only. Unlinked hunks, unexplained deletions in files that hold
 * threads, actionable threads without a reply, `addressed` without a linked change, unused `other` entries and
 * unusable hints.
 * @param {{ hunks: Array<AttributedHunk & { file: string }>, threads: Thread[], replies: Replies, threadLinks: Record<string, string[]>,
 *   unusedOther: Array<{ at: string, why: string, reason: string }>, badHints: Array<{ thread: string, at: string, reason: string }>,
 *   agentRevise: boolean, headV: number, config: any }} p
 */
function codeGuards({ hunks, threads, replies, threadLinks, unusedOther, badHints, agentRevise, headV, config }) {
  /** @type {import('../review/guards.js').GuardIssue[]} */
  const warnings = [];
  const cfg = config?.guards ?? {};
  const words = Number(cfg.unexplainedWords) || 50;
  const lines = Number(cfg.unexplainedDeletionLines) || 5;
  const threadFiles = new Set(threads.filter((t) => t.status !== 'resolved').map((t) => anchorAt(t, headV)?.file?.path).filter(Boolean));
  /** @type {string[]} */
  const unexplained = [];
  for (const h of hunks) {
    if (!h.threads.length && h.other == null) {
      unexplained.push(h.id);
      warnings.push({ code: 'unlinked', message: `${h.id} is linked to no thread`, hunk: h.id, fix: `explain it in "other": [{"at": "${h.id}", "why": "..."}]` });
      if (threadFiles.has(h.file) && (h.stats.removedWords >= words || h.stats.wholeLinesRemoved >= lines)) {
        warnings.push({ code: 'deletion', message: `${h.id} removes ${h.stats.wholeLinesRemoved} lines no thread asked for in a file under review`, hunk: h.id });
      }
    } else if (h.outside && threadFiles.has(h.file) && (h.outside.removedWords >= words || h.outside.wholeLinesRemoved >= lines)) {
      warnings.push({ code: 'deletion', message: `${h.id} removes ${h.outside.wholeLinesRemoved} lines beyond what ${h.threads.join(', ')} covers`, hunk: h.id });
    }
  }
  if (agentRevise) {
    for (const t of threads) {
      if (!isActionable(t) || replies[t.id]) continue;
      if (t.suggestion?.status === 'staged') continue;
      warnings.push({ code: 'reply', message: `${t.id} needs action but has no reply`, thread: t.id, fix: `add "${t.id}": {"status": "addressed|answered|declined|needs_input", "reply": "..."}` });
    }
    for (const [tid, r] of Object.entries(replies)) {
      if (r.status !== 'addressed' || (threadLinks[tid] ?? []).length) continue;
      const t = threads.find((x) => x.id === tid);
      if (t?.suggestion?.status === 'staged') continue;
      const file = t ? anchorAt(t, headV)?.file?.path : null;
      warnings.push({ code: 'addressed', message: `${tid} is addressed but no change of this round is linked to it`, thread: tid, fix: `add "at": "${file ?? 'src/a.js'}:L12-14" (lines of the file now)` });
    }
  }
  for (const u of unusedOther) warnings.push({ code: 'other', message: `other "${u.at}" (${u.why}): ${u.reason}` });
  for (const b of badHints) warnings.push({ code: 'hint', message: `${b.thread} at "${b.at}": ${b.reason}`, thread: b.thread });
  return { refused: false, forced: false, errors: [], warnings, brokenLocks: [], intactLocks: [], unexplained, rewriteRatio: 0 };
}

/**
 * The anchor states a dry run would record (stepFor on every thread, nothing written).
 * @param {any} prep
 * @param {number} newV
 */
function predictAnchors(prep, newV) {
  const counts = { threads: 0, locks: 0, exact: 0, moved: 0, edited: 0, changed: 0, orphaned: 0 };
  for (const t of prep.threads) {
    const prev = anchorAt(t, prep.head.v);
    if (!prev) continue;
    const next = prep.stepFor(t, prev, prep.attribution.threadLinks[t.id] ?? [], { linked: false, override: null, toVersion: newV });
    counts.threads += 1;
    const st = /** @type {keyof typeof counts} */ (next.state);
    if (st in counts) counts[st] += 1;
  }
  return counts;
}

/**
 * The round report (design 4.8).
 * @param {any} r
 * @param {{ H: CodeManifest, N: CodeManifest, head: any, filesChanged: number, baseLabel: string }} info
 * @returns {string}
 */
function roundText(r, { H, N, filesChanged, baseLabel }) {
  const out = [];
  const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const what = `round ${r.version}: ${plural(filesChanged, 'file')} changed, +${r.stats.added} -${r.stats.removed}, ${plural(r.stats.hunks, 'hunk')}`;
  const responds = r.respondsTo ? ` · responds to ${r.respondsTo}` : '';
  out.push(r.dryRun ? `specreview: dry run - would record v${r.version} for ${r.doc} (${what})${responds}; nothing recorded` : `specreview: recorded v${r.version} for ${r.doc} (${what})${responds}`);
  const status = new Map(r.replies.map((/** @type {any} */ x) => [x.thread, x.status]));
  const rows = r.hunks.map((/** @type {any} */ h) => {
    const where = h.newRange ? `L${h.newRange[0]}${h.newRange[1] !== h.newRange[0] ? `-${h.newRange[1]}` : ''}` : `del L${h.oldRange?.[0] ?? '?'}${h.oldRange && h.oldRange[1] !== h.oldRange[0] ? `-${h.oldRange[1]}` : ''}`;
    let target;
    if (h.threads.length) {
      const ts = h.threads.map((/** @type {string} */ t) => (status.get(t) ? `${t} ${status.get(t)}` : t)).join(', ');
      target = `-> ${ts}${h.linkedBy ? `  (${h.linkedBy}${h.via ? `: ${h.via}` : ''})` : ''}${h.other ? `  [other: ${oneLine(h.other, 80)}]` : ''}`;
    } else if (h.other != null) target = `-> other: ${oneLine(h.other, 120)}`;
    else target = '-> (no thread)';
    return { a: h.id, b: where, c: target };
  });
  const wa = Math.max(0, ...rows.map((/** @type {any} */ x) => x.a.length));
  const wb = Math.max(0, ...rows.map((/** @type {any} */ x) => x.b.length));
  for (const x of rows) out.push(`  ${x.a.padEnd(wa)}  ${x.b.padEnd(wb)}  ${x.c}`);
  const linked = new Set(r.hunks.flatMap((/** @type {any} */ h) => h.threads));
  for (const rep of r.replies) if (!linked.has(rep.thread)) out.push(`  ${rep.thread} ${rep.status} (reply only)`);
  const notes = r.guards.warnings;
  if (!notes.length) out.push('guards: code profile · ok');
  else if (notes.length === 1) out.push(`guards: code profile · ok (1 note: ${notes[0].message})`);
  else {
    out.push(`guards: code profile · ok (${notes.length} notes)`);
    for (const w of notes) out.push(`  note: ${w.message}`);
  }
  if (r.anchors) {
    const a = r.anchors;
    out.push(`anchors: ${plural(a.threads, 'thread')} -> ${a.exact} exact, ${a.moved} moved, ${a.edited} edited, ${a.changed} changed, ${a.orphaned} orphaned`);
  }
  const moved = N.baseMoved ? `moved from ${short(N.baseMoved.from)}` : 'unchanged';
  const delta = N.files.length - H.files.length;
  const skipped = N.skipped?.length ? ` · skipped: ${skippedText(N.skipped)}` : '';
  out.push(`base: ${baseLabel} (${moved}) · files in review: ${N.files.length}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}${skipped}`);
  if (r.git?.commit) out.push(`git: committed ${String(r.git.commit).slice(0, 12)}`);
  if (!r.dryRun) out.push(`reviewer notified. next: run \`specreview wait ${r.ref}\` in the background`);
  return `${out.join('\n')}\n`;
}

/**
 * @param {string} s
 * @param {number} max
 */
function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

